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

    constructor({ query, jobId, onHandoff, onComplete, onError, onStatusUpdate, logger }) {
        this.query          = query;
        this.jobId          = jobId;
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
        return {
            mdFile: countyFile,
            mdFileConfig: countyFileConfig
        }
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

        this.logger?.info(`Extension scraper | markdown config: ${mdFileConfig}`);
        let configType = null;
        if (fs.existsSync(mdFileConfig)) {
            let mdFileConfigContent = fs.readFileSync(mdFileConfig, 'utf8');
            let mdFileConfigContentData = JSON.parse(mdFileConfigContent);

            configType = _.get(mdFileConfigContentData, 'type');
        }

        if (configType !== 'bot-human') {
            this.logger?.info(`Invalid config type: ${configType} (expected 'bot-human')`);
            throw new Error(`Invalid config type: ${configType} (expected 'bot-human')`);
        }

        const rawLines = fs.readFileSync(mdFile, 'utf8').split('\n');

        // ── Resolve conditionals (same logic as propertyScraper) ─────────────
        const actions        = [];
        const conditionStack = [];
        let   conditionActive = true;

        for (const raw of rawLines) {
            const line = String(raw).trim();
            if (!line || line.startsWith('#')) continue;

            const ifMatch = line.match(/^\[if\s+(.+)\]$/i);
            if (ifMatch) {
                const condition = ifMatch[1].trim();
                let result = false;
                try {
                    result = new Function('query', `return !!(${condition})`)(this.query);
                } catch (e) { console.warn('[conditional] eval error:', e.message); }
                conditionStack.push({ met: result, inElse: false });
                conditionActive = conditionStack.every(c => c.inElse ? !c.met : c.met);
                continue;
            }

            if (line.match(/^\[else\]$/i)) {
                if (conditionStack.length > 0) {
                    conditionStack[conditionStack.length - 1].inElse = true;
                    conditionActive = conditionStack.every(c => c.inElse ? !c.met : c.met);
                }
                continue;
            }

            if (line.match(/^\[endif\]$/i)) {
                conditionStack.pop();
                conditionActive = conditionStack.length === 0
                    ? true
                    : conditionStack.every(c => c.inElse ? !c.met : c.met);
                continue;
            }

            if (conditionActive) actions.push(line);
        }

        // ── Execute ───────────────────────────────────────────────────────────
        for (const raw of actions) {
            if (this.abortActions) break;

            let line = this.helper.replaceVariables(String(raw).trim(), this.query);
            const m  = line.match(/^\[(\w+)\]\[(\w+)\]\s*(.*)$/);
            if (!m) continue;

            const [, target, verb, rest] = m;
            const payload = rest.trim();
            const t = target.toLowerCase();
            const v = verb.toLowerCase();

            this.logger?.action(this._actionMessage(t, v, payload));
            console.log(`[ext] action: [${t}][${v}] ${payload}`);

            try {
                await this._executeVerb(t, v, payload);
                this.logger?.internal(line, 'ok');

                // Wait for page to settle before checking for CAPTCHA
                // Skip for pure wait actions — nothing changed
                if (v !== 'waitfor') {
                    await this._waitForPageReady();
                    const captcha = await this._detectCaptcha();
                    if (captcha) {
                        this.logger?.handoff(`CAPTCHA detected — human takeover needed`);
                        await this.cmd('focusTab', {}).catch(() => {});
                        await this.onHandoff({ message: `CAPTCHA detected after [${t}][${v}]. Please solve it and click Resume to continue.` });
                        await this.cmd('blurTab', {}).catch(() => {});
                    }
                }
            } catch (err) {
                console.error(`[ext] action failed: ${line}`, err.message);
                this.logger?.internal(line, 'error', err.message);
                this.logger?.error(`Action failed: ${err.message}`);

                // Stop MD execution and hand off to human
                this.logger?.handoff(`Action failed — human takeover needed: ${err.message}`);
                await this.onHandoff({ message: `Action failed on: [${t}][${v}] ${payload} — ${err.message}. Please complete manually then click Resume.` });
                // Continue from next action after resume
            }
        }

        // Check if file downloaded
        const propertyId = _.get(this.query, 'propertyId', null);
        const filePath   = `./downloads/${propertyId}/deed.pdf`;
        if (fs.existsSync(filePath)) {
            try {
                const { s3Key, s3Url } = await uploadToS3({ localPath: filePath, propertyId });
                await this.onComplete({ filePath, s3Key, s3Url });
            } catch {
                await this.onComplete({ filePath, s3Key: null, s3Url: null });
            }
        } else {
            await this.onComplete({ filePath: null, s3Key: null, s3Url: null });
        }

        // Signal extension to close the tab
        await this.cmd('closeTab', {}).catch(() => {});
    }

    // ── Execute verb ──────────────────────────────────────────────────────────
    async _executeVerb(target, verb, payload) {

        if (target === 'page') {
            if (verb === 'goto') {
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
                await this.cmd('evaluate', { expression: payload });
                return;
            }
            if (verb === 'do') {
                // [page][do] uses Playwright syntax — convert to JS equivalent
                // page.type(selector, text) → find el, set value, dispatch events
                // page.click(selector) → el.click()
                const converted = payload
                    .replace(/await page\.type\((['"`])(.+?)\1,\s*(['"`])(.+?)\3\)/g,
                        "(function(){ var el = document.querySelector('$2'); if(!el) return false; el.click(); el.focus(); el.value=''; el.value='$4'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()")
                    .replace(/await page\.click\((['"`])(.+?)\1\)/g,
                        "(function(){ var el = document.querySelector('$2'); if(!el) return false; el.click(); return true; })()");
                await this.cmd('evaluate', { expression: converted });
                return;
            }
            if (verb === 'waitforurl') {
                await this.cmd('waitForUrl', { fragment: payload, timeout: 30000 }, 35000);
                return;
            }
            if (verb === 'waitforselector') {
                await this.cmd('evaluate', {
                    expression: `new Promise((resolve, reject) => {
                        const start = Date.now();
                        const check = () => {
                            if (document.querySelector(${JSON.stringify(payload)})) resolve(true);
                            else if (Date.now() - start > 15000) reject(new Error('Selector timeout'));
                            else setTimeout(check, 300);
                        };
                        check();
                    })`,
                }, 20000);
                return;
            }
            if (verb === 'press') {
                await this.cmd('evaluate', {
                    expression: `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(payload)}, bubbles: true }))`,
                });
                return;
            }
        }

        if (target === 'stagehand') {
            if (verb === 'handoff') {
                // Bring tab to front so human can interact
                await this.cmd('focusTab', {}).catch(() => {});
                await this.onHandoff({ message: payload });
                // Push tab back to background after resume
                await this.cmd('blurTab', {}).catch(() => {});
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

    // ── Wait for page to be fully ready ──────────────────────────────────────
    async _waitForPageReady(timeoutMs = 8000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const result = await this.cmd('evaluate', {
                    expression: `document.readyState === 'complete' && !!document.body`,
                });
                if (result?.value === true) {
                    // Extra wait for JS-injected elements (CAPTCHA, SPA renders)
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
                    var html = document.body ? document.body.innerHTML.toLowerCase() : '';
                    var signals = [
                        // reCAPTCHA v2
                        document.querySelector('iframe[src*="recaptcha"]'),
                        document.querySelector('.g-recaptcha'),
                        document.querySelector('#g-recaptcha'),
                        // reCAPTCHA v3 — skip (invisible, doesn't need human)
                        // Cloudflare Turnstile
                        document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
                        document.querySelector('iframe[src*="turnstile"]'),
                        document.querySelector('.cf-turnstile'),
                        document.querySelector('[data-sitekey]'),
                        // Cloudflare challenge page
                        document.querySelector('#challenge-form'),
                        document.querySelector('.cf-browser-verification'),
                        document.querySelector('#cf-please-wait'),
                        // Generic CAPTCHA
                        document.querySelector('#captcha'),
                        document.querySelector('[class*="captcha"]:not([class*="recaptcha-badge"])'),
                        document.querySelector('[id*="captcha"]'),
                        document.querySelector('iframe[title*="challenge"]'),
                        // hCaptcha
                        document.querySelector('iframe[src*="hcaptcha"]'),
                        document.querySelector('.h-captcha'),
                        // Text indicators (only if visible CAPTCHA elements present)
                        (html.includes('turnstile') && html.includes('cloudflare')) ? true : null,
                        (html.includes('captcha') && html.includes('verify you are human')) ? true : null,
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
            if (verb === 'press')           return `Pressing key: ${payload}`;
            if (verb === 'downloadnewtab')  return `Downloading PDF → ${payload}`;
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