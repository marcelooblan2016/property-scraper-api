/**
 * background.js — SAM Scraper Chrome Extension (MV3)
 *
 * Architecture:
 * Node.js (DO) sends high-level action commands via WebSocket
 * Extension executes them using chrome.debugger + chrome.tabs APIs
 * Extension sends results back to Node
 *
 * Supported actions (maps to .md verbs):
 *   goto            → chrome.tabs.update(url)
 *   evaluate        → Runtime.evaluate (click, fill, etc)
 *   screenshot      → Page.captureScreenshot
 *   waitForUrl      → poll tab.url
 *   getUrl          → return current tab URL
 *   handoff         → notify user, wait for resume
 *   resume          → continue after handoff
 *   typeHuman       → type char-by-char with keyboard events (for [page][do])
 */

'use strict';

let activeBridge  = null; // { tabId, jobId, ws }
let pollInterval  = null;
let handoffResolve = null; // waiting for user to click Resume

// ── Config ────────────────────────────────────────────────────────────────────
async function getConfig() {
    const data = await chrome.storage.local.get(['apiUrl', 'apiSecret', 'bridgePort']);
    return {
        apiUrl:     data.apiUrl     || 'http://localhost:4000',
        apiSecret:  data.apiSecret  || '',
        bridgePort: parseInt(data.bridgePort) || 9223,
    };
}

// ── Connect bridge ────────────────────────────────────────────────────────────
async function startBridge(existingTabId, jobId) {
    const config = await getConfig();
    if (!config.apiSecret) throw new Error('API Secret not set');

    // Create a new tab for the bot — don't take over the user's current tab
    const newTab = await chrome.tabs.create({ url: 'about:blank', active: false });
    const tabId  = newTab.id;
    console.log(`[bridge] created new tab ${tabId} for job ${jobId}`);

    // Wait for tab to be ready before attaching debugger
    await new Promise((resolve) => {
        function listener(updatedTabId, info) {
            if (updatedTabId === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
        // Also resolve immediately if already complete
        chrome.tabs.get(tabId).then(t => {
            if (t.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        });
        // Fallback timeout
        setTimeout(resolve, 2000);
    });

    // Attach Chrome debugger
    await chrome.debugger.attach({ tabId }, '1.3');
    console.log(`[bridge] debugger attached to tab ${tabId}`);

    // Enable required CDP domains
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    console.log('[bridge] CDP domains enabled');

    // Notify Node we are ready
    await fetch(`${config.apiUrl}/jobs/${jobId}/bridge-ready`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiSecret}` },
        body:    JSON.stringify({ tabId, bridgePort: config.bridgePort }),
    });

    // Connect WebSocket to Node bridge
    const wsHost = config.apiUrl.replace(/^http/, 'ws').replace(/:\d+$/, '');
    const ws     = new WebSocket(`${wsHost}:${config.bridgePort}/bridge?jobId=${jobId}&token=${config.apiSecret}&role=extension`);

    ws.onopen = () => {
        console.log('[bridge] WS connected');
        activeBridge = { tabId, jobId, ws };
        notifyPopup('BRIDGE_STATUS', { status: 'connected', jobId });
    };

    ws.onmessage = async (event) => {
        try {
            const cmd = JSON.parse(event.data);
            console.log(`[bridge] received command: ${cmd.action}`);
            const result = await executeCommand(tabId, cmd);
            ws.send(JSON.stringify({ id: cmd.id, result }));
        } catch (err) {
            const cmd = JSON.parse(event.data).id;
            ws.send(JSON.stringify({ id: cmd, error: err.message }));
        }
    };

    ws.onclose = () => { console.log('[bridge] WS closed'); stopBridge(); };
    ws.onerror = () => { console.error('[bridge] WS error'); stopBridge(); };

    // Forward CDP events (navigation, network, etc)
    chrome.debugger.onEvent.addListener((source, method, params) => {
        if (source.tabId === tabId && activeBridge?.ws?.readyState === WebSocket.OPEN) {
            activeBridge.ws.send(JSON.stringify({ type: 'event', method, params }));
        }
    });

    chrome.tabs.onRemoved.addListener((removedTabId) => {
        if (removedTabId === tabId) stopBridge();
    });

    // Auto-reattach if Chrome detaches debugger (e.g. on navigation)
    chrome.debugger.onDetach.addListener(async (source, reason) => {
        if (source.tabId !== tabId) return;
        if (!activeBridge) return;
        if (reason === 'target_closed') { stopBridge(); return; }

        console.log(`[bridge] debugger detached (${reason}) — reattaching...`);
        try {
            await new Promise(r => setTimeout(r, 500));
            await chrome.debugger.attach({ tabId }, '1.3');
            await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
            console.log('[bridge] debugger re-attached');
        } catch (err) {
            console.error('[bridge] re-attach failed:', err.message);
        }
    });
}

// ── Execute action commands from Node ─────────────────────────────────────────
async function executeCommand(tabId, cmd) {
    const { action, params } = cmd;

    switch (action) {

        case 'goto': {
            // Detach debugger before navigation — Chrome auto-detaches on unload
            try { await chrome.debugger.detach({ tabId }); } catch {}

            await chrome.tabs.update(tabId, { url: params.url });
            await waitForTabLoad(tabId);

            // Re-attach debugger after page loads
            await chrome.debugger.attach({ tabId }, '1.3');
            await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
            console.log(`[bridge] re-attached debugger after goto: ${params.url}`);

            return { ok: true, url: params.url };
        }

        case 'evaluate': {
            const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression:    params.expression,
                awaitPromise:  true,
                returnByValue: true,
                userGesture:   true,
            });
            if (res.exceptionDetails) {
                const errMsg = res.exceptionDetails?.exception?.description
                    || res.exceptionDetails?.text
                    || JSON.stringify(res.exceptionDetails);
                throw new Error(errMsg);
            }
            return { ok: true, value: res.result?.value };
        }

        case 'click': {
            const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression:    `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) throw new Error('Element not found: ' + ${JSON.stringify(params.selector)}); el.click(); return true; })()`,
                awaitPromise:  false,
                returnByValue: true,
                userGesture:   true,
            });
            if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
            return { ok: true };
        }

        case 'type': {
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression:    `document.querySelector(${JSON.stringify(params.selector)}).value = ${JSON.stringify(params.text)}`,
                awaitPromise:  false,
                returnByValue: true,
            });
            return { ok: true };
        }

        // ── typeHuman — fires keyboard events per character ────────────────
        //    used by [page][do] await page.type(...)
        //    mimics Puppeteer's page.type() behaviour ─────────────────────
        case 'typeHuman': {
            const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression: `(async () => {
                    const el = document.querySelector(${JSON.stringify(params.selector)});
                    if (!el) throw new Error('Element not found: ' + ${JSON.stringify(params.selector)});
                    el.focus();
                    el.click();
                    el.value = '';
                    for (const char of ${JSON.stringify(params.text)}) {
                        el.value += char;
                        el.dispatchEvent(new KeyboardEvent('keydown',  { key: char, bubbles: true }));
                        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
                        el.dispatchEvent(new Event('input',            { bubbles: true }));
                        el.dispatchEvent(new KeyboardEvent('keyup',    { key: char, bubbles: true }));
                        await new Promise(r => setTimeout(r, 30));
                    }
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                })()`,
                awaitPromise:  true,
                returnByValue: true,
                userGesture:   true,
            });
            if (res.exceptionDetails) {
                const errMsg = res.exceptionDetails?.exception?.description
                    || res.exceptionDetails?.text
                    || JSON.stringify(res.exceptionDetails);
                throw new Error(errMsg);
            }
            return { ok: true };
        }

        case 'getUrl': {
            const tab = await chrome.tabs.get(tabId);
            return { ok: true, url: tab.url };
        }

        case 'waitForUrl': {
            const start   = Date.now();
            const timeout = params.timeout || 30000;
            while (Date.now() - start < timeout) {
                const tab = await chrome.tabs.get(tabId);
                if (tab.url?.includes(params.fragment)) {
                    return { ok: true, url: tab.url };
                }
                await new Promise(r => setTimeout(r, 500));
            }
            throw new Error(`Timeout waiting for URL fragment: ${params.fragment}`);
        }

        case 'screenshot': {
            const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
                format:  'png',
                quality: 80,
            });
            return { ok: true, data: res.data };
        }

        case 'handoff': {
            // Show notification to user
            chrome.notifications.create(`handoff-${cmd.id}`, {
                type:    'basic',
                iconUrl: 'icons/icon48.png',
                title:   'SAM Scraper — Action Required',
                message: params.message || 'Please complete the required action in Chrome',
                buttons: [{ title: 'Resume Bot' }],
            });
            notifyPopup('HANDOFF', { message: params.message, jobId: activeBridge?.jobId });
            return { ok: true, waiting: true };
        }

        case 'focusTab': {
            const t = await chrome.tabs.get(tabId);
            await chrome.tabs.update(tabId, { active: true });
            await chrome.windows.update(t.windowId, { focused: true });
            return { ok: true };
        }

        case 'blurTab': {
            // Find another tab to make active instead
            const allTabs = await chrome.tabs.query({ currentWindow: true });
            const other   = allTabs.find(t => t.id !== tabId && !t.url?.startsWith('chrome-extension://'));
            if (other) await chrome.tabs.update(other.id, { active: true });
            return { ok: true };
        }

        case 'ping': {
            return { ok: true, pong: true };
        }

        case 'getHtml': {
            const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression:    'document.documentElement.outerHTML',
                returnByValue: true,
            });
            return { ok: true, value: res.result?.value };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}

// ── Wait for tab to load ──────────────────────────────────────────────────────
function waitForTabLoad(tabId, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Tab load timeout')), timeout);

        function listener(updatedTabId, info) {
            if (updatedTabId === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve();
            }
        }

        chrome.tabs.onUpdated.addListener(listener);

        // Also check if already loaded
        chrome.tabs.get(tabId).then(tab => {
            if (tab.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve();
            }
        });
    });
}

async function stopBridge() {
    if (!activeBridge) return;
    const { tabId, jobId } = activeBridge;
    try { await chrome.debugger.detach({ tabId }); } catch {}
    try { activeBridge.ws?.close(); } catch {}
    activeBridge = null;
    notifyPopup('BRIDGE_STATUS', { status: 'disconnected', jobId });
}

// ── Job polling ───────────────────────────────────────────────────────────────
async function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    const config = await getConfig();
    if (!config.apiSecret) { console.log('[poller] no secret — skipping'); return; }
    console.log(`[poller] started | ${config.apiUrl}`);
    pollInterval = setInterval(async () => {
        try {
            const cfg  = await getConfig();
            const res  = await fetch(`${cfg.apiUrl}/jobs`, {
                headers: { 'Authorization': `Bearer ${cfg.apiSecret}` },
            });
            if (!res.ok) return;
            const jobs = await res.json();
            const waiting = Array.isArray(jobs) ? jobs.filter(j => j.status === 'waiting') : [];
            for (const job of waiting) {
                chrome.notifications.create(`job-${job.id}`, {
                    type:    'basic',
                    iconUrl: 'icons/icon48.png',
                    title:   'SAM Scraper — Action Required',
                    message: `Job ${job.id.slice(0, 8)}... needs your attention`,
                });
            }
        } catch (err) { console.log('[poller] error:', err.message); }
    }, 5000);
}

function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function resumeJob(jobId) {
    const config = await getConfig();
    await fetch(`${config.apiUrl}/jobs/${jobId}/resume`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${config.apiSecret}` },
    });
}

function notifyPopup(type, data) {
    chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            if (msg.type === 'GET_STATE') {
                sendResponse({
                    bridge:  activeBridge ? { jobId: activeBridge.jobId, tabId: activeBridge.tabId } : null,
                    polling: pollInterval !== null,
                });
            } else if (msg.type === 'START_BRIDGE') {
                const allTabs = await chrome.tabs.query({ active: true });
                const tab = allTabs.find(t => t.id && !t.url?.startsWith('chrome-extension://'));
                if (!tab) { sendResponse({ ok: false, error: 'No suitable tab found — open a browser tab first' }); return; }
                await startBridge(tab.id, msg.jobId);
                sendResponse({ ok: true });
            } else if (msg.type === 'STOP_BRIDGE') {
                await stopBridge();
                sendResponse({ ok: true });
            } else if (msg.type === 'RESUME_JOB') {
                await resumeJob(msg.jobId);
                sendResponse({ ok: true });
            } else if (msg.type === 'START_POLLING') {
                await startPolling();
                sendResponse({ ok: true });
            } else if (msg.type === 'STOP_POLLING') {
                stopPolling();
                sendResponse({ ok: true });
            }
        } catch (err) {
            console.error('[background] error:', err.message);
            sendResponse({ ok: false, error: err.message });
        }
    })();
    return true;
});

// ── Boot ──────────────────────────────────────────────────────────────────────
startPolling();
