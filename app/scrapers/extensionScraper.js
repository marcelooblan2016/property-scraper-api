'use strict';

/**
 * app/scrapers/extensionScraper.js
 *
 * Executes .md action files using the Chrome Extension CDP Bridge.
 * Instead of Stagehand/Playwright, commands are sent to the user's
 * real Chrome via the extension — bypassing Cloudflare completely.
 *
 * Supports these .md verbs:
 *   [page][goto] <url>
 *   [page][waitfor] <ms>
 *   [page][clickselector] <selector>
 *   [page][evaluate] <js expression>
 *   [page][waitforurl] <fragment>
 *   [stagehand][handoff] <message>   ← pauses for human, shows in extension popup
 *   [stagehand][act] <instruction>   ← evaluates as JS via extension
 *
 * All other verbs are logged and skipped with a warning.
 */

const fs       = require('fs');
const path     = require('path');
const _        = require('lodash');
const cdpBridge = require('../functions/cdpBridge');
const helper         = require("../../helpers/generalHelper.js");
const { uploadToS3 } = require('../../helpers/s3Uploader.js');

class ExtensionScraper {

    constructor({ query, jobId, uuid, onHandoff, onComplete, onError, onStatusUpdate, logger }) {
        this.query          = query;
        this.jobId          = jobId;
        this.uuid           = uuid || null;
        this.onHandoff      = onHandoff      || (async () => {});
        this.onComplete     = onComplete     || (async () => {});
        this.onError        = onError        || (async () => {});
        this.onStatusUpdate = onStatusUpdate || (async () => {});
        this.logger         = logger         || null;
        this.helper         = new helper();
        this.abortActions   = false;
    }

    // ── Send command to extension ─────────────────────────────────────────────
    async cmd(action, params = {}, timeout = 30000) {
        return cdpBridge.sendCommand(this.jobId, action, params, timeout);
    }

    // ── Resolve .md file ──────────────────────────────────────────────────────
    resolveMdFile(county, state) {
        let countyFile = `./dataset/${state}/${county}.md`;
        let countyFileConfig = `./dataset/${state}/${county}.json`;
        if (!fs.existsSync(countyFile)) {
            countyFile = `./dataset/${state}/DEFAULT.md`;
            countyFileConfig = `./dataset/${state}/DEFAULT.json`;
        }
        return { mdFile: countyFile, mdFileConfig: countyFileConfig };
    }

    // ── Run ───────────────────────────────────────────────────────────────────
    async run() {
        const county = String(_.get(this.query, 'county', 'unknown'))
            .trim().replace(/\s+/g, '_').toUpperCase();
        const state  = _.get(this.query, 'state', 'unknown');

        // Pre-compute isBusinessName (same logic as propertyScraper)
        const businessIndicators = this.helper.businessIndicators?.() || [];
        const upperName = (this.query.ownerLastName || '').toUpperCase();
        this.query.isBusinessName = businessIndicators.some(indicator => {
            const escaped = indicator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex   = indicator.length <= 4
                ? new RegExp(`(?<![\\S])${escaped}(?![\\S])`)
                : new RegExp(`\\b${escaped}\\b`);
            return regex.test(upperName);
        }) ? 'true' : 'false';

        const { mdFile, mdFileConfig } = this.resolveMdFile(county, state);

        this.logger?.info(`Extension scraper | markdown: ${mdFile}`);
        if (!fs.existsSync(mdFile)) throw new Error(`Markdown not found: ${mdFile}`);

        // ── Optional config validation ─────────────────────────────────────────
        if (!fs.existsSync(mdFileConfig)) {
            throw new Error(`Config file missing: ${mdFileConfig} — create it with { "type": "bot-human" }`);
        }
        let noCaptchaDetection = false;
        try {
            const configData = JSON.parse(fs.readFileSync(mdFileConfig, 'utf8'));
            const configType = configData?.type;
            if (configType !== 'bot-human') {
                throw new Error(`Config type '${configType}' is not 'bot-human' — use bot scraper for this county`);
            }
            noCaptchaDetection = configData?.noCaptchaDetection === true;
            if (noCaptchaDetection) {
                this.logger?.info('CAPTCHA detection disabled for this county (noCaptchaDetection: true)');
            }
        } catch (e) {
            if (e.message.includes('bot-human') || e.message.includes('Config')) throw e;
            throw new Error(`Failed to parse ${mdFileConfig}: ${e.message}`);
        }
        this._noCaptchaDetection = noCaptchaDetection;

        const rawLines = fs.readFileSync(mdFile, 'utf8').split('\n');

        // ── Resolve conditionals (same logic as propertyScraper) ─────────────
        const actions        = [];
        const conditionStack = [];
        let   conditionActive = true;

        for (const raw of rawLines) {
            const line = String(raw).trim();
            if (!line || line.startsWith('#')) continue;

            // ── [if condition] ────────────────────────────────────────────────
            const ifMatch = line.match(/^\[if\s+(.+)\]$/i);
            if (ifMatch) {
                const condition = ifMatch[1].trim();
                let result = false;
                try {
                    result = new Function('query', `return !!(${condition})`)(this.query);
                } catch (e) { console.warn('[conditional] eval error:', e.message); }
                conditionStack.push({ met: result, inElse: false, elseMet: result });
                conditionActive = conditionStack.every(c => c.inElse ? !c.elseMet : c.met);
                continue;
            }

            // ── [elseif condition] ────────────────────────────────────────────
            const elseifMatch = line.match(/^\[elseif\s+(.+)\]$/i);
            if (elseifMatch) {
                if (conditionStack.length > 0) {
                    const top = conditionStack[conditionStack.length - 1];
                    // Only evaluate if no previous branch was taken
                    if (!top.elseMet) {
                        const condition = elseifMatch[1].trim();
                        let result = false;
                        try {
                            result = new Function('query', `return !!(${condition})`)(this.query);
                        } catch (e) { console.warn('[conditional] elseif eval error:', e.message); }
                        top.met      = result;
                        top.inElse   = true;
                        top.elseMet  = result;
                    } else {
                        top.met    = false;
                        top.inElse = true;
                    }
                    conditionActive = conditionStack.every(c => c.inElse ? c.met : c.met);
                }
                continue;
            }

            // ── [else] ────────────────────────────────────────────────────────
            if (line.match(/^\[else\]$/i)) {
                if (conditionStack.length > 0) {
                    const top = conditionStack[conditionStack.length - 1];
                    top.met    = !top.elseMet; // only true if no branch was taken yet
                    top.inElse = true;
                    conditionActive = conditionStack.every(c => c.met);
                }
                continue;
            }

            // ── [endif] ───────────────────────────────────────────────────────
            if (line.match(/^\[endif\]$/i)) {
                conditionStack.pop();
                conditionActive = conditionStack.length === 0
                    ? true
                    : conditionStack.every(c => c.met);
                continue;
            }

            if (conditionActive) actions.push(line);
        }

        // ── Execute ───────────────────────────────────────────────────────────
        for (const raw of actions) {
            if (this.abortActions) break;

            let line = this.helper.replaceVariables(String(raw).trim(), this.query);
            const m  = line.match(/^\[(\w+)\]\[([\w-]+)\]\s*(.*)$/);
            if (!m) continue;

            const [, target, verb, rest] = m;
            const t = target.toLowerCase();
            const v = verb.toLowerCase();

            // ── Extract [text="..."] comment if present ───────────────────────
            const textMatch  = rest.match(/\[text="([^"]+)"\]\s*$/);
            const comment    = textMatch ? textMatch[1] : null;
            const payload    = textMatch ? rest.slice(0, textMatch.index).trim() : rest.trim();
            const displayMsg = comment
                ? `[${t}][${v}] ${comment}`
                : this._actionMessage(t, v, payload);

            this.logger?.action(displayMsg);
            console.log(`[ext] action: [${t}][${v}] ${comment || payload}`);

            try {
                await this._executeVerb(t, v, payload);
                this.logger?.internal(line, 'ok');
            } catch (err) {
                console.error(`[ext] action failed: ${line}`, err.message);
                this.logger?.internal(line, 'error', err.message);
                this.logger?.error(`Action failed: ${err.message}`);

                // Stop MD execution and hand off to human
                this.logger?.handoff(`Action failed — human takeover needed: ${err.message}`);
                await this.cmd('notifyHandoff', { message: `Action failed on: [${t}][${v}] — ${err.message}` }).catch(() => {});
                await this.cmd('injectBanner', { title: 'Action Required', message: `Action failed: ${err.message}`, type: 'handoff' }).catch(() => {});
                await this.onHandoff({ message: `Action failed on: [${t}][${v}] ${payload} — ${err.message}. Please complete manually then click Resume.` });
                // Continue from next action after resume
            }
        }

        // Check if file downloaded
        const propertyId  = _.get(this.query, 'propertyId', null);
        const formattedId = propertyId ? `79-${propertyId}-47` : 'Unknown';
        const filePath    = `./downloads/${propertyId}/deed.pdf`;
        if (fs.existsSync(filePath)) {
            try {
                const { s3Key, s3Url } = await uploadToS3({ localPath: filePath, propertyId });
                await this.cmd('injectBanner', { title: 'Job Completed', message: `${formattedId} — deed PDF uploaded successfully.`, type: 'complete' }).catch(() => {});
                await this.onComplete({ filePath, s3Key, s3Url });
            } catch {
                await this.cmd('injectBanner', { title: 'Job Completed (S3 failed)', message: `${formattedId} — PDF downloaded but S3 upload failed.`, type: 'warning' }).catch(() => {});
                await this.onComplete({ filePath, s3Key: null, s3Url: null });
            }
        } else {
            await this.cmd('injectBanner', { title: 'Job Finished — No File', message: `${formattedId} — completed but no PDF was downloaded.`, type: 'warning' }).catch(() => {});
            await this.onComplete({ filePath: null, s3Key: null, s3Url: null });
        }

        this.logger?.info('Job finished — close the tab manually from the extension when ready.');
    }

    // ── Execute verb ──────────────────────────────────────────────────────────
    async _executeVerb(target, verb, payload) {

        if (target === 'page') {
            if (verb === 'goto') {
                this._captchaCooldownUntil = null; // reset on new page
                await this.cmd('goto', { url: payload }, 60000);
                return;
            }
            if (verb === 'waitfor') {
                await new Promise(r => setTimeout(r, parseInt(payload) || 1000));
                return;
            }
            if (verb === 'clickselector' || verb === 'spaclick') {
                await this.cmd('click', { selector: payload });
                return;
            }
            if (verb === 'catchpdf') {
                // Intercept PDF from network (e.g. print window) and save to disk
                const result = await this.cmd('catchpdf', { timeout: 15000 }, 20000);
                if (!result?.base64) throw new Error('No PDF data received');

                const dir = path.dirname(path.resolve(payload));
                fs.mkdirSync(dir, { recursive: true });
                const buffer = Buffer.from(result.base64, 'base64');
                fs.writeFileSync(path.resolve(payload), buffer);
                this.logger?.info(`PDF saved: ${payload} (${buffer.length} bytes)`);
                return;
            }
            if (verb === 'downloadnewtab') {
                // Extension intercepts new tab, downloads PDF, returns base64
                const result = await this.cmd('downloadnewtab', { savePath: payload }, 30000);
                if (!result?.base64) throw new Error('No PDF data received');

                // Save base64 to file
                const dir = path.dirname(path.resolve(payload));
                fs.mkdirSync(dir, { recursive: true });
                const buffer = Buffer.from(result.base64, 'base64');
                fs.writeFileSync(path.resolve(payload), buffer);
                this.logger?.info(`PDF downloaded: ${payload} (${buffer.length} bytes)`);
                return;
            }
            if (verb === 'evaluate' || verb === 'execute') {
                const result = await this.cmd('evaluate', { expression: payload });
                if (result?.value === false) {
                    throw new Error(`Action returned false: ${payload.slice(0, 80)}...`);
                }
                return;
            }
            if (verb === 'do') {
                // [page][do] — convert Playwright syntax to vanilla JS
                // Only dispatch 'input' NOT 'change' to avoid triggering form auto-submit/reload
                let converted = payload
                    .replace(/await page\.type\((['"`])(.+?)\1,\s*(['"`])(.+?)\3\)/g,
                        "(function(){ var el = document.querySelector('$2'); if(!el) return false; el.click(); el.focus(); el.value=''; el.value='$4'; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()")
                    .replace(/await page\.click\((['"`])(.+?)\1\)/g,
                        "(function(){ var el = document.querySelector('$2'); if(!el) return false; el.click(); return true; })()");

                if (converted.includes('await') || converted.includes('page.')) {
                    converted = converted.replace(/\bawait\s+/g, '').replace(/\bpage\./g, 'document.');
                }

                const result = await this.cmd('evaluate', { expression: converted });
                if (result?.value === false) {
                    throw new Error(`Element not found: ${payload}`);
                }
                return;
            }
            if (verb === 'waitforurl') {
                await this.cmd('waitForUrl', { fragment: payload, timeout: 30000 }, 35000);
                // Close any extra tabs that opened during navigation
                await this.cmd('closeExtraTabs', {}).catch(() => {});
                return;
            }
            if (verb === 'wait-download' || verb === 'waitdownload') {
                // payload: "./path/to/file.pdf" or "./path/to/file.pdf 300000"
                const parts   = payload.trim().split(/\s+/);
                const savePath = parts[0];
                const timeout  = parseInt(parts[1]) || 120000; // default 2 min
                this.logger?.info(`Waiting for human to download PDF (timeout: ${timeout/1000}s)...`);
                const result = await this.cmd('waitDownload', { timeout }, timeout + 5000);
                if (!result?.base64) throw new Error('No file received from wait-download');
                const buf      = Buffer.from(result.base64, 'base64');
                const fullPath = path.resolve(savePath);
                await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.promises.writeFile(fullPath, buf);
                this.logger?.info(`File captured: ${savePath} (${buf.length} bytes)`);
                this._downloadedFile = fullPath;
                return;
            }
            if (verb === 'download-href' || verb === 'downloadhref') {
                const [selector, savePath] = payload.split('->').map(s => s.trim());
                // Get href — either from window.__samHref (set by previous evaluate) or from DOM selector
                const result = await this.cmd('evaluate', {
                    expression: selector === '__samhref' || selector === '__samHref'
                        ? `window.__samHref || null`
                        : `(function(){ var el = document.querySelector(${JSON.stringify(selector)}); if(!el) return null; return el.getAttribute('href') || el.href || null; })()`,
                });
                const href = result?.value;
                if (!href) throw new Error(`No href found: ${selector}`);
                this.logger?.info(`Downloading from href: ${href}`);
                const dlResult = await this.cmd('fetchDownload', { url: href });
                if (!dlResult?.base64) throw new Error('No data received from download');
                const buf      = Buffer.from(dlResult.base64, 'base64');
                const fullPath = path.resolve(savePath);
                await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.promises.writeFile(fullPath, buf);
                this.logger?.info(`PDF downloaded: ${savePath} (${buf.length} bytes)`);
                this._downloadedFile = fullPath;
                return;
            }
            if (verb === 'captcha-detection' || verb === 'captchadetection') {
                await this._waitForPageReady();
                const captcha = await this._detectCaptcha();
                if (captcha) {
                    this.logger?.handoff(`CAPTCHA detected — human takeover needed`);
                    await this.cmd('notifyHandoff', { message: `CAPTCHA detected. Please solve it and click Resume to continue.` }).catch(() => {});
                    await this.cmd('injectBanner', { title: 'CAPTCHA Detected!', message: 'Please solve the CAPTCHA and click Resume.', type: 'captcha' }).catch(() => {});
                    await this.onHandoff({ message: `CAPTCHA detected. Please solve it and click Resume to continue.` });
                    this._captchaCooldownUntil = Date.now() + 30000;
                } else {
                    this.logger?.info('No CAPTCHA detected — continuing');
                }
                return;
            }
            if (verb === 'waitforselector') {
                await this.cmd('evaluate', {
                    expression: `new Promise((resolve, reject) => {
                        const start = Date.now();
                        const check = () => {
                            if (document.querySelector(${JSON.stringify(payload)})) resolve(true);
                            else if (Date.now() - start > 30000) reject(new Error('Selector timeout: ${payload}'));
                            else setTimeout(check, 500);
                        };
                        check();
                    })`,
                }, 35000);
                return;
            }
            if (verb === 'press') {
                await this.cmd('evaluate', {
                    expression: `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(payload)}, bubbles: true }))`,
                });
                return;
            }
            if (verb === 'expect-newtab' || verb === 'expectnewtab') {
                await this.cmd('expectNewTab', {});
                return;
            }
        }

        if (target === 'stagehand') {
            if (verb === 'handoff') {
                // Notify extension to show "Go to Tab" button — no auto-focus
                await this.cmd('notifyHandoff', { message: payload }).catch(() => {});
                await this.cmd('injectBanner', { title: 'Action Required', message: payload, type: 'handoff' }).catch(() => {});
                await this.onHandoff({ message: payload });
                return;
            }
            if (verb === 'act') {
                // Use AI via Anthropic API to convert instruction to JS then evaluate
                await this._actWithAI(payload);
                return;
            }
            if (verb === 'observe') {
                // observe = wait for page to settle, log what's on screen
                await new Promise(r => setTimeout(r, 1500));
                const { value: url } = await this.cmd('getUrl', {});
                this.logger?.info(`Observed page: ${url}`);
                return;
            }
        }

        if (target === 'human') {
            if (verb === 'pause') {
                this.logger?.handoff(`Paused: ${payload}`);
                await this.cmd('notifyHandoff', { message: payload || 'Human action required — click Resume to continue.' }).catch(() => {});
                await this.cmd('injectBanner', { title: 'Action Required', message: payload || 'Human action required — click Resume.', type: 'handoff' }).catch(() => {});
                await this.onHandoff({ message: payload });
                return;
            }
        }

        // Unknown verb — log and skip
        console.warn(`[ext] unknown verb: [${target}][${verb}] — skipping`);
        this.logger?.info(`Skipped unknown verb: [${target}][${verb}]`);
    }

    // ── AI act — sends page HTML to Claude, executes resulting JS in extension ──
    async _actWithAI(instruction) {
        this.logger?.info(`AI acting: ${instruction}`);
        try {
            // Get current page HTML from extension
            const { value: html } = await this.cmd('getHtml', {});
            if (!html) throw new Error('Could not get page HTML');

            // Call Claude API directly (same key used by Stagehand)
            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method:  'POST',
                headers: {
                    'Content-Type':      'application/json',
                    'x-api-key':         process.env.SAM_SCRAPER_ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model:      'claude-sonnet-4-20250514',
                    max_tokens: 500,
                    messages: [{
                        role:    'user',
                        content: `You are a browser automation expert. Given the page HTML, write JavaScript to perform this action: ${instruction}

STRICT RULES:
- Return ONLY the JavaScript, no markdown, no backticks, no explanation
- Use IIFE pattern: (function(){ ... return true; })()
- Use getElementById, querySelector with valid CSS selectors ONLY
- NEVER use :contains() — jQuery only, does not work in vanilla JS
- To find button/element by text: Array.from(document.querySelectorAll('button,a,input')).find(function(e){ return e.textContent.trim().includes('Text') || e.value === 'Text'; })
- For clicking: el.click()
- For typing into inputs (IMPORTANT - click first then type):
  el.click(); el.focus(); el.value = ''; el.value = 'text'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
- For radio buttons: el.checked = true; el.click(); el.dispatchEvent(new Event('change',{bubbles:true}))
- No async, no await, no Promises, no XPath

EXAMPLE for typing:
(function(){ var el = document.querySelector('input[name="lastName"]'); if(!el) return false; el.click(); el.focus(); el.value = ''; el.value = 'SMITH'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()

HTML (first 5000 chars):
${html.slice(0, 5000)}`,
                    }],
                }),
            });

            if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
            const data = await res.json();
            let js = data.content?.[0]?.text?.trim() || '';

            // Strip any markdown backticks if Claude added them
            js = js.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();

            if (!js) throw new Error('AI returned empty JS');

            console.log(`[ext][act] executing JS: ${js.slice(0, 120)}...`);
            const result = await this.cmd('evaluate', { expression: js });
            console.log(`[ext][act] result:`, result);

            if (result?.value === false) {
                throw new Error(`Element not found or action failed: ${instruction}`);
            }

            await new Promise(r => setTimeout(r, 1000));

        } catch (err) {
            console.error('[ext][act] failed:', err.message);
            this.logger?.error(`AI action failed: ${err.message}`);
            throw err;
        }
    }

    // ── Send Web Push notification ────────────────────────────────────────────
    // ── Wait for page to be fully ready ──────────────────────────────────────
    async _waitForPageReady(timeoutMs = 8000) {
        // Record current tab count to detect unexpected new tabs
        const startTabCount = await this.cmd('evaluate', { expression: 'window.name || "main"' }).catch(() => null);

        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const result = await this.cmd('evaluate', {
                    expression: `document.readyState === 'complete' && !!document.body`,
                });
                if (result?.value === true) {
                    await new Promise(r => setTimeout(r, 800));
                    return;
                }
            } catch { /* page may be navigating */ }
            await new Promise(r => setTimeout(r, 300));
        }
    }

    // ── CAPTCHA detection ─────────────────────────────────────────────────────
    async _detectCaptcha() {
        try {
            const result = await this.cmd('evaluate', {
                expression: `(function(){
                    var signals = [
                        // reCAPTCHA v2
                        document.querySelector('iframe[src*="recaptcha/api2/anchor"]'),
                        document.querySelector('iframe[title="reCAPTCHA"]'),
                        document.querySelector('.g-recaptcha'),
                        // Cloudflare Turnstile
                        document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
                        document.querySelector('.cf-turnstile'),
                        // Cloudflare challenge page
                        document.querySelector('#challenge-form'),
                        document.querySelector('.cf-browser-verification'),
                        document.querySelector('#cf-please-wait'),
                        // hCaptcha
                        document.querySelector('iframe[src*="hcaptcha"]'),
                        document.querySelector('.h-captcha'),
                    ];
                    return signals.some(function(s){ return !!s; });
                })()`,
            });
            return result?.value === true;
        } catch {
            return false;
        }
    }

    // ── Human-readable action message ─────────────────────────────────────────
    _actionMessage(target, verb, payload) {
        if (target === 'page') {
            if (verb === 'goto')            return `Navigating to ${payload}`;
            if (verb === 'waitfor')         return `Waiting ${payload}ms`;
            if (verb === 'clickselector')   return `Clicking: ${payload}`;
            if (verb === 'spaclick')        return `Clicking (SPA): ${payload}`;
            if (verb === 'waitforurl')      return `Waiting for URL: ${payload}`;
            if (verb === 'waitforselector') return `Waiting for element: ${payload}`;
            if (verb === 'captcha-detection' || verb === 'captchadetection') return `Checking for CAPTCHA...`;
            if (verb === 'press')           return `Pressing key: ${payload}`;
            if (verb === 'downloadnewtab')  return `Downloading PDF → ${payload}`;
            if (verb === 'catchpdf')        return `Catching PDF from network → ${payload}`;
        }
        if (target === 'stagehand') {
            if (verb === 'handoff')  return `Waiting for human: ${payload}`;
            if (verb === 'act')      return `AI acting: ${payload}`;
            if (verb === 'waitforurl') return `Waiting for URL: ${payload}`;
        }
        if (target === 'human') {
            if (verb === 'pause') return `Paused: ${payload}`;
        }
        return `[${target}][${verb}]: ${payload}`;
    }
}

module.exports = ExtensionScraper;