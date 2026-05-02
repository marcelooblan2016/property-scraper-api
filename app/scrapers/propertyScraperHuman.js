/**
 * propertyScraperHuman.js — Type 2: Steel.dev + Human-in-the-loop
 *
 * Differences from type1 (propertyScraper.js):
 *  - Uses Steel.dev cloud browser (steel-sdk) instead of local Chromium
 *  - Stagehand connects to Steel session via CDP (env: LOCAL + cdpUrl)
 *  - Session timeout: 2 hours (Steel default is 5 min — too short for human interaction)
 *  - Session viewer (debugUrl) is publicly embeddable — no Steel login required
 *  - Accepts { onHandoff, onComplete, onError, onSessionReady, onTakeoverSignal }
 *    callbacks from jobRunner.js so Express controls the job lifecycle
 *
 * .md verbs (all type1 verbs + these new ones):
 *
 *  [stagehand][handoff] <message>
 *      Bot pauses here. Calls onHandoff({ message }) — job status → "waiting".
 *      Resumes when Laravel calls POST /jobs/:id/resume.
 *
 *  [stagehand][snapshot]
 *      Saves a screenshot to ./snapshots/<timestamp>.png
 *
 *  [stagehand][waitforurl] <fragment>
 *      Polls until page URL contains the fragment (max 60s)
 *
 *  [human][pause] <message>
 *      Cloud: no-op log (no terminal). Keep for local dev compatibility.
 *
 *  [human][prompt] <key> | <question>
 *      Cloud: reads value from query.<key> if pre-supplied by Laravel.
 *
 *  [human][confirm] <question>
 *      Cloud: checks query.confirmOverrides[question], defaults to true.
 */

'use strict';

const { Stagehand }  = require('@browserbasehq/stagehand');
const Steel          = require('steel-sdk').default;
const Browserbase    = require('@browserbasehq/sdk').default;
const dotenv         = require('dotenv');
const _              = require('lodash');
const fs             = require('fs');
const path           = require('path');
const helper         = require('../../helpers/generalHelper.js');
const { uploadToS3 } = require('../../helpers/s3Uploader');

dotenv.config();

class PropertyScraperHuman {

    /**
     * @param {object}   options
     * @param {object}   options.query             — scraper query params (same as type1)
     * @param {function} options.onHandoff         — async ({ message }) => void
     * @param {function} options.onComplete        — async ({ filePath, s3Key, s3Url }) => void
     * @param {function} options.onError           — async ({ error: string }) => void
     * @param {function} options.onSessionReady    — async ({ liveViewUrl, sessionId }) => void
     * @param {function} options.onTakeoverSignal  — fn(callback) — registers takeover listener
     *
     * query fields specific to type2:
     * @param {string|Array} options.query.cookies      — site cookies to inject (optional)
     * @param {string}       options.query.cookieDomain — domain for cookie injection (optional)
     * @param {object}       options.query.confirmOverrides — map of confirm questions → bool
     */
    constructor({ query, onHandoff, onComplete, onError, onTakeoverSignal, onSessionReady, logger, jobId, onStatusUpdate }) {
        this.query             = query;
        this._jobId            = jobId || null;
        this.onHandoff         = onHandoff        || (async () => {});
        this.onComplete        = onComplete       || (async () => {});
        this.onError           = onError          || (async () => {});
        this.onSessionReady    = onSessionReady   || (async () => {}); // fired once Steel session is live — sets liveViewUrl on the job
        this.onTakeoverSignal  = onTakeoverSignal || null;
        this.onStatusUpdate    = onStatusUpdate   || null;
        this.logger            = logger           || null;

        const ANTHROPIC_API_KEY = process.env.SAM_SCRAPER_ANTHROPIC_API_KEY;
        const ANTHROPIC_MODEL   = process.env.SAM_SCRAPER_ANTHROPIC_MODEL;
        const OPENAI_API_KEY    = process.env.SAM_SCRAPER_OPENAI_API_KEY;
        const OPENAI_MODEL      = process.env.SAM_SCRAPER_OPENAI_MODEL;

        const useAnthropic = !!ANTHROPIC_API_KEY && !!ANTHROPIC_MODEL;
        process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
        process.env.OPENAI_API_KEY    = OPENAI_API_KEY;

        // ── Cloud browser provider ────────────────────────────────────────────
        // Controlled via CLOUD_BROWSER env var or query.cloudBrowser per-job.
        // Options:
        //   'steel'       (default) — Steel.dev cloud browser
        //   'browserbase'           — Browserbase cloud browser
        //   'novnc'                 — Real Chrome on DO droplet via CDP
        //   'extension'             — User's real Chrome via Chrome Extension CDP bridge
        //                            Human installs extension, bot controls their browser
        //                            Bypasses Cloudflare — real Chrome, real IP, real fingerprint
        this.provider = (
            _.get(this.query, 'cloudBrowser') ||
            process.env.CLOUD_BROWSER ||
            'steel'
        ).toLowerCase();

        console.log(`[human] cloud browser provider: ${this.provider}`);

        // Steel client
        this.steel        = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });
        this.steelSession = null;

        // Stagehand — initialised in startNow() after session is created
        this._stagehandModel = useAnthropic
            ? `anthropic/${ANTHROPIC_MODEL}`
            : `openai/${OPENAI_MODEL}`;

        this.stagehand = null;

        this.page              = null;
        this.helper            = new helper();
        this.abortActions      = false;
        this.takeoverRequested = false;
    }

    // ── Live view URL — provider-aware ────────────────────────────────────────
    async getLiveViewUrl() {
        if (this.provider === 'browserbase') {
            const sessionId = this.stagehand?.browserbaseSessionID;
            if (!sessionId) return null;
            try {
                const bb    = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
                const debug = await bb.sessions.debug(sessionId);
                return debug.debuggerFullscreenUrl || null;
            } catch (err) {
                console.error('[human] failed to get Browserbase live view url:', err.message);
                return null;
            }
        }

        if (this.provider === 'extension') {
            // User sees their own real Chrome — no separate live view URL needed
            return null;
        }

        // Steel — debugUrl with interactive=true is publicly embeddable
        const debugUrl = this.steelSession?.debugUrl;
        if (!debugUrl) return null;
        return `${debugUrl}?interactive=true&showControls=true`;
    }

    // ── Build Steel sessionContext from query.cookies ─────────────────────────
    // query.cookies can be:
    //   A) Array of cookie objects (Playwright/Steel format):
    //      [{ name, value, domain, path, ... }, ...]
    //   B) Raw document.cookie string:
    //      "cookie1=value1; cookie2=value2"
    //   C) Base64-encoded document.cookie string (recommended for cookies with
    //      special characters like quotes in JSESSIONID):
    //      btoa("cookie1=value1; cookie2=value2")
    //   D) Not provided — returns null (fresh session, no cookies injected)
    _buildSessionContext() {
        let raw = _.get(this.query, 'cookies', null);
        if (!raw) return null;

        // Decode base64 if needed — safe way to pass cookies with special chars
        if (typeof raw === 'string') {
            try {
                const decoded = Buffer.from(raw, 'base64').toString('utf8');
                // Only use decoded if it looks like a cookie string (contains = )
                if (decoded.includes('=')) {
                    console.log('[human] cookies decoded from base64');
                    raw = decoded;
                }
            } catch { /* not base64 — use as-is */ }
        }

        let cookies = [];

        if (Array.isArray(raw)) {
            // Already in correct format
            cookies = raw;
        } else if (typeof raw === 'string' && raw.trim()) {
            const domain = _.get(this.query, 'cookieDomain', null);
            cookies = raw.split(';')
                .map(c => c.trim())
                .filter(Boolean)
                .map(c => {
                    const eqIdx = c.indexOf('=');
                    if (eqIdx === -1) return null;
                    return {
                        name:   c.slice(0, eqIdx).trim(),
                        // Strip surrounding quotes Steel doesn't expect
                        value:  c.slice(eqIdx + 1).trim().replace(/^"|"$/g, ''),
                        domain: domain || '',
                        path:   '/',
                    };
                })
                .filter(Boolean);
        }

        if (!cookies.length) return null;

        console.log(`[human] injecting ${cookies.length} cookies into Steel session`);
        cookies.forEach(c => console.log(`[human]   ${c.name}=${c.value.substring(0, 20)}...`));
        return { cookies };
    }

    async _ensurePageReady() {
        this.page = this.stagehand.context.pages()[0];
        if (!this.page) throw new Error('No page found');
        console.log('[human] page ready:', this.page.url());
    }

    // ── .md file resolution ───────────────────────────────────────────────────
    // Type2 has no retry loop — the human is watching, so we just resolve
    // the correct .md file once and run it top to bottom.
    resolveMdFile(county, state) {
        // County-specific file takes priority: dataset/OH/BUTLER.md
        let fileMarkdown = `./dataset/${state}/${county}.md`;

        // Fall back to DEFAULT.md if county-specific file doesn't exist
        if (!fs.existsSync(fileMarkdown)) {
            fileMarkdown = `./dataset/${state}/DEFAULT.md`;
        }

        return fileMarkdown;
    }

    async startNow() {
        let county = String(_.get(this.query, 'county', 'unknown'))
            .trim().replace(/\s+/g, '_').toUpperCase();
        let state  = _.get(this.query, 'state', 'unknown');

        // ── 1. Create cloud browser session ──────────────────────────────────
        const sessionContext = this._buildSessionContext();

        if (this.provider === 'browserbase') {
            // ── Browserbase ───────────────────────────────────────────────────
            this.stagehand = new Stagehand({
                env:           'BROWSERBASE',
                verbose:       1,
                enableCaching: true,
                model:         this._stagehandModel,
                apiKey:        process.env.BROWSERBASE_API_KEY,
                projectId:     process.env.BROWSERBASE_PROJECT_ID,
                browserbaseSessionCreateParams: {
                    projectId: process.env.BROWSERBASE_PROJECT_ID,
                    keepAlive: true,
                },
            });
            await this.stagehand.init();
            console.log(`[human] Browserbase session: ${this.stagehand.browserbaseSessionID}`);

        } else if (this.provider === 'extension') {
            // ── Chrome Extension CDP Bridge ───────────────────────────────────
            // User's real Chrome controlled via SAM Scraper Chrome Extension.
            // Uses high-level action commands — no Stagehand/CDP issues.
            const cdpBridge = require('../functions/cdpBridge');

            console.log(`[human] waiting for Chrome extension | job: ${this._jobId}`);
            this.logger?.info('Open the SAM Scraper Bridge extension → select this job → click Connect');

            // Set job status to waiting so extension popup shows it
            if (this.onStatusUpdate) {
                await this.onStatusUpdate('waiting');
            }

            // Wait for extension WebSocket to connect
            await cdpBridge.waitForExtension(this._jobId, 5 * 60 * 1000);
            console.log('[human] Chrome extension connected');
            this.logger?.info('Extension connected — bot is now controlling your browser');

            // Run MD file via ExtensionScraper (no Stagehand needed)
            const ExtensionScraper = require('./extensionScraper');
            const extScraper = new ExtensionScraper({
                query:          this.query,
                jobId:          this._jobId,
                onHandoff:      this.onHandoff,
                onComplete:     this.onComplete,
                onError:        this.onError,
                onStatusUpdate: this.onStatusUpdate,
                logger:         this.logger,
            });
            await extScraper.run();
            await this.closeProcess();
            return; // ExtensionScraper handles its own completion

        } else {
            // ── Steel (default) ───────────────────────────────────────────────
            this.steelSession = await this.steel.sessions.create({
                useProxy:     _.get(this.query, 'steelUseProxy',     true),
                solveCaptcha: _.get(this.query, 'steelSolveCaptcha', true),
                timeout:      1 * 60 * 60 * 1000, // 1 hour
                ...(sessionContext ? { sessionContext } : {}),
            });
            console.log(`[human] Steel session created: ${this.steelSession.id}`);
            this.logger?.info(`Steel session created: ${this.steelSession.id}`);

            this.stagehand = new Stagehand({
                env:           'LOCAL',
                verbose:       1,
                enableCaching: true,
                model:         this._stagehandModel,
                localBrowserLaunchOptions: {
                    cdpUrl: `${this.steelSession.websocketUrl}&apiKey=${process.env.STEEL_API_KEY}`,
                },
            });
            await this.stagehand.init();
        }

        // ── 2. Inject Chrome headers (both providers) ─────────────────────────
        const userAgent = _.get(this.query, 'userAgent',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        const page = this.stagehand.context.pages()[0];
        if (page) {
            await page.setExtraHTTPHeaders({
                'user-agent':                userAgent,
                'sec-ch-ua':                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                'sec-ch-ua-mobile':          '?0',
                'sec-ch-ua-platform':        '"macOS"',
                'sec-fetch-dest':            'document',
                'sec-fetch-mode':            'navigate',
                'sec-fetch-site':            'none',
                'sec-fetch-user':            '?1',
                'accept-language':           'en-US,en;q=0.9',
                'accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'upgrade-insecure-requests': '1',
            });
            await this.stagehand.context.setExtraHTTPHeaders({
                'user-agent': userAgent,
            });
            console.log('[human] Chrome headers injected');
        }

        // ── 3. Broadcast live URL ─────────────────────────────────────────────
        const liveViewUrl = await this.getLiveViewUrl();
        const sessionId   = this.provider === 'browserbase'
            ? this.stagehand?.browserbaseSessionID
            : this.steelSession?.id;
        if (liveViewUrl) {
            console.log(`[human] session live view: ${liveViewUrl}`);
            await this.onSessionReady({ liveViewUrl, sessionId });
        }

        // ── 4. Listen for takeover signal ─────────────────────────────────────
        // When Laravel calls POST /jobs/:id/takeover, the emitter fires 'takeover'
        // which sets takeoverRequested = true. The executeActions loop checks this
        // flag between actions and pauses (same as [stagehand][handoff]).
        if (this.onTakeoverSignal) {
            this.onTakeoverSignal(() => {
                console.log('[human] takeover requested — will pause after current action');
                this.takeoverRequested = true;
            });
        }

        const fileMarkdown = this.resolveMdFile(county, state);
        console.info(`[human] markdown: ${fileMarkdown}`);

        if (!fs.existsSync(fileMarkdown)) {
            const error = `Markdown not found: ${fileMarkdown}`;
            console.error(`[human] ${error}`);
            await this.onError({ error });
            await this.closeProcess();
            return;
        }

        const contents = await fs.promises.readFile(fileMarkdown, 'utf8');
        const actions  = contents.split('\n').filter(l => l.trim());

        await this._ensurePageReady();
        await this.executeActions(actions);

        try {
            await this.page.waitForTimeout(2000);
            const downloaded = await this.isFileDownloaded();
            if (downloaded) {
                const filePath = `./downloads/${_.get(this.query, 'propertyId')}/deed.pdf`;
                const s3Result = await this.uploadAndCleanup();
                await this.onComplete({ filePath, ...s3Result });
                await this.closeProcess();
                return;
            }
        } catch { /* page may have closed */ }

        // Actions completed — no file downloaded (may be intentional for human-only flows)
        await this.onComplete({ filePath: null, s3Key: null, s3Url: null });
        await this.closeProcess();
    }

    async closeProcess() {
        await this.stagehand?.close().catch(() => {});

        if (this.provider === 'browserbase') {
            const sessionId = this.stagehand?.browserbaseSessionID;
            if (sessionId) {
                try {
                    const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
                    await bb.sessions.stop(sessionId);
                    console.log(`[human] Browserbase session stopped: ${sessionId}`);
                } catch (err) {
                    console.error('[human] failed to stop Browserbase session:', err.message);
                }
            }
        } else if (this.provider === 'extension') {
            // Extension — close the bridge, extension detaches from the tab
            const cdpBridge = require('../functions/cdpBridge');
            cdpBridge.closeJob(this._jobId);
            console.log('[human] extension bridge closed');
        } else {
            // Steel
            if (this.steelSession?.id) {
                try {
                    await this.steel.sessions.release(this.steelSession.id);
                    console.log(`[human] Steel session released: ${this.steelSession.id}`);
                } catch (err) {
                    console.error('[human] failed to release Steel session:', err.message);
                }
            }
        }
    }

    async isFileDownloaded() {
        const propertyId   = _.get(this.query, 'propertyId', null);
        const filePathDeed = `./downloads/${propertyId}/deed.pdf`;
        if (fs.existsSync(filePathDeed)) {
            console.info(`[human] downloaded: ${filePathDeed}`);
            return true;
        }
        return false;
    }

    async uploadAndCleanup() {
        const propertyId = _.get(this.query, 'propertyId', null);
        const localPath  = `./downloads/${propertyId}/deed.pdf`;
        try {
            const { s3Key, s3Url } = await uploadToS3({ localPath, propertyId });
            console.info(`[s3] deed uploaded | key: ${s3Key}`);
            console.info(`[s3] url: ${s3Url}`);
            return { s3Key, s3Url };
        } catch (err) {
            // S3 upload failure should not block completion — log and continue
            console.error('[s3] upload failed:', err.message);
            return { s3Key: null, s3Url: null };
        }
    }

    // ── action runner ─────────────────────────────────────────────────────────
    // ── human-readable action message ─────────────────────────────────────────
    _actionMessage(target, verb, payload) {
        const t = target.toLowerCase();
        const v = verb.toLowerCase();
        if (t === 'page') {
            if (v === 'goto')              return `Navigating to ${payload}`;
            if (v === 'waitfor')           return `Waiting ${payload}ms`;
            if (v === 'clickselector')     return `Clicking selector: ${payload}`;
            if (v === 'spaclick')          return `Clicking (SPA): ${payload}`;
            if (v === 'waitforselector')   return `Waiting for element: ${payload}`;
            if (v === 'downloadiframesrc') return `Downloading document PDF`;
            if (v === 'press')             return `Pressing key: ${payload}`;
        }
        if (t === 'stagehand') {
            if (v === 'act')               return `AI action: ${payload}`;
            if (v === 'observe')           return `AI observe: ${payload}`;
            if (v === 'snapshot')          return `Taking screenshot`;
            if (v === 'waitforurl')        return `Waiting for URL: ${payload}`;
            if (v === 'handoff')           return `Waiting for human: ${payload}`;
        }
        if (t === 'human') {
            if (v === 'pause')             return `Paused: ${payload}`;
            if (v === 'prompt')            return `Prompting: ${payload}`;
            if (v === 'confirm')           return `Confirming: ${payload}`;
        }
        return `${target}[${verb}]: ${payload}`;
    }

    async executeActions(actions = []) {
        if (!this.page) await this._ensurePageReady();

        // Prepare query vars (identical to type1)
        const stateNames = this.helper.stateNames();
        this.query.stateName  = stateNames[this.query.state] || this.query.state;
        this.query.countyName = this.helper.formatCountyName(this.query.county, this.query.state);

        const nameParts = [
            _.get(this.query, 'ownerLastName', ''),
            _.get(this.query, 'ownerFirstName', ''),
        ].map(p => String(p || '').trim().replace(/^[,]+|[,]+$/g, '')).filter(Boolean);
        this.query.lastFirstName = nameParts.join(', ').replace(/^[,\s]+|[,\s]+$/g, '');

        const businessIndicators = this.helper.businessIndicators();
        const upperName = (this.query.ownerLastName || '').toUpperCase();
        this.query.isBusinessName = businessIndicators.some(indicator => {
            const escaped = indicator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = indicator.length <= 4
                ? new RegExp(`(?<![\\S])${escaped}(?![\\S])`)
                : new RegExp(`\\b${escaped}\\b`);
            return regex.test(upperName);
        }) ? 'true' : 'false';

        if (this.query.apn) {
            this.query.apn = this.query.apn.replace(/^["']|["']$/g, '');
        }

        // ── conditional pre-pass (identical to type1) ─────────────────────────
        const resolvedActions = [];
        const conditionStack  = [];
        let conditionActive   = true;

        for (const raw of actions) {
            const line = String(raw).trim();
            if (!line || line.startsWith('#')) continue;

            const ifMatch = line.match(/^\[if\s+(.+)\]$/i);
            if (ifMatch) {
                let result = false;
                try { result = new Function('query', `return !!(${ifMatch[1].trim()})`)(this.query); }
                catch (e) { console.warn('[conditional] eval error:', e.message); }
                conditionStack.push({ met: result, inElse: false });
                conditionActive = conditionStack.every(c => c.inElse ? !c.met : c.met);
                continue;
            }
            if (line.match(/^\[else\]$/i)) {
                if (conditionStack.length) {
                    conditionStack[conditionStack.length - 1].inElse = true;
                    conditionActive = conditionStack.every(c => c.inElse ? !c.met : c.met);
                }
                continue;
            }
            if (line.match(/^\[endif\]$/i)) {
                conditionStack.pop();
                conditionActive = !conditionStack.length || conditionStack.every(c => c.inElse ? !c.met : c.met);
                continue;
            }
            if (conditionActive) resolvedActions.push(raw);
        }

        // ── execute ───────────────────────────────────────────────────────────
        for (const raw of resolvedActions) {

            if (this.abortActions) {
                console.info('[human] actions aborted');
                break;
            }

            // ── takeover check ────────────────────────────────────────────────
            // Human requested control mid-run — pause here same as [stagehand][handoff]
            if (this.takeoverRequested) {
                this.takeoverRequested = false;
                console.log('[human] takeover — pausing bot');
                await this.onHandoff({
                    message: 'You requested control. Click Resume when you are done.',
                });
                console.log('[human] takeover — resumed, continuing actions');
                const pages = this.stagehand.context.pages();
                this.page = pages[pages.length - 1];
            }

            let line = this.helper.replaceVariables(String(raw).trim(), this.query);
            console.info('[human] action:', line);

            const m = line.match(/^\[(\w+)\]\[(\w+)\]\s*(.*)$/);
            if (!m) continue;

            const [, target, verb, rest] = m;
            const payload = rest.trim();
            const t = target.toLowerCase();

            // Log the action
            if (this.logger) {
                const v = verb.toLowerCase();
                if (t === 'stagehand' && v === 'handoff') {
                    this.logger.handoff(`Waiting for human: ${payload}`);
                } else {
                    this.logger.action(this._actionMessage(target, verb, payload));
                }
            }
            const v = verb.toLowerCase();

            try {

                // ── HUMAN VERBS ───────────────────────────────────────────────
                if (t === 'human') {

                    // [human][pause] message
                    // Cloud: no-op log only
                    if (v === 'pause') {
                        console.log(`[human][pause] ${payload}`);
                    }

                        // [human][prompt] queryKey | Question
                    // Cloud: value must be pre-supplied in query by Laravel
                    else if (v === 'prompt') {
                        const [key] = payload.split('|').map(s => s.trim());
                        const existing = _.get(this.query, key);
                        if (existing == null || String(existing).trim() === '') {
                            console.warn(`[human][prompt] "${key}" not pre-supplied in query — skipping`);
                        } else {
                            console.log(`[human][prompt] using pre-supplied ${key}="${existing}"`);
                        }
                    }

                        // [human][confirm] question
                    // Cloud: checks query.confirmOverrides[question], defaults true
                    else if (v === 'confirm') {
                        const overrides = this.query.confirmOverrides || {};
                        if (overrides[payload] === false) {
                            console.info(`[human][confirm] override=false for "${payload}" — aborting`);
                            this.abortActions = true;
                        } else {
                            console.log(`[human][confirm] "${payload}" → continuing`);
                        }
                    }
                }

                // ── STAGEHAND HUMAN VERBS ─────────────────────────────────────
                else if (t === 'stagehand') {

                    // [stagehand][handoff] message
                    // Calls onHandoff → Express sets job to "waiting", returns
                    // liveViewUrl to Laravel. Suspends until resume signal arrives.
                    if (v === 'handoff') {
                        const message = payload || 'Complete the required steps, then click Resume in the app.';

                        console.log(`[human][handoff] suspending`);
                        await this.onHandoff({ message });
                        console.log('[human][handoff] resumed');

                        // Re-acquire page after human interaction
                        const pages = this.stagehand.context.pages();
                        this.page = pages[pages.length - 1];
                        this.query.currentUrl = this.page.url();
                        console.log('[human][handoff] current url:', this.page.url());
                    }

                    // [stagehand][snapshot]
                    else if (v === 'snapshot') {
                        const dir = './snapshots';
                        await fs.promises.mkdir(dir, { recursive: true });
                        const filepath = path.resolve(dir, `snapshot-${Date.now()}.png`);
                        await this.page.screenshot({ path: filepath, fullPage: false });
                        console.log(`[snapshot] saved: ${filepath}`);
                    }

                    // [stagehand][waitforurl] fragment
                    else if (v === 'waitforurl') {
                        const start   = Date.now();
                        const timeout = 60_000;
                        console.log(`[waitforurl] waiting for: "${payload}"`);
                        while (Date.now() - start < timeout) {
                            if (this.page.url().includes(payload)) {
                                console.log('[waitforurl] matched:', this.page.url());
                                break;
                            }
                            await this.page.waitForTimeout(500);
                        }
                    }

                    // All type1 stagehand verbs
                    else {
                        await this._runStagehandVerb(v, payload);
                    }
                }

                // ── PAGE VERBS (type1 identical) ──────────────────────────────
                else if (t === 'page') {
                    await this._runPageVerb(v, payload);
                }

            } catch (err) {
                console.error('[human] action failed:', raw, err.message);
                this.logger?.internal(line, 'error', err.message);
                try { await this.page.waitForTimeout(200); } catch { /* page closed */ }
                continue;
            }

            // Only reaches here if no error was thrown
            this.logger?.internal(line, 'ok');

            try { await this.page.waitForTimeout(200); } catch { /* page closed */ }
        }
    }

    // ── type1 stagehand verbs ─────────────────────────────────────────────────
    // Paste remaining verbs from propertyScraper.js here, or extract both
    // classes into a shared BasePropertyScraper.
    async _runStagehandVerb(verbKey, payload) {
        if (verbKey === 'act') {
            await this.stagehand.act(payload);
        }
        else if (verbKey === 'observe') {
            await this.stagehand.observe(payload);
        }
        else if (verbKey === 'switchtonewpage') {
            let newTab = null;
            const start = Date.now();
            while (Date.now() - start < 10000) {
                const allPages = this.stagehand.context.pages();
                if (allPages.length > 1) { newTab = allPages[allPages.length - 1]; break; }
                await new Promise(r => setTimeout(r, 500));
            }
            if (!newTab) throw new Error('No new tab found');
            await newTab.waitForLoadState('load').catch(() => {});
            this.currentNewTab          = newTab;
            this.currentNewTabUrl       = newTab.url();
            this.query.currentNewTabUrl = newTab.url();
        }
        else if (verbKey === 'clickdownload') {
            if (!this.currentNewTab) throw new Error('No new tab — call switchtonewpage first');
            const cookies = await this.stagehand.context.cookies();
            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            const response = await fetch(this.currentNewTabUrl, { headers: { 'Cookie': cookieHeader } });
            if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const dir = path.dirname(payload);
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(path.resolve(payload), buffer);
            await this.currentNewTab.close().catch(() => {});
            this.currentNewTab = null;
            console.log('[download] saved to:', path.resolve(payload));
        }
    }

    // ── type1 page verbs ──────────────────────────────────────────────────────
    async _runPageVerb(verbKey, payload) {
        if (verbKey === 'goto') {
            const url = payload.match(/(https?:\/\/\S+)/)?.[1] || payload.split(/\s+/)[0];
            await this.page.goto(url, { waitUntil: 'load' });
        }
        else if (verbKey === 'execute') {
            await this.page.evaluate(payload);
        }
        else if (verbKey === 'press') {
            await this.page.keyboard.press(payload);
        }
        else if (verbKey === 'waitfor') {
            const ms = parseInt(payload);
            if (!isNaN(ms)) await this.page.waitForTimeout(ms);
        }
        else if (verbKey === 'clickselector') {
            await this.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) throw new Error('Element not found: ' + sel);
                el.click();
            }, payload);
        }
            // [page][spaclick] <selector>
            // Reliable click for SPAs — tries 4 strategies in order:
            //   1. Playwright locator .click() — handles scroll-into-view + wait
            //   2. dispatchEvent with bubbling mousedown/mouseup/click
            //   3. Pointer events (pointerdown/pointerup/click)
            //   4. Direct .click() on the element
        // Use this when [stagehand][act] or [page][clickselector] don't work.
        else if (verbKey === 'spaclick') {
            const selector = payload;
            console.log('[spaclick] attempting:', selector);

            // Strategy 1: Playwright native click (scroll into view, wait for stable)
            try {
                const locator = this.page.locator(selector).first();
                await locator.waitFor({ state: 'visible', timeout: 5000 });
                await locator.click({ force: true, timeout: 5000 });
                console.log('[spaclick] strategy 1 (playwright) succeeded');
            } catch (e1) {
                console.log('[spaclick] strategy 1 failed:', e1.message);

                // Strategy 2: dispatch full mouse event sequence with bubbling
                const s2 = await this.page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return { ok: false, reason: 'element not found' };
                    const rect = el.getBoundingClientRect();
                    const cx   = rect.left + rect.width  / 2;
                    const cy   = rect.top  + rect.height / 2;
                    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
                    el.dispatchEvent(new MouseEvent('mousedown', opts));
                    el.dispatchEvent(new MouseEvent('mouseup',   opts));
                    el.dispatchEvent(new MouseEvent('click',     opts));
                    return { ok: true };
                }, selector);

                if (s2.ok) {
                    console.log('[spaclick] strategy 2 (mouse events) succeeded');
                } else {
                    console.log('[spaclick] strategy 2 failed:', s2.reason);

                    // Strategy 3: pointer events (React/Vue often use these)
                    const s3 = await this.page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        if (!el) return { ok: false };
                        const rect = el.getBoundingClientRect();
                        const cx   = rect.left + rect.width  / 2;
                        const cy   = rect.top  + rect.height / 2;
                        const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
                        el.dispatchEvent(new PointerEvent('pointerdown', opts));
                        el.dispatchEvent(new PointerEvent('pointerup',   opts));
                        el.dispatchEvent(new MouseEvent('click',         opts));
                        return { ok: true };
                    }, selector);

                    if (s3.ok) {
                        console.log('[spaclick] strategy 3 (pointer events) succeeded');
                    } else {
                        // Strategy 4: direct .click() fallback
                        await this.page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            if (!el) throw new Error('Element not found: ' + sel);
                            el.click();
                        }, selector);
                        console.log('[spaclick] strategy 4 (direct click) succeeded');
                    }
                }
            }
        }
        else if (verbKey === 'waitfornavigation') {
            const ms = parseInt(payload) || 3000;
            await new Promise(r => setTimeout(r, ms));
            const pages = this.stagehand.context.pages();
            this.page = pages[pages.length - 1];
        }
            // [page][waitforselector] <selector>
        // Wait until a selector is visible — useful after SPA route changes
        else if (verbKey === 'waitforselector') {
            await this.page.locator(payload).first().waitFor({ state: 'visible', timeout: 30000 });
            console.log('[waitforSelector] visible:', payload);
        }
            // [page][scrollintoview] <selector>
        // Scroll element into view — some SPAs only render rows when visible
        else if (verbKey === 'scrollintoview') {
            await this.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, payload);
            await this.page.waitForTimeout(500);
        }
        else if (verbKey === 'downloadiframesrc') {
            const pdfInfo = await this.page.evaluate(() => {
                const hidUrl = document.querySelector('input[name="hid_URL"]');
                if (hidUrl?.value) return { url: hidUrl.value, source: 'hid_URL' };
                const docId = document.querySelector('input[name="hid_DocID"]');
                if (docId?.value) return {
                    url: `/DS/DocumentSearch/DocumentImageView?doc_id=${docId.value}&sup_page=`,
                    source: 'hid_DocID'
                };
                const iframes = document.querySelectorAll('iframe');
                for (const iframe of iframes) {
                    const src = iframe.src || iframe.getAttribute('src');
                    if (src && (
                        src.includes('GetDocumentImage') ||
                        src.includes('DocumentImageView') ||
                        src.includes('.ashx') ||
                        src.includes('.pdf')
                    ) && !src.includes('DocumentImageVtu')) {
                        return { url: src, source: 'iframe' };
                    }
                }
                return null;
            });
            if (!pdfInfo) throw new Error('No document URL found');
            const pageOrigin = await this.page.evaluate(() => window.location.origin);
            const pdfUrl = pdfInfo.url.startsWith('http')
                ? pdfInfo.url
                : `${pageOrigin}${pdfInfo.url}`;
            const cookies = await this.stagehand.context.cookies();
            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            const response = await fetch(pdfUrl, { headers: { 'Cookie': cookieHeader } });
            if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const dir = path.dirname(payload);
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(path.resolve(payload), buffer);
            console.log('[download] saved to:', path.resolve(payload));
        }
    }
}

module.exports = PropertyScraperHuman;