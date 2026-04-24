/**
 * propertyScraperHuman.js — Type 2: Browserbase + Human-in-the-loop
 *
 * Differences from type1 (propertyScraper.js):
 *  - Always uses Browserbase (env: BROWSERBASE)
 *  - keepAlive: true — session persists during human interaction
 *  - Accepts { onHandoff, onComplete, onError } callbacks from server.js
 *    so Express controls the resume signal, not a local HTTP server
 *
 * .md verbs (all type1 verbs + these new ones):
 *
 *  [stagehand][handoff] <message>
 *      Calls onHandoff({ liveViewUrl, message }) and suspends until
 *      Express receives POST /jobs/:id/resume from Laravel.
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

const { Stagehand } = require('@browserbasehq/stagehand');
const dotenv        = require('dotenv');
const _             = require('lodash');
const fs            = require('fs');
const path          = require('path');
const helper        = require('../../helper.js');

dotenv.config();

class PropertyScraperHuman {

    /**
     * @param {object}   options
     * @param {object}   options.query        — scraper query params (same as type1)
     * @param {function} options.onHandoff    — async ({ liveViewUrl, message }) => void
     * @param {function} options.onComplete   — async ({ filePath }) => void
     * @param {function} options.onError      — async ({ error: string }) => void
     */
    constructor({ query, onHandoff, onComplete, onError }) {
        this.query      = query;
        this.onHandoff  = onHandoff  || (async () => {});
        this.onComplete = onComplete || (async () => {});
        this.onError    = onError    || (async () => {});

        const ANTHROPIC_API_KEY = process.env.SAM_SCRAPER_ANTHROPIC_API_KEY;
        const ANTHROPIC_MODEL   = process.env.SAM_SCRAPER_ANTHROPIC_MODEL;
        const OPENAI_API_KEY    = process.env.SAM_SCRAPER_OPENAI_API_KEY;
        const OPENAI_MODEL      = process.env.SAM_SCRAPER_OPENAI_MODEL;

        const useAnthropic = !!ANTHROPIC_API_KEY && !!ANTHROPIC_MODEL;
        process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
        process.env.OPENAI_API_KEY    = OPENAI_API_KEY;

        this.stagehand = new Stagehand({
            env:           'BROWSERBASE',
            verbose:       1,
            enableCaching: true,
            model: useAnthropic
                ? `anthropic/${ANTHROPIC_MODEL}`
                : `openai/${OPENAI_MODEL}`,
            apiKey:    process.env.BROWSERBASE_API_KEY,
            projectId: process.env.BROWSERBASE_PROJECT_ID,
            browserbaseSessionCreateParams: {
                projectId: process.env.BROWSERBASE_PROJECT_ID,
                keepAlive: true,   // session stays alive while human interacts
            },
        });

        this.page             = null;
        this.helper           = new helper();
        this.abortActions     = false;
        this.retriesParameter = [];
    }

    // ── Browserbase live view URL ─────────────────────────────────────────────
    getLiveViewUrl() {
        const sessionId = this.stagehand.browserbaseSessionID;
        if (!sessionId) return null;
        return `https://www.browserbase.com/sessions/${sessionId}`;
    }

    async _ensurePageReady() {
        this.page = this.stagehand.context.pages()[0];
        if (!this.page) throw new Error('No page found');
        console.log('[human] page ready:', this.page.url());
    }

    // ── .md file resolution (identical to type1) ──────────────────────────────
    async prepareMdFiles(index) {
        this.currentRetry = this.retriesParameter[index];
        this.mdFileSuffix = '';

        const rules = {
            'book-page':       { fields: ['book', 'page'],       suffix: '' },
            'lot-subdivision': { fields: ['lot', 'subdivision'], suffix: '-lot-subdivision' },
            'block-lot':       { fields: ['block', 'lot'],       suffix: '-block-lot' },
            'lot':             { fields: ['lot'],                suffix: '-lot' },
            'township':        { fields: ['township'],           suffix: '-township' },
            'apn':             { fields: ['apn'],                suffix: '-apn' },
            'last-recorded':   { fields: ['lastRecorded'],       suffix: '-last-recorded' },
        };

        const rule = rules[this.currentRetry];
        if (!rule) return false;

        const hasValue = (key) => {
            const value = _.get(this.query, key);
            if (value == null) return false;
            if (typeof value === 'string') return value.trim() !== '';
            return true;
        };

        if (!rule.fields.every(hasValue)) return false;
        this.mdFileSuffix = rule.suffix;
        return true;
    }

    async startNow() {
        let county = String(_.get(this.query, 'county', 'unknown'))
            .trim().replace(/\s+/g, '_').toUpperCase();
        let state  = _.get(this.query, 'state', 'unknown');

        const fileRetries = `./dataset/${state}/RETRIES.json`;
        this.retriesParameter = fs.existsSync(fileRetries)
            ? JSON.parse(fs.readFileSync(fileRetries, 'utf8'))
            : ['book-page'];

        await this.stagehand.init();

        for (let i in this.retriesParameter) {

            if (!(await this.prepareMdFiles(i))) {
                console.info(`[human] skipping ${this.currentRetry}`);
                continue;
            }

            let fileMarkdown = `./dataset/${state}/${county}${this.mdFileSuffix}.md`;
            const validListPath = `./dataset/${state}/counties.txt`;

            if (fs.existsSync(validListPath)) {
                const validList = (await fs.promises.readFile(validListPath, 'utf8'))
                    .split('\n').filter(l => l.trim());
                if (validList.includes(county)) {
                    fileMarkdown = `./dataset/${state}/DEFAULT${this.mdFileSuffix}.md`;
                }
            }

            console.info(`[human] markdown: ${fileMarkdown}`);
            if (!fs.existsSync(fileMarkdown)) {
                console.info(`[human] markdown not found, skipping`);
                continue;
            }

            const contents = await fs.promises.readFile(fileMarkdown, 'utf8');
            const actions  = contents.split('\n').filter(l => l.trim());

            await this._ensurePageReady();
            await this.executeActions(actions);

            this.abortActions = false;

            try {
                await this.page.waitForTimeout(2000);
                const downloaded = await this.isFileDownloaded();
                if (downloaded) {
                    const filePath = `./downloads/${_.get(this.query, 'propertyId')}/deed.pdf`;
                    await this.onComplete({ filePath });
                    await this.closeProcess();
                    return;
                }
            } catch { /* page may have closed */ }

            await this.page.waitForTimeout(2000);
        }

        await this.closeProcess();
    }

    async closeProcess() {
        await this.stagehand?.close().catch(() => {});
        // Note: do NOT call process.exit() — server.js manages the process lifecycle
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

    // ── action runner ─────────────────────────────────────────────────────────
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

            let line = this.helper.replaceVariables(String(raw).trim(), this.query);
            console.info('[human] action:', line);

            const m = line.match(/^\[(\w+)\]\[(\w+)\]\s*(.*)$/);
            if (!m) continue;

            const [, target, verb, rest] = m;
            const payload = rest.trim();
            const t = target.toLowerCase();
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
                        const message     = payload || 'Complete the required steps, then click Resume in the app.';
                        const liveViewUrl = this.getLiveViewUrl();

                        console.log(`[human][handoff] suspending. liveViewUrl: ${liveViewUrl}`);
                        await this.onHandoff({ liveViewUrl, message });
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
            }

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
        else if (verbKey === 'waitfornavigation') {
            const ms = parseInt(payload) || 3000;
            await new Promise(r => setTimeout(r, ms));
            const pages = this.stagehand.context.pages();
            this.page = pages[pages.length - 1];
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