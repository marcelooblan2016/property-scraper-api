const { Stagehand } = require("@browserbasehq/stagehand");
const { chromium }  = require("playwright-core");
const dotenv        = require('dotenv');
const _             = require('lodash');
const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const helper        = require("../../helpers/generalHelper.js");
const { uploadToS3 } = require('../../helpers/s3Uploader.js');

dotenv.config();

class PropertyScraper {

    constructor({ query, standalone = false, onComplete, onError, logger }) {
        this.query      = query;
        this.standalone = standalone; // true = CLI (can process.exit), false = Express (must not)
        this.onComplete = onComplete || (async () => {});
        this.onError    = onError    || (async () => {});
        this.logger     = logger     || null;

        const OPENAI_API_KEY    = process.env.SAM_SCRAPER_OPENAI_API_KEY;
        const OPENAI_MODEL      = process.env.SAM_SCRAPER_OPENAI_MODEL;
        const ANTHROPIC_API_KEY = process.env.SAM_SCRAPER_ANTHROPIC_API_KEY;
        const ANTHROPIC_MODEL   = process.env.SAM_SCRAPER_ANTHROPIC_MODEL;

        const useAnthropic = !!ANTHROPIC_API_KEY && !!ANTHROPIC_MODEL;

        process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
        process.env.OPENAI_API_KEY    = OPENAI_API_KEY;

        this.stagehand = new Stagehand({
            env:           "LOCAL",
            verbose:       1,
            enableCaching: true,
            model: useAnthropic
                ? `anthropic/${ANTHROPIC_MODEL}`
                : `openai/${OPENAI_MODEL}`,
            localBrowserLaunchOptions: {
                headless:        true,
                acceptDownloads: true,
                downloadsPath:   path.resolve('./downloads'),
            },
        });

        this.page             = null;
        this.pwContext        = null;
        this.helper           = new helper();
        this.retriesParameter = [];
    }

    async _ensurePageReady() {
        console.log('[debug] stagehand keys:', Object.keys(this.stagehand));
        console.log('[debug] context type:', typeof this.stagehand.context);
        console.log('[debug] context keys:', Object.keys(this.stagehand.context ?? {}));
        console.log('[debug] context proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(this.stagehand.context ?? {})));

        this.page = this.stagehand.context.pages()[0];
        if (!this.page) throw new Error('No page found');
        console.log('[debug] page ready, url:', this.page.url());
    }

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

        const isValid = rule.fields.every(hasValue);
        if (!isValid) return false;

        this.mdFileSuffix = rule.suffix;
        return true;
    }

    async startNow() {
        let county = _.get(this.query, 'county', 'unknown');
        county = String(county).trim().replace(/\s+/g, '_').toUpperCase();
        let state = _.get(this.query, "state", "unknown");

        let fileRetries = `./dataset/${state}/RETRIES.json`;
        if (fs.existsSync(fileRetries)) {
            let retriesParameterContent = fs.readFileSync(fileRetries, 'utf8');
            this.retriesParameter = JSON.parse(retriesParameterContent);
        } else {
            this.retriesParameter = ['book-page'];
        }

        await this.stagehand.init();

        for (let retriesParameterIndex in this.retriesParameter) {

            let mdFilesPrepared = await this.prepareMdFiles(retriesParameterIndex);
            if (mdFilesPrepared === false) {
                console.info(`skipping ${this.currentRetry}`);
                continue;
            }

            let fileMarkdown      = `./dataset/${state}/${county}${this.mdFileSuffix}.md`;
            let validListCounties = `./dataset/${state}/counties.txt`;

            if (fs.existsSync(validListCounties)) {
                let validListContents   = await fs.promises.readFile(validListCounties, 'utf8');
                let validListCollection = validListContents.split('\n').filter(line => line.trim() !== '');

                if (validListCollection.includes(county)) {
                    console.info(county, "is a valid county. Proceeding with scraping...");
                    fileMarkdown = `./dataset/${state}/DEFAULT${this.mdFileSuffix}.md`;
                }
            }

            console.info(`Current Markdown: ${fileMarkdown}`);

            if (!fs.existsSync(fileMarkdown)) {
                console.info(`Markdown doesn't exist: ${fileMarkdown}`);
                continue;
            }

            let contents = await fs.promises.readFile(fileMarkdown, 'utf8');
            let actions  = contents.split('\n').filter(line => line.trim() !== '');

            console.log('[stagehand] active model:', this.stagehand.modelName);
            console.log('[stagehand] llm client model:', this.stagehand.llmClient?.modelName);

            await this._ensurePageReady();
            await this.executeActions(actions);

            try {
                await this.page.waitForTimeout(2000);
                const isFileDownloaded = await this.isFileDownloaded();
                if (isFileDownloaded === true) {
                    const filePath = `./downloads/${_.get(this.query, 'propertyId')}/deed.pdf`;
                    const s3Result = await this.uploadAndCleanup();
                    await this.onComplete({ filePath, ...s3Result });
                    await this.closeProcess();
                    return;
                }
            } catch {
                // Page may have closed after download
            }

            await this.page.waitForTimeout(2000);
        }

        // All retries exhausted without a successful download
        await this.onError({ error: 'All retries exhausted — file not downloaded' });
        await this.closeProcess();
    }

    async closeProcess() {
        await this.stagehand?.close().catch(() => {});
        if (this.standalone) process.exit(0);
    }

    async isFileDownloaded() {
        let propertyId     = _.get(this.query, 'propertyId', null);
        const filePathDeed = `./downloads/${propertyId}/deed.pdf`;
        if (fs.existsSync(filePathDeed) === true) {
            console.info(`File downloaded: ${filePathDeed}`);
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
            console.error('[s3] upload failed:', err.message);
            return { s3Key: null, s3Url: null };
        }
    }

    // ── logging helper ────────────────────────────────────────────────────────
    _log(type, message) {
        if (this.logger) {
            this.logger[type]?.(message);
        }
    }

    // ── human-readable action message ─────────────────────────────────────────
    _actionMessage(target, verb, payload) {
        const t = target.toLowerCase();
        const v = verb.toLowerCase();

        if (t === 'page') {
            if (v === 'goto')            return `Navigating to ${payload}`;
            if (v === 'waitfor')         return `Waiting ${payload}ms`;
            if (v === 'clickselector')   return `Clicking selector: ${payload}`;
            if (v === 'clickimgbutton')  return `Clicking image button: ${payload || 'first'}`;
            if (v === 'clickrowelement') return `Clicking row element: ${payload}`;
            if (v === 'downloadiframesrc') return `Downloading document PDF`;
            if (v === 'press')           return `Pressing key: ${payload}`;
            if (v === 'execute')         return `Executing script`;
            if (v === 'spaclick')        return `Clicking (SPA): ${payload}`;
            if (v === 'waitforselector') return `Waiting for element: ${payload}`;
        }
        if (t === 'stagehand') {
            if (v === 'act')             return `AI action: ${payload}`;
            if (v === 'observe')         return `AI observe: ${payload}`;
            if (v === 'handoff')         return `Waiting for human: ${payload}`;
            if (v === 'snapshot')        return `Taking screenshot`;
            if (v === 'waitforurl')      return `Waiting for URL: ${payload}`;
            if (v === 'switchtonewpage') return `Switching to new tab`;
            if (v === 'catchpdfurl')     return `Watching for PDF URL`;
            if (v === 'downloadcaughtpdf') return `Downloading caught PDF`;
            if (v === 'clickdownload')   return `Downloading from new tab`;
        }
        if (t === 'human') {
            if (v === 'pause')   return `Paused: ${payload}`;
            if (v === 'prompt')  return `Prompting user: ${payload}`;
            if (v === 'confirm') return `Confirming: ${payload}`;
        }

        return `${target}[${verb}]: ${payload}`;
    }

    async executeActions(actions = []) {
        if (!this.page) await this._ensurePageReady();

        const stateNames = this.helper.stateNames();
        this.query.stateName  = stateNames[this.query.state] || this.query.state;
        this.query.countyName = this.helper.formatCountyName(this.query.county, this.query.state);

        const parts = [
            _.get(this.query, 'ownerLastName', ''),
            _.get(this.query, 'ownerFirstName', ''),
        ].map(p => String(p || '').trim().replace(/^[,]+|[,]+$/g, '')).filter(Boolean);
        this.query.lastFirstName = parts.join(', ');
        this.query.lastFirstName = String(this.query.lastFirstName || '').replace(/^[,\s]+|[,\s]+$/g, '');

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

        const resolvedActions = [];
        const conditionStack  = [];
        let conditionActive   = true;

        for (const raw of actions) {
            const line = String(raw).trim();
            if (!line) continue;

            const ifMatch = line.match(/^\[if\s+(.+)\]$/i);
            if (ifMatch) {
                const condition = ifMatch[1].trim();
                let result = false;
                try {
                    const evalFn = new Function('query', `return !!(${condition})`);
                    result = evalFn(this.query);
                } catch (e) {
                    console.warn('[conditional] eval error:', e.message);
                }
                conditionStack.push({ met: result, inElse: false });
                conditionActive = conditionStack.every(c => c.inElse ? !c.met : c.met);
                console.log(`[conditional] [if ${condition}] => ${result}, active: ${conditionActive}`);
                continue;
            }

            if (line.match(/^\[else\]$/i)) {
                if (conditionStack.length > 0) {
                    conditionStack[conditionStack.length - 1].inElse = true;
                    conditionActive = conditionStack.every(c => c.inElse ? !c.met : c.met);
                    console.log(`[conditional] [else] active: ${conditionActive}`);
                }
                continue;
            }

            if (line.match(/^\[endif\]$/i)) {
                conditionStack.pop();
                conditionActive = conditionStack.length === 0 || conditionStack.every(c => c.inElse ? !c.met : c.met);
                console.log(`[conditional] [endif] active: ${conditionActive}`);
                continue;
            }

            if (conditionActive) resolvedActions.push(raw);
        }

        for (const raw of resolvedActions) {
            let line = String(raw).trim();
            line = this.helper.replaceVariables(line, this.query);
            console.info('[debug-xx] executing action:', line);

            const m = line.match(/^\[(\w+)\]\[(\w+)\]\s*(.*)$/);
            if (!m) continue;

            const [, target, verb, rest] = m;
            const payload = rest.trim();
            const verbKey = verb.toLowerCase();

            // Log the action
            this._log('action', this._actionMessage(target, verb, payload));

            try {
                if (target.toLowerCase() === 'page') {

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
                        console.log('[debug] clicking selector:', payload);
                        await this.page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            if (!el) throw new Error('Element not found: ' + sel);
                            el.click();
                        }, payload);
                    }
                    else if (verbKey === 'clickimgbutton') {
                        const searchTerms = payload ? payload.split('&&').map(s => s.trim()) : [];
                        const useLatest   = searchTerms.includes('latest');
                        const terms       = searchTerms.filter(s => s !== 'latest');
                        console.log('[debug] clickimgbutton terms:', terms, 'useLatest:', useLatest);

                        const result = await this.page.evaluate((terms, useLatest) => {
                            const inputs = document.querySelectorAll('input[value="IMG"]');
                            if (inputs.length === 0) return { success: false, reason: 'No IMG button found' };
                            if (terms.length === 0 && !useLatest) { inputs[0].click(); return { success: true, fallback: true }; }
                            const candidates = [];
                            for (const input of inputs) {
                                let parent = input.parentElement, depth = 0;
                                while (parent && depth < 10) {
                                    const allMatch = terms.length === 0 || terms.every(term => parent.textContent.includes(term));
                                    if (allMatch) { candidates.push({ input, row: parent }); break; }
                                    parent = parent.parentElement; depth++;
                                }
                            }
                            if (candidates.length === 0) { inputs[0].click(); return { success: true, fallback: true }; }
                            if (!useLatest || candidates.length === 1) { candidates[0].input.click(); return { success: true, count: candidates.length }; }
                            let latestCandidate = null, latestDate = null;
                            for (const candidate of candidates) {
                                const dateMatches = candidate.row.textContent.match(/\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM))?/g);
                                if (dateMatches) {
                                    for (const dateStr of dateMatches) {
                                        const d = new Date(dateStr);
                                        if (!isNaN(d) && (!latestDate || d > latestDate)) { latestDate = d; latestCandidate = candidate; }
                                    }
                                }
                            }
                            if (latestCandidate) { latestCandidate.input.click(); return { success: true, latestDate: latestDate.toISOString(), count: candidates.length }; }
                            candidates[0].input.click();
                            return { success: true, fallback: true, count: candidates.length };
                        }, terms, useLatest);

                        console.log('[debug] clickimgbutton result:', result);
                        if (!result.success) throw new Error(result.reason);
                    }
                    else if (verbKey === 'waitfornavigation') {
                        const ms = parseInt(payload) || 3000;
                        await new Promise(r => setTimeout(r, ms));
                        const pages = this.stagehand.context.pages();
                        this.page   = pages[pages.length - 1];
                        console.log('[debug] re-acquired page, url:', this.page.url());
                    }
                    else if (verbKey === 'downloadiframesrc') {
                        const pdfInfo = await this.page.evaluate(() => {
                            const hidUrl = document.querySelector('input[name="hid_URL"]');
                            if (hidUrl && hidUrl.value) return { url: hidUrl.value, source: 'hid_URL' };
                            const docIdField = document.querySelector('input[name="hid_DocID"]');
                            if (docIdField && docIdField.value) return {
                                url: `/DS/DocumentSearch/DocumentImageView?doc_id=${docIdField.value}&sup_page=`,
                                source: 'hid_DocID',
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
                        console.log('[debug] pdf source:', pdfInfo.source, '| url:', pdfInfo.url);
                        const pageOrigin   = await this.page.evaluate(() => window.location.origin);
                        const pdfUrl       = pdfInfo.url.startsWith('http') ? pdfInfo.url : `${pageOrigin}${pdfInfo.url}`;
                        const cookies      = await this.stagehand.context.cookies();
                        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                        const response     = await fetch(pdfUrl, { headers: { 'Cookie': cookieHeader } });
                        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
                        const buffer = Buffer.from(await response.arrayBuffer());
                        console.log('[debug] buffer size:', buffer.length, 'bytes');
                        const dir = path.dirname(payload);
                        await fs.promises.mkdir(dir, { recursive: true });
                        await fs.promises.writeFile(path.resolve(payload), buffer);
                        console.log('[download] saved to:', path.resolve(payload));
                    }
                    else if (verbKey === 'clickinsideframe') {
                        const [frameIdentifier, selector] = payload.split('|').map(s => s.trim());
                        const browser   = await chromium.connectOverCDP({ wsEndpoint: this.stagehand.connectURL() });
                        const pwContext = browser.contexts()[0];
                        const pwPage    = pwContext.pages()[0];
                        const allFrames = pwPage.frames();
                        console.log('[debug] all frames:', allFrames.map(f => `${f.name()}:${f.url().substring(0, 80)}`));
                        let targetFrame = null;
                        for (const frame of allFrames) {
                            if (frame.name() === frameIdentifier || frame.url().includes(frameIdentifier)) { targetFrame = frame; break; }
                        }
                        if (!targetFrame) throw new Error(`Frame not found: ${frameIdentifier}`);
                        const tryClick = async (frame, sel) => {
                            try {
                                const el = await frame.$(sel);
                                if (el) { await el.click(); console.log('[debug] clicked', sel, 'in frame:', frame.url().substring(0, 80)); return true; }
                            } catch (e) { console.log('[debug] failed in frame:', e.message); }
                            for (const child of frame.childFrames()) { if (await tryClick(child, sel)) return true; }
                            return false;
                        };
                        const clicked = await tryClick(targetFrame, selector);
                        if (!clicked) throw new Error(`Selector "${selector}" not found in frame "${frameIdentifier}" or its children`);
                    }
                    else if (verbKey === 'debugframe') {
                        const browser   = await chromium.connectOverCDP({ wsEndpoint: this.stagehand.connectURL() });
                        const pwContext = browser.contexts()[0];
                        const pwPage    = pwContext.pages()[0];
                        console.log('[debug] all frames:');
                        for (const frame of pwPage.frames()) {
                            console.log(' -', frame.name(), ':', frame.url());
                            const html = await frame.evaluate(() => {
                                const inputs = document.querySelectorAll('input[type="checkbox"]');
                                if (inputs.length > 0) return Array.from(inputs).map(i => `id:${i.id} | name:${i.name} | value:${i.value} | checked:${i.checked}`).join('\n');
                                return 'NO CHECKBOXES FOUND - body snippet: ' + document.body.innerHTML.substring(2000, 4000);
                            });
                            console.log('[debug] frame content:', html);
                        }
                        for (const frame of pwPage.frames()) {
                            if (frame.name() === payload || frame.url().includes(payload)) {
                                const html = await frame.evaluate(() => document.body.innerHTML.substring(0, 3000));
                                console.log('[debug] frame url:', frame.url());
                                console.log('[debug] frame html:', html);
                                return;
                            }
                        }
                        console.log('[debug] frame not found:', payload);
                    }
                    else if (verbKey === 'waitforframe') {
                        const [frameName, urlFragment] = payload.split('|').map(s => s.trim());
                        const browser   = await chromium.connectOverCDP({ wsEndpoint: this.stagehand.connectURL() });
                        const pwContext = browser.contexts()[0];
                        const pwPage    = pwContext.pages()[0];
                        const start     = Date.now();
                        while (Date.now() - start < 15000) {
                            for (const frame of pwPage.frames()) {
                                if ((frame.name() === frameName || frame.url().includes(frameName)) && frame.url().includes(urlFragment)) {
                                    console.log('[debug] frame ready:', frame.url()); return;
                                }
                            }
                            await new Promise(r => setTimeout(r, 500));
                        }
                        throw new Error(`Frame "${frameName}" never navigated to "${urlFragment}"`);
                    }
                    else if (verbKey === 'clickrowelement') {
                        const parts       = payload.split('|').map(s => s.trim());
                        const selector    = parts.pop();
                        const rawTerms    = parts[0].split('&&').map(s => s.trim());
                        const useLatest   = rawTerms.includes('latest');
                        const searchTerms = rawTerms.filter(s => s !== 'latest');
                        console.log('[debug] clickrowelement terms:', searchTerms, 'latest:', useLatest, 'selector:', selector);

                        const result = await this.page.evaluate((searchTerms, selector, useLatest) => {
                            const findInDoc = (doc) => {
                                const candidates = [];
                                for (const el of doc.querySelectorAll(selector)) {
                                    let parent = el.parentElement, depth = 0;
                                    while (parent && depth < 10) {
                                        if (searchTerms.every(term => parent.textContent.includes(term))) { candidates.push({ el, row: parent }); break; }
                                        parent = parent.parentElement; depth++;
                                    }
                                }
                                return candidates;
                            };
                            let candidates = findInDoc(document);
                            const searchFrames = (win) => {
                                if (candidates.length > 0) return;
                                try {
                                    for (let i = 0; i < win.frames.length; i++) {
                                        try {
                                            const frameDoc = win.frames[i].document;
                                            if (frameDoc) { const found = findInDoc(frameDoc); if (found.length > 0) { candidates = found; return; } searchFrames(win.frames[i]); }
                                        } catch { }
                                    }
                                } catch { }
                            };
                            if (candidates.length === 0) searchFrames(window);
                            if (candidates.length === 0) return { success: false, reason: 'No row found' };
                            if (!useLatest || candidates.length === 1) { candidates[0].el.click(); return { success: true, count: candidates.length }; }
                            let latest = null, latestDate = null;
                            for (const c of candidates) {
                                const dates = c.row.textContent.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);
                                if (dates) for (const d of dates) { const parsed = new Date(d); if (!isNaN(parsed) && (!latestDate || parsed > latestDate)) { latestDate = parsed; latest = c; } }
                            }
                            if (latest) { latest.el.click(); return { success: true }; }
                            candidates[0].el.click();
                            return { success: true, fallback: true };
                        }, searchTerms, selector, useLatest);

                        console.log('[debug] clickrowelement result:', result);
                        if (!result.success) throw new Error(result.reason || `No row found for: ${searchTerms}`);
                    }
                    else if (verbKey === 'clicklinkbyrowtext') {
                        const parts       = payload.split('|').map(s => s.trim());
                        const frameName   = parts[1] || null;
                        const searchTerms = parts[0].split('&&').map(s => s.trim());
                        const browser     = await chromium.connectOverCDP({ wsEndpoint: this.stagehand.connectURL() });
                        const pwContext   = browser.contexts()[0];
                        const pwPage      = pwContext.pages()[0];
                        let targetFrames  = pwPage.frames();
                        if (frameName) targetFrames = targetFrames.filter(f => f.name() === frameName || f.url().includes(frameName));
                        let clicked = false;
                        for (const frame of targetFrames) {
                            if (frame.url() === 'about:blank') continue;
                            try {
                                const result = await frame.evaluate((searchTerms) => {
                                    for (const row of document.querySelectorAll('tr')) {
                                        if (searchTerms.every(term => row.textContent.includes(term))) {
                                            const link = row.querySelector('a');
                                            if (link) { link.click(); return { success: true, href: link.href }; }
                                        }
                                    }
                                    return { success: false };
                                }, searchTerms);
                                if (result.success) { console.log('[debug] clicked link in frame:', frame.url()); clicked = true; break; }
                            } catch (e) { console.log('[debug] frame error:', e.message); }
                        }
                        if (!clicked) throw new Error(`Link not found for terms: ${searchTerms}`);
                    }
                    else if (verbKey === 'executeinsideframe') {
                        const [frameName, ...codeParts] = payload.split('|').map(s => s.trim());
                        const code      = codeParts.join('|');
                        const browser   = await chromium.connectOverCDP({ wsEndpoint: this.stagehand.connectURL() });
                        const pwContext = browser.contexts()[0];
                        const pwPage    = pwContext.pages()[0];
                        let found = false;
                        for (const frame of pwPage.frames()) {
                            if (frame.name() === frameName || frame.url().includes(frameName)) {
                                found = true;
                                const result = await frame.evaluate((code) => {
                                    try { eval(code); return { success: true }; }
                                    catch (e) { return { success: false, error: e.message }; }
                                }, code);
                                console.log('[debug] executeinsideframe result:', result);
                                break;
                            }
                        }
                        if (!found) throw new Error(`Frame not found: ${frameName}`);
                    }
                }
                else if (target.toLowerCase() === 'stagehand') {

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
                    else if (verbKey === 'waitfordownload') {
                        this.downloadDir       = path.resolve('./downloads');
                        this.systemDownloadDir = path.join(os.homedir(), 'Downloads');
                        await fs.promises.mkdir(this.downloadDir, { recursive: true });
                        this.preDownloadFiles       = new Set(await fs.promises.readdir(this.downloadDir));
                        this.preSystemDownloadFiles = new Set(await fs.promises.readdir(this.systemDownloadDir));
                        this.lastNewTabUrl = null;
                        this.lastNewTab    = null;
                        console.log('[debug] watching for download or new tab...');
                    }
                    else if (verbKey === 'triggerdownload') {
                        try {
                            const filePath = await new Promise((resolve, reject) => {
                                const timeout = setTimeout(() => { clearInterval(pollInterval); reject(new Error('Download timeout')); }, 60000);
                                const pollInterval = setInterval(async () => {
                                    try {
                                        if (this.lastNewTabUrl) {
                                            const pdfUrl = this.lastNewTabUrl;
                                            this.lastNewTabUrl = null;
                                            clearInterval(pollInterval); clearTimeout(timeout);
                                            const cookies      = await this.pwContext.cookies();
                                            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                                            const response     = await fetch(pdfUrl, { headers: { 'Cookie': cookieHeader } });
                                            if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
                                            const buffer = Buffer.from(await response.arrayBuffer());
                                            const dir    = path.dirname(payload);
                                            await fs.promises.mkdir(dir, { recursive: true });
                                            await fs.promises.writeFile(path.resolve(payload), buffer);
                                            if (this.lastNewTab) { await this.lastNewTab.close().catch(() => {}); this.lastNewTab = null; }
                                            return resolve(path.resolve(payload));
                                        }
                                        for (const [dir, pre] of [
                                            [this.downloadDir, this.preDownloadFiles],
                                            [this.systemDownloadDir, this.preSystemDownloadFiles],
                                        ]) {
                                            const files    = await fs.promises.readdir(dir);
                                            const newFiles = files.filter(f => !pre.has(f) && !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                                            if (newFiles.length > 0) { clearInterval(pollInterval); clearTimeout(timeout); return resolve(path.join(dir, newFiles[0])); }
                                        }
                                    } catch (e) { console.error('[debug] poll error:', e); }
                                }, 500);
                            });
                            if (filePath !== path.resolve(payload)) {
                                let targetPath  = path.resolve(payload);
                                const sourceExt = path.extname(filePath);
                                if (!path.extname(targetPath) && sourceExt) targetPath = targetPath + sourceExt;
                                const dir = path.dirname(payload);
                                await fs.promises.mkdir(dir, { recursive: true });
                                await fs.promises.copyFile(filePath, targetPath);
                                await fs.promises.unlink(filePath);
                                console.log('[download] saved to:', targetPath);
                            }
                        } catch (err) { console.error('triggerdownload failed:', err); }
                    }
                    else if (verbKey === 'clickdownload') {
                        if (!this.currentNewTab) throw new Error('No new tab — did you call switchtonewpage first?');
                        const pdfUrl       = this.currentNewTabUrl;
                        const cookies      = await this.stagehand.context.cookies();
                        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                        const response     = await fetch(pdfUrl, { headers: { 'Cookie': cookieHeader } });
                        if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
                        const buffer = Buffer.from(await response.arrayBuffer());
                        const dir    = path.dirname(payload);
                        await fs.promises.mkdir(dir, { recursive: true });
                        await fs.promises.writeFile(path.resolve(payload), buffer);
                        await this.currentNewTab.close().catch(() => {});
                        this.currentNewTab = null; this.currentNewTabUrl = null;
                        console.log('[download] saved to:', path.resolve(payload));
                    }
                    else if (verbKey === 'catchpdfurl') {
                        const browser   = await chromium.connectOverCDP({ wsEndpoint: this.stagehand.connectURL() });
                        const pwContext = browser.contexts()[0];
                        const pwPage    = pwContext.pages()[0];
                        this.pdfUrlPromise = new Promise((resolve) => {
                            const handler = async (response) => {
                                const url         = response.url();
                                const contentType = response.headers()['content-type'] || '';
                                if (url.startsWith('chrome-extension://') || url.startsWith('chrome://') || url.startsWith('data:') || url.startsWith('blob:')) return;
                                const isPdf = (
                                    contentType.includes('application/pdf') ||
                                    contentType.includes('application/x-file-download') ||
                                    contentType.includes('image/tiff') ||
                                    contentType.includes('image/tif') ||
                                    (contentType.includes('octet-stream') && url.startsWith('http')) ||
                                    (url.startsWith('http') && (
                                        url.includes('.pdf') || url.includes('.tif') ||
                                        url.includes('GetImage') || url.includes('GetDocumentImage') ||
                                        url.includes('downloadImages') ||
                                        (url.includes('DocumentImage') && !url.includes('DocumentImageView') && !url.includes('DocumentImageVtu')) ||
                                        url.includes('ImageDelivery') || url.includes('printHelper') || url.includes('.ashx')
                                    ))
                                );
                                if (isPdf) { console.log('[debug] caught pdf url:', url); pwPage.off('response', handler); resolve({ url, pwContext }); }
                            };
                            pwPage.on('response', handler);
                        });
                    }
                    else if (verbKey === 'downloadcaughtpdf') {
                        const { url: pdfUrl, pwContext } = await Promise.race([
                            this.pdfUrlPromise,
                            new Promise((_, reject) => setTimeout(() => reject(new Error('PDF URL catch timeout')), 30000)),
                        ]);
                        const cookies      = await pwContext.cookies();
                        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                        const response     = await fetch(pdfUrl, { headers: { 'Cookie': cookieHeader } });
                        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
                        const buffer = Buffer.from(await response.arrayBuffer());
                        const dir    = path.dirname(payload);
                        await fs.promises.mkdir(dir, { recursive: true });
                        await fs.promises.writeFile(path.resolve(payload), buffer);
                        this.pdfUrlPromise = null;
                        console.log('[download] saved to:', path.resolve(payload));
                    }
                    else if (verbKey === 'downloadfromhiddenurl') {
                        await new Promise(r => setTimeout(r, 2000));
                        const pages       = this.stagehand.context.pages();
                        const currentPage = pages[pages.length - 1];
                        this.page = currentPage;
                        const pdfInfo = await currentPage.evaluate(() => {
                            const hidUrl = document.querySelector('input[name="hid_URL"]');
                            if (hidUrl?.value) return { url: hidUrl.value, source: 'hid_URL' };
                            const docId = document.querySelector('input[name="hid_DocID"]');
                            if (docId?.value) return { url: `/DS/DocumentSearch/DocumentImageView?doc_id=${docId.value}&sup_page=`, source: 'hid_DocID' };
                            return null;
                        });
                        if (!pdfInfo) throw new Error('No hidden URL or DocID found');
                        const pageOrigin   = await currentPage.evaluate(() => window.location.origin);
                        const pdfUrl       = pdfInfo.url.startsWith('http') ? pdfInfo.url : `${pageOrigin}${pdfInfo.url}`;
                        const cookies      = await this.stagehand.context.cookies();
                        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                        const response     = await fetch(pdfUrl, { headers: { 'Cookie': cookieHeader } });
                        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
                        const buffer = Buffer.from(await response.arrayBuffer());
                        const dir    = path.dirname(payload);
                        await fs.promises.mkdir(dir, { recursive: true });
                        await fs.promises.writeFile(path.resolve(payload), buffer);
                        console.log('[download] saved to:', path.resolve(payload));
                    }
                }
            } catch (err) {
                console.error('Action failed:', raw, err);
                this.logger?.internal(line, 'error', err.message);
                try { await this.page.waitForTimeout(200); } catch { /* page closed */ }
                continue;
            }

            // Only reaches here if no error was thrown
            this.logger?.internal(line, 'ok');

            try { await this.page.waitForTimeout(200); } catch { /* page closed */ }
        }
    }
}

module.exports = PropertyScraper;