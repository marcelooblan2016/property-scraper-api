/**
 * background.js — SAM Scraper Chrome Extension (MV3)
 *
 * AUTONOMOUS MODE:
 * - Polls API every 5s for waiting jobs
 * - Auto-connects bridge for each waiting job (no user click needed)
 * - Runs bot in background tab
 * - Brings tab to front ONLY on [handoff]
 * - User clicks Resume → tab goes back to background
 * - Supports multiple concurrent jobs (one tab per job)
 */

'use strict';

// Map<jobId, { tabId, jobId, ws }> — supports multiple concurrent jobs
const activeBridges = new Map();
const tabRegistry   = new Map();
const reconnecting  = new Set(); // jobs currently reconnecting — don't auto-connect new tab
let pollInterval    = null;
let autoConnected   = new Set();
const manuallyDisconnected = new Set(); // jobs user explicitly disconnected // track jobs we already auto-connected

// ── Client ID — unique per browser installation ───────────────────────────────
async function getClientId() {
    const data = await chrome.storage.local.get(['uuid', 'clientId']);
    // Migrate old clientId key to uuid
    if (!data.uuid && data.clientId) {
        await chrome.storage.local.set({ uuid: data.clientId });
        await chrome.storage.local.remove('clientId');
        console.log(`[bridge] migrated clientId → uuid: ${data.clientId}`);
        return data.clientId;
    }
    if (data.uuid) return data.uuid;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ uuid: id });
    console.log(`[bridge] generated new uuid: ${id}`);
    return id;
}

// Force reset uuid — call this if two browsers end up with same ID
async function resetClientId() {
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ uuid: id });
    console.log(`[bridge] reset uuid: ${id}`);
    return id;
}

// ── Config ────────────────────────────────────────────────────────────────────
async function getConfig() {
    const data = await chrome.storage.local.get(['apiUrl', 'apiSecret', 'bridgePort']);
    return {
        apiUrl:     data.apiUrl     || 'http://localhost:4000',
        apiSecret:  data.apiSecret  || '',
        bridgePort: parseInt(data.bridgePort) || 9223,
    };
}

// ── Start bridge for a job ────────────────────────────────────────────────────
async function startBridge(jobId) {
    const config = await getConfig();
    if (!config.apiSecret) throw new Error('API Secret not set');
    if (activeBridges.has(jobId)) {
        console.log(`[bridge] already connected for job: ${jobId}`);
        return;
    }

    console.log(`[bridge] auto-connecting for job: ${jobId}`);

    // Create a new background tab for this job
    const newTab = await chrome.tabs.create({ url: 'about:blank', active: false });
    const tabId  = newTab.id;
    console.log(`[bridge] created tab ${tabId} for job ${jobId}`);
    tabRegistry.set(jobId, tabId); // persist tabId even after bridge closes

    // Wait for tab to be ready
    await new Promise((resolve) => {
        function listener(updatedTabId, info) {
            if (updatedTabId === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.get(tabId).then(t => {
            if (t.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        });
        setTimeout(resolve, 2000);
    });

    // Attach debugger
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});

    console.log(`[bridge] debugger attached to tab ${tabId}`);

    // Notify Node
    const uuid = await getClientId();
    await fetch(`${config.apiUrl}/jobs/${jobId}/bridge-ready`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiSecret}` },
        body:    JSON.stringify({ tabId, bridgePort: config.bridgePort, uuid }),
    });

    // Connect WebSocket
    const wsHost = config.apiUrl.replace(/^http/, 'ws').replace(/:\d+$/, '');
    const ws     = new WebSocket(`${wsHost}:${config.bridgePort}/bridge?jobId=${jobId}&token=${config.apiSecret}&role=extension`);

    ws.onopen = () => {
        console.log(`[bridge] WS connected | job: ${jobId}`);
        activeBridges.set(jobId, { tabId, jobId, ws });
        notifyPopup('BRIDGE_STATUS', { status: 'connected', jobId, tabId });
    };

    ws.onmessage = async (event) => {
        try {
            const cmd    = JSON.parse(event.data);
            const result = await executeCommand(tabId, cmd, jobId);
            ws.send(JSON.stringify({ id: cmd.id, result }));
        } catch (err) {
            const cmd = JSON.parse(event.data);
            ws.send(JSON.stringify({ id: cmd?.id, error: err.message }));
        }
    };

    ws.onclose = () => {
        console.log(`[bridge] WS closed | job: ${jobId}`);
        const bridge = activeBridges.get(jobId);
        if (bridge && bridge.ws === ws) {
            activeBridges.delete(jobId);
            notifyPopup('BRIDGE_STATUS', { status: 'disconnected', jobId });
        }
    };

    ws.onerror = () => {
        console.error(`[bridge] WS error | job: ${jobId}`);
    };

    // Keepalive ping every 10s to prevent WS timeout during long operations
    const pingInterval = setInterval(() => {
        const bridge = activeBridges.get(jobId);
        if (!bridge || bridge.ws?.readyState !== WebSocket.OPEN) {
            clearInterval(pingInterval);
            return;
        }
        bridge.ws.send(JSON.stringify({ type: 'ping' }));
    }, 10000);

    // Forward CDP events → Node
    chrome.debugger.onEvent.addListener((source, method, params) => {
        const bridge = activeBridges.get(jobId);
        if (source.tabId === tabId && bridge?.ws?.readyState === WebSocket.OPEN) {
            bridge.ws.send(JSON.stringify({ type: 'event', method, params }));
        }
    });

    // Auto-reattach on unexpected detach — do NOT stop bridge
    chrome.debugger.onDetach.addListener(async (source, reason) => {
        if (source.tabId !== tabId) return;
        if (reason === 'target_closed') {
            console.log(`[bridge] tab ${tabId} closed | job: ${jobId}`);
            stopBridge(jobId);
            return;
        }
        console.log(`[bridge] debugger detached (${reason}) — reattaching tab ${tabId}...`);
        reconnecting.add(jobId);
        try {
            await new Promise(r => setTimeout(r, 100));

            // Close any extra tabs that opened (e.g. window.open from the site)
            const allTabs = await chrome.tabs.query({});
            for (const t of allTabs) {
                if (t.id !== tabId && t.id > tabId &&
                    !t.url?.startsWith('chrome-extension://') &&
                    !t.url?.startsWith('chrome://')) {
                    console.log(`[bridge] closing extra tab: ${t.id} ${t.url}`);
                    await chrome.tabs.remove(t.id).catch(() => {});
                }
            }

            await chrome.debugger.attach({ tabId }, '1.3');
            await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});

            console.log(`[bridge] debugger re-attached | tab ${tabId}`);
        } catch (err) {
            console.error('[bridge] re-attach failed:', err.message);
            stopBridge(jobId);
        } finally {
            reconnecting.delete(jobId);
        }
    });

    // Cleanup if tab closed
    chrome.tabs.onRemoved.addListener((removedTabId) => {
        if (removedTabId === tabId) stopBridge(jobId);
    });
}

async function stopBridge(jobId, manual = false) {
    const bridge = activeBridges.get(jobId);
    if (!bridge) return;
    try { await chrome.debugger.detach({ tabId: bridge.tabId }); } catch {}
    try { bridge.ws?.close(); } catch {}
    activeBridges.delete(jobId);
    autoConnected.delete(jobId);
    if (manual) manuallyDisconnected.add(jobId);
    notifyPopup('BRIDGE_STATUS', { status: 'disconnected', jobId });
    console.log(`[bridge] stopped | job: ${jobId} | manual: ${manual}`);
}

// ── Execute action commands ────────────────────────────────────────────────────
async function executeCommand(tabId, cmd, jobId) {
    const { action, params } = cmd;

    // Auto-reattach debugger if it was manually detached
    const bridge = activeBridges.get(jobId);
    if (bridge && bridge.debuggerAttached === false && action !== 'ping' && action !== 'focusTab' && action !== 'blurTab') {
        console.log(`[bridge] auto-reattaching debugger for command: ${action}`);
        try {
            await chrome.debugger.attach({ tabId }, '1.3');
            await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
            bridge.debuggerAttached = true;
        } catch (err) {
            console.warn('[bridge] auto-reattach failed:', err.message);
        }
    }

    switch (action) {

        case 'goto': {
            try { await chrome.debugger.detach({ tabId }); } catch {}
            await chrome.tabs.update(tabId, { url: params.url });
            await waitForTabLoad(tabId);
            await chrome.debugger.attach({ tabId }, '1.3');
            await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
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
                expression:    `(function(){ var el = document.querySelector(${JSON.stringify(params.selector)}); if(!el) throw new Error('Element not found: ' + ${JSON.stringify(params.selector)}); el.click(); return true; })()`,
                awaitPromise:  false,
                returnByValue: true,
                userGesture:   true,
            });
            if (res.exceptionDetails) throw new Error(res.exceptionDetails?.exception?.description || res.exceptionDetails?.text);
            return { ok: true };
        }

        case 'getHtml': {
            const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression:    'document.documentElement.outerHTML',
                returnByValue: true,
            });
            return { ok: true, value: res.result?.value };
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
                if (tab.url?.includes(params.fragment)) return { ok: true, url: tab.url };
                await new Promise(r => setTimeout(r, 500));
            }
            throw new Error(`Timeout waiting for URL: ${params.fragment}`);
        }

        case 'screenshot': {
            const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png', quality: 80 });
            return { ok: true, data: res.data };
        }

        case 'focusTab': {
            const t = await chrome.tabs.get(tabId);
            await chrome.tabs.update(tabId, { active: true });
            await chrome.windows.update(t.windowId, { focused: true });
            return { ok: true };
        }

        case 'blurTab': {
            const allTabs = await chrome.tabs.query({ currentWindow: true });
            const other   = allTabs.find(t => t.id !== tabId && !t.url?.startsWith('chrome-extension://'));
            if (other) await chrome.tabs.update(other.id, { active: true });
            return { ok: true };
        }

        case 'waitDownload': {
            const timeout = params.timeout || 120000; // 2 min for human to download

            const pdfData = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    chrome.debugger.onEvent.removeListener(onEvent);
                    reject(new Error('Wait download timeout — no PDF downloaded within 2 minutes'));
                }, timeout);

                const reqIds = new Map(); // requestId → url

                function onEvent(source, method, eventParams) {
                    if (source.tabId !== tabId) return;

                    if (method === 'Network.responseReceived') {
                        const mime = eventParams.response?.mimeType || '';
                        const url  = eventParams.response?.url || '';
                        if (mime.includes('pdf') || url.includes('.pdf') || mime.includes('octet-stream')) {
                            reqIds.set(eventParams.requestId, url);
                        }
                    }

                    if (method === 'Network.loadingFinished' && reqIds.has(eventParams.requestId)) {
                        const url = reqIds.get(eventParams.requestId);
                        chrome.debugger.sendCommand(
                            { tabId },
                            'Network.getResponseBody',
                            { requestId: eventParams.requestId }
                        ).then(body => {
                            chrome.debugger.onEvent.removeListener(onEvent);
                            clearTimeout(timer);
                            resolve({ body, url });
                        }).catch(() => {});
                    }
                }

                chrome.debugger.onEvent.addListener(onEvent);
            });

            const base64 = pdfData.body.base64Encoded
                ? pdfData.body.body
                : btoa(pdfData.body.body);

            console.log(`[bridge] wait-download caught: ${pdfData.url}`);
            return { ok: true, base64, url: pdfData.url };
        }

        case 'expectNewTab': {
            const bridge = activeBridges.get(jobId);
            if (bridge) bridge.expectingNewTab = true;
            // Temporarily restore window.open so target="new" links work
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression: `if(window.__samOrigOpen) { window.open = window.__samOrigOpen; } else { delete window.open; }`,
                returnByValue: false,
            }).catch(() => {});
            console.log(`[bridge] expecting new tab | job: ${jobId}`);
            return { ok: true };
        }

        case 'fetchDownload': {
            const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression: `(async function(){
                    const url = new URL(${JSON.stringify(params.url)}, location.href).href;
                    const r = await fetch(url, {
                        credentials: 'include',
                        headers: { 'Referer': location.href, 'Accept': 'application/pdf,*/*' }
                    });
                    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
                    const contentType = r.headers.get('content-type') || '';
                    if (contentType.includes('html')) {
                        const text = await r.text();
                        // Find PDF URL in the HTML — look for embed/iframe/anchor with pdf
                        let pdfUrl = null;
                        const tags = ['embed src=', 'iframe src=', 'object data='];
                        for (const tag of tags) {
                            const idx = text.indexOf(tag);
                            if (idx === -1) continue;
                            const start = text.indexOf('"', idx + tag.length) + 1;
                            const end   = text.indexOf('"', start);
                            if (start > 0 && end > start) {
                                pdfUrl = text.slice(start, end);
                                break;
                            }
                        }
                        // Also check for window.location or direct PDF links
                        if (!pdfUrl) {
                            const idx = text.indexOf('.pdf');
                            if (idx > -1) {
                                const s = text.lastIndexOf('"', idx) + 1;
                                const e = text.indexOf('"', idx);
                                if (s > 0 && e > s) pdfUrl = text.slice(s, e);
                            }
                        }
                        if (!pdfUrl) {
                            // Return HTML for debugging
                            throw new Error('Could not find PDF URL in viewer. Content: ' + text.slice(0, 200));
                        }
                        pdfUrl = new URL(pdfUrl, location.href).href;
                        const r2    = await fetch(pdfUrl, { credentials: 'include' });
                        if (!r2.ok) throw new Error('PDF fetch failed: HTTP ' + r2.status);
                        const buf2  = await r2.arrayBuffer();
                        const u2    = new Uint8Array(buf2);
                        let b2 = '';
                        for (let i = 0; i < u2.length; i += 8192)
                            b2 += String.fromCharCode(...u2.subarray(i, i + 8192));
                        return JSON.stringify({ base64: btoa(b2), size: u2.length, url: pdfUrl });
                    }
                    const buf  = await r.arrayBuffer();
                    const u    = new Uint8Array(buf);
                    let b = '';
                    for (let i = 0; i < u.length; i += 8192)
                        b += String.fromCharCode(...u.subarray(i, i + 8192));
                    return JSON.stringify({ base64: btoa(b), size: u.length, url: r.url });
                })()`,
                awaitPromise:  true,
                returnByValue: true,
            });
            if (res.exceptionDetails) {
                throw new Error(res.exceptionDetails?.exception?.description || 'fetchDownload failed');
            }
            const raw = res.result?.value;
            if (!raw) throw new Error('fetchDownload: empty response');
            const parsed = JSON.parse(raw);
            console.log(`[bridge] fetchDownload: ${parsed.size} bytes from ${parsed.url}`);
            return { ok: true, base64: parsed.base64, url: parsed.url };
        }

        case 'downloadnewtab': {
            const pdfTimeout = params.timeout || 20000;
            const startTime  = Date.now();

            // Record existing tabs before we start
            const existingTabs  = await chrome.tabs.query({});
            const existingIds   = new Set(existingTabs.map(t => t.id));

            const pdfTab = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    chrome.tabs.onCreated.removeListener(onCreated);
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    reject(new Error('New tab timeout — PDF tab did not open'));
                }, pdfTimeout);

                // Check if a new tab already opened between evaluate and now
                chrome.tabs.query({}, (allTabs) => {
                    const newTab = allTabs
                        .filter(t => !existingIds.has(t.id) && t.id !== tabId)
                        .sort((a, b) => b.id - a.id)[0];

                    if (newTab) {
                        clearTimeout(timer);
                        if (newTab.status === 'complete') {
                            resolve(newTab);
                        } else {
                            function onUpdatedExisting(updatedTabId, info) {
                                if (updatedTabId !== newTab.id) return;
                                if (info.status === 'complete') {
                                    chrome.tabs.onUpdated.removeListener(onUpdatedExisting);
                                    chrome.tabs.get(newTab.id, t => resolve(t));
                                }
                            }
                            chrome.tabs.onUpdated.addListener(onUpdatedExisting);
                        }
                        return;
                    }

                    // No new tab yet — wait for one
                    function onCreated(tab) {
                        if (tab.id === tabId) return;
                        chrome.tabs.onCreated.removeListener(onCreated);
                        clearTimeout(timer);

                        if (tab.status === 'complete' && tab.url && !tab.url.startsWith('about:')) {
                            resolve(tab);
                            return;
                        }
                        function onUpdated(updatedTabId, info) {
                            if (updatedTabId !== tab.id) return;
                            if (info.status === 'complete') {
                                chrome.tabs.onUpdated.removeListener(onUpdated);
                                chrome.tabs.get(tab.id, t => resolve(t));
                            }
                        }
                        chrome.tabs.onUpdated.addListener(onUpdated);
                    }
                    chrome.tabs.onCreated.addListener(onCreated);
                });
            });

            const pdfUrl   = pdfTab.url;
            const pdfTabId = pdfTab.id;
            console.log(`[bridge] PDF tab: ${pdfUrl}`);

            // Download via fetch with credentials (session cookies)
            let base64;
            try {
                const response = await fetch(pdfUrl, { credentials: 'include' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const buffer = await response.arrayBuffer();
                const bytes  = new Uint8Array(buffer);
                const chunk  = 8192;
                let binary   = '';
                for (let i = 0; i < bytes.length; i += chunk) {
                    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
                }
                base64 = btoa(binary);
                console.log(`[bridge] downloaded ${bytes.length} bytes`);
            } catch (fetchErr) {
                console.warn(`[bridge] fetch failed (${fetchErr.message}) — trying CDP`);
                // Fallback: attach debugger to PDF tab and get response body
                try {
                    await chrome.debugger.attach({ tabId: pdfTabId }, '1.3');
                    await chrome.debugger.sendCommand({ tabId: pdfTabId }, 'Network.enable', {});
                    // The page already loaded — try to get cached response
                    const result = await chrome.debugger.sendCommand({ tabId: pdfTabId }, 'Runtime.evaluate', {
                        expression: `fetch(location.href,{credentials:'include'}).then(r=>r.arrayBuffer()).then(b=>{var u=new Uint8Array(b),s='',c=8192;for(var i=0;i<u.length;i+=c)s+=String.fromCharCode(...u.subarray(i,i+c));return btoa(s)})`,
                        awaitPromise: true,
                        returnByValue: true,
                    });
                    base64 = result.result?.value;
                    await chrome.debugger.detach({ tabId: pdfTabId }).catch(() => {});
                } catch (cdpErr) {
                    await chrome.debugger.detach({ tabId: pdfTabId }).catch(() => {});
                    await chrome.tabs.remove(pdfTabId).catch(() => {});
                    throw new Error(`PDF download failed: ${fetchErr.message}`);
                }
            }

            await chrome.tabs.remove(pdfTabId).catch(() => {});
            return { ok: true, base64, url: pdfUrl };
        }

        case 'catchpdf': {
            // Intercept PDF network response before print window opens
            const pdfTimeout = params.timeout || 15000;
            const pdfData = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    chrome.debugger.onEvent.removeListener(onEvent);
                    reject(new Error('PDF catch timeout'));
                }, pdfTimeout);
                const requestIds = new Set();

                function onEvent(source, method, eventParams) {
                    if (source.tabId !== tabId) return;

                    if (method === 'Network.responseReceived') {
                        const mime = eventParams.response?.mimeType || '';
                        const url  = eventParams.response?.url || '';
                        if (mime.includes('pdf') || url.toLowerCase().includes('.pdf') || mime.includes('octet-stream')) {
                            requestIds.add(eventParams.requestId);
                        }
                    }

                    if (method === 'Network.loadingFinished' && requestIds.has(eventParams.requestId)) {
                        chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', {
                            requestId: eventParams.requestId
                        }).then(body => {
                            chrome.debugger.onEvent.removeListener(onEvent);
                            clearTimeout(timer);
                            resolve(body);
                        }).catch(err => {
                            console.warn('[catchpdf] getResponseBody failed:', err.message);
                        });
                    }
                }

                chrome.debugger.onEvent.addListener(onEvent);
            });

            if (!pdfData?.body) throw new Error('No PDF body received');

            const pdfBase64 = pdfData.base64Encoded
                ? pdfData.body
                : btoa(pdfData.body);

            return { ok: true, base64: pdfBase64 };
        }

        case 'notifyHandoff': {
            // Show Chrome notification with "Go to Tab" action
            // Store the handoff info so popup can show "Go to Tab" button
            const bridge = activeBridges.get(jobId);
            if (bridge) bridge.pendingHandoff = params.message || 'Action required';
            notifyPopup('HANDOFF_REQUIRED', { jobId, tabId, message: params.message });
            // Show system notification
            chrome.notifications.create(`handoff-${jobId}`, {
                type:    'basic',
                iconUrl: 'icons/icon48.png',
                title:   'SAM Scraper — Action Required',
                message: params.message || 'Please complete the required action',
            });
            return { ok: true };
        }

        case 'closeExtraTabs': {
            // Close any tabs that opened after our bot tab (unexpected popups)
            const allTabs = await chrome.tabs.query({});
            const extras  = allTabs.filter(t =>
                t.id !== tabId &&
                t.id > tabId && // opened after our tab
                !t.url?.startsWith('chrome-extension://') &&
                !t.url?.startsWith('chrome://')
            );
            for (const t of extras) {
                await chrome.tabs.remove(t.id).catch(() => {});
                console.log(`[bridge] closed extra tab: ${t.id} ${t.url}`);
            }
            return { ok: true, closed: extras.length };
        }

        case 'closeTab': {
            try { await chrome.debugger.detach({ tabId }); } catch {}
            await chrome.tabs.remove(tabId).catch(() => {});
            await stopBridge(jobId);
            return { ok: true };
        }

        case 'close': {
            await stopBridge(jobId);
            return { ok: true };
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
        chrome.tabs.get(tabId).then(tab => {
            if (tab.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timer);
                resolve();
            }
        });
    });
}

// ── Job polling — auto-connect waiting jobs ───────────────────────────────────
async function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    const config = await getConfig();
    if (!config.apiSecret) { console.log('[poller] no secret — skipping'); return; }
    console.log(`[poller] started | ${config.apiUrl}`);

    pollInterval = setInterval(async () => {
        try {
            const cfg      = await getConfig();
            const uuid = await getClientId();
            const res  = await fetch(`${cfg.apiUrl}/jobs?uuid=${uuid}`, {
                headers: { 'Authorization': `Bearer ${cfg.apiSecret}` },
            });
            if (!res.ok) return;
            const jobs = await res.json();
            if (!Array.isArray(jobs)) return;

            const waitingJobs = jobs.filter(j => j.status === 'waiting');

            for (const job of waitingJobs) {
                if (autoConnected.has(job.id)) continue;
                if (activeBridges.has(job.id)) continue;
                if (manuallyDisconnected.has(job.id)) continue;
                if (reconnecting.has(job.id)) continue; // mid-navigation reconnect

                console.log(`[poller] auto-connecting job: ${job.id}`);
                autoConnected.add(job.id);
                notifyPopup('AUTO_CONNECTING', { jobId: job.id });

                startBridge(job.id).catch(err => {
                    console.error(`[poller] auto-connect failed for job ${job.id}:`, err.message);
                    autoConnected.delete(job.id);
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
                const uuid = await getClientId();
                sendResponse({
                    bridges:  Array.from(activeBridges.values()).map(b => ({ jobId: b.jobId, tabId: b.tabId })),
                    polling:  pollInterval !== null,
                    uuid,
                });

            } else if (msg.type === 'GET_UUID') {
                const uuid = await getClientId();
                sendResponse({ uuid });

            } else if (msg.type === 'RESET_UUID') {
                const uuid = await resetClientId();
                sendResponse({ uuid });

            } else if (msg.type === 'START_BRIDGE') {
                await startBridge(msg.jobId);
                sendResponse({ ok: true });

            } else if (msg.type === 'STOP_BRIDGE') {
                await stopBridge(msg.jobId, true);
                sendResponse({ ok: true });

            } else if (msg.type === 'FOCUS_TAB') {
                const bridge = activeBridges.get(msg.jobId);
                if (!bridge) { sendResponse({ ok: false, error: 'No active bridge' }); return; }
                try {
                    const t = await chrome.tabs.get(bridge.tabId);
                    await chrome.tabs.update(bridge.tabId, { active: true });
                    await chrome.windows.update(t.windowId, { focused: true });
                    sendResponse({ ok: true });
                } catch (err) { sendResponse({ ok: false, error: err.message }); }

            } else if (msg.type === 'DETACH_DEBUGGER') {
                // Detach debugger from all active tabs — hides the banner
                const errors = [];
                for (const [jobId, bridge] of activeBridges) {
                    try {
                        await chrome.debugger.detach({ tabId: bridge.tabId });
                        bridge.debuggerAttached = false;
                        console.log(`[bridge] debugger detached (manual) | tab ${bridge.tabId}`);
                    } catch (err) {
                        errors.push(err.message);
                    }
                }
                sendResponse(errors.length ? { ok: false, error: errors.join(', ') } : { ok: true });

            } else if (msg.type === 'ATTACH_DEBUGGER') {
                const errors = [];
                for (const [jobId, bridge] of activeBridges) {
                    try {
                        await chrome.debugger.attach({ tabId: bridge.tabId }, '1.3');
                        await chrome.debugger.sendCommand({ tabId: bridge.tabId }, 'Page.enable', {});
                        await chrome.debugger.sendCommand({ tabId: bridge.tabId }, 'Runtime.enable', {});
                        await chrome.debugger.sendCommand({ tabId: bridge.tabId }, 'Network.enable', {});
                        bridge.debuggerAttached = true;
                        console.log(`[bridge] debugger re-attached (manual) | tab ${bridge.tabId}`);
                    } catch (err) {
                        errors.push(err.message);
                    }
                }
                sendResponse(errors.length ? { ok: false, error: errors.join(', ') } : { ok: true });

            } else if (msg.type === 'RESUME_JOB') {
                await resumeJob(msg.jobId);
                sendResponse({ ok: true });

            } else if (msg.type === 'CLOSE_TAB') {
                const bridge = activeBridges.get(msg.jobId);
                // Try bridge tabId first, fallback to stored tabId
                const tabId = bridge?.tabId || tabRegistry.get(msg.jobId);
                if (tabId) {
                    try { await chrome.debugger.detach({ tabId }); } catch {}
                    await chrome.tabs.remove(tabId).catch(() => {});
                    tabRegistry.delete(msg.jobId);
                }
                if (bridge) await stopBridge(msg.jobId);
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

startPolling();

// ── Open side panel on icon click ────────────────────────────────────────────
chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId });
});