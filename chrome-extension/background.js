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
            const timeout   = params.timeout  || 120000;
            const confirmed = params.confirmed || false;
            const mins      = Math.round(timeout / 60000);

            // Show instruction banner on bot tab
            chrome.scripting.executeScript({
                target: { tabId },
                func: (mins, confirm) => {
                    document.getElementById('__sam-scraper-banner')?.remove();
                    const b = document.createElement('div');
                    b.id = '__sam-scraper-banner';
                    b.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#1e40af;color:#fff;font-family:-apple-system,sans-serif;font-size:13px;font-weight:600;padding:12px 16px;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,0.3);max-width:320px;';
                    b.innerHTML = `<div style="font-size:11px;opacity:0.8;margin-bottom:2px;">SAM Scraper</div><div>🔍 Select the correct deed PDF</div><div style="font-size:11px;font-weight:400;margin-top:4px;opacity:0.9;">Click <b>View Image</b> on the correct record.${confirm ? ' You will be asked to confirm.' : ''} Timeout: ${mins} min.</div>`;
                    b.onclick = () => b.remove();
                    document.body.appendChild(b);
                    setTimeout(() => b.remove(), mins * 60 * 1000);
                },
                args: [mins, confirmed],
            }).catch(() => {});

            // Intercept PDF via Page.navigatedWithinDocument or new tab navigation
            // Strategy: watch for window.open / target=new clicks via CDP
            // and capture the URL before it opens, then fetch via page context
            const pdfUrl = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    chrome.debugger.onEvent.removeListener(onEvent);
                    reject(new Error(`Wait download timeout — no PDF captured within ${mins} minutes`));
                }, timeout);

                // Intercept new tab requests via CDP Target events
                chrome.debugger.sendCommand({ tabId }, 'Target.setDiscoverTargets', { discover: true }).catch(() => {});

                async function onEvent(source, method, eventParams) {
                    // Catch window.open / target=_new navigation via Target
                    if (method === 'Target.targetCreated') {
                        const info = eventParams.targetInfo;
                        if (info.type === 'page' && info.url && info.url !== 'about:blank') {
                            const url = info.url;
                            if (url.includes('/orisearch/') || url.includes('/image') || url.includes('.pdf')) {
                                chrome.debugger.onEvent.removeListener(onEvent);
                                clearTimeout(timer);
                                // Close the new tab — we'll fetch the PDF ourselves
                                chrome.tabs.query({}, (tabs) => {
                                    const newTab = tabs.find(t => t.url === url || t.id.toString() === info.targetId);
                                    if (newTab) chrome.tabs.remove(newTab.id).catch(() => {});
                                });
                                resolve(url);
                            }
                        }
                    }

                    // Also catch via Network on bot tab (some sites load PDF in same tab)
                    if (source.tabId !== tabId) return;
                    if (method === 'Network.responseReceived') {
                        const mime = eventParams.response?.mimeType || '';
                        const url  = eventParams.response?.url     || '';
                        if (mime.includes('pdf') || mime.includes('octet-stream')) {
                            chrome.debugger.onEvent.removeListener(onEvent);
                            clearTimeout(timer);
                            resolve(url);
                        }
                    }
                    // Catch navigation to image URL
                    if (method === 'Page.frameNavigated') {
                        const url = eventParams.frame?.url || '';
                        if (url.includes('/orisearch/s/image') || url.includes('.pdf')) {
                            chrome.debugger.onEvent.removeListener(onEvent);
                            clearTimeout(timer);
                            resolve(url);
                        }
                    }
                }
                chrome.debugger.onEvent.addListener(onEvent);
            });

            console.log(`[bridge] wait-download intercepted URL: ${pdfUrl}`);

            if (confirmed) {
                // Show confirm banner on bot tab
                chrome.tabs.update(tabId, { active: true }).catch(() => {});
                await chrome.scripting.executeScript({
                    target: { tabId },
                    func: (filename) => {
                        document.getElementById('__sam-scraper-banner')?.remove();
                        document.getElementById('__sam-dl-confirm')?.remove();
                        window.__samDlResult = null;
                        const b = document.createElement('div');
                        b.id = '__sam-dl-confirm';
                        b.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#1a1a1a;color:#fff;font-family:-apple-system,sans-serif;font-size:13px;padding:14px 18px;border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,0.4);max-width:340px;';
                        b.innerHTML = `<div style="font-size:11px;opacity:0.7;margin-bottom:4px;">SAM Scraper</div><div style="font-weight:600;margin-bottom:4px;">📄 PDF Ready to Download</div><div style="font-size:11px;opacity:0.8;margin-bottom:10px;">${filename}</div><div style="font-size:11px;opacity:0.7;margin-bottom:10px;">Is this the correct deed?</div><div style="display:flex;gap:8px;"><button id="__sam-yes" style="flex:1;padding:7px;background:#16a34a;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">✓ Yes, download</button><button id="__sam-no" style="flex:1;padding:7px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">✗ Try another</button></div>`;
                        document.body.appendChild(b);
                        document.getElementById('__sam-yes')?.addEventListener('click', () => { b.remove(); window.__samDlResult = 'yes'; });
                        document.getElementById('__sam-no')?.addEventListener('click',  () => { b.remove(); window.__samDlResult = 'no';  });
                    },
                    args: [pdfUrl.split('/').pop() || 'deed.pdf'],
                }).catch(() => {});

                const decision = await new Promise(res => {
                    const poll = setInterval(async () => {
                        const r = await chrome.scripting.executeScript({
                            target: { tabId },
                            func:   () => window.__samDlResult,
                        }).catch(() => [{ result: null }]);
                        const val = r?.[0]?.result;
                        if (val === 'yes') { clearInterval(poll); res('yes'); }
                        if (val === 'no')  { clearInterval(poll); res('no');  }
                    }, 500);
                    setTimeout(() => { clearInterval(poll); res('yes'); }, 300000);
                });

                if (decision === 'no') {
                    // Try again — re-run waitDownload recursively
                    return executeCommand(jobId, tabId, 'waitDownload', params);
                }
            }

            // Fetch PDF via page context (uses session cookies, no new tab needed)
            const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression: `(async function(){
                    const url = new URL(${JSON.stringify(pdfUrl)}, location.href).href;
                    const r = await fetch(url, { credentials: 'include', headers: { 'Referer': location.href } });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    const buf = await r.arrayBuffer();
                    const u   = new Uint8Array(buf);
                    let b = '';
                    for (let i = 0; i < u.length; i += 8192)
                        b += String.fromCharCode(...u.subarray(i, i + 8192));
                    return JSON.stringify({ base64: btoa(b), size: u.length });
                })()`,
                awaitPromise:  true,
                returnByValue: true,
            });

            if (res.exceptionDetails) throw new Error(res.exceptionDetails?.exception?.description || 'PDF fetch failed');
            const parsed = JSON.parse(res.result?.value || '{}');
            if (!parsed.base64) throw new Error('PDF fetch returned empty');

            console.log(`[bridge] wait-download fetched ${parsed.size} bytes from ${pdfUrl}`);
            return { ok: true, base64: parsed.base64, url: pdfUrl };
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

        case 'showResultsModal': {
            const { results, columns, label, timeout: modalTimeout } = params;

            const selectedHref = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    chrome.scripting.executeScript({
                        target: { tabId },
                        func: () => document.getElementById('__sam-results-modal')?.remove(),
                    }).catch(() => {});
                    reject(new Error('Results modal timeout — no selection made'));
                }, modalTimeout || 300000);

                chrome.scripting.executeScript({
                    target: { tabId },
                    func: (results, columns, label) => {
                        document.getElementById('__sam-results-modal')?.remove();
                        window.__samModalResult = null;

                        const overlay = document.createElement('div');
                        overlay.id = '__sam-results-modal';
                        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

                        const modal = document.createElement('div');
                        modal.style.cssText = 'background:#fff;border-radius:12px;width:min(90vw,800px);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.4);overflow:hidden;';

                        // Header
                        const header = document.createElement('div');
                        header.style.cssText = 'background:#1a1a1a;color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;';
                        header.innerHTML = `
                            <div>
                                <div style="font-weight:700;font-size:15px;">🔍 Select the Correct Deed</div>
                                <div style="font-size:11px;opacity:0.7;margin-top:2px;">${label || ''} — ${results.length} result${results.length !== 1 ? 's' : ''} found</div>
                            </div>
                            <button id="__sam-modal-close" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;opacity:0.7;padding:4px 8px;line-height:1;">✕</button>
                        `;

                        // Body
                        const body = document.createElement('div');
                        body.style.cssText = 'overflow-y:auto;flex:1;';

                        const table = document.createElement('table');
                        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';

                        // Build thead from columns config
                        const thead = document.createElement('thead');
                        const headerRow = document.createElement('tr');
                        headerRow.style.cssText = 'background:#f5f5f5;border-bottom:2px solid #e5e5e5;position:sticky;top:0;';
                        columns.forEach(col => {
                            const th = document.createElement('th');
                            th.style.cssText = 'padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#666;font-weight:600;white-space:nowrap;';
                            th.textContent = col.label;
                            headerRow.appendChild(th);
                        });
                        const thAction = document.createElement('th');
                        thAction.style.cssText = 'padding:10px 14px;';
                        headerRow.appendChild(thAction);
                        thead.appendChild(headerRow);
                        table.appendChild(thead);

                        // Build tbody from results
                        const tbody = document.createElement('tbody');
                        results.forEach((row) => {
                            const tr = document.createElement('tr');
                            tr.style.cssText = 'border-bottom:1px solid #f0f0f0;transition:background 0.1s;';
                            tr.addEventListener('mouseenter', () => tr.style.background = '#f8f8f8');
                            tr.addEventListener('mouseleave', () => tr.style.background = '');

                            columns.forEach(col => {
                                const td = document.createElement('td');
                                td.style.cssText = `padding:12px 14px;${col.style || ''}`;
                                const val = row[col.key] || '';
                                if (col.badge && val) {
                                    // T = Grantee (blue), F = Grantor (yellow), others = gray
                                    const colors = val === 'T'
                                        ? 'background:#dbeafe;color:#1d4ed8;'
                                        : val === 'F'
                                            ? 'background:#fef3c7;color:#92400e;'
                                            : 'background:#f3f4f6;color:#374151;';
                                    const label2 = val === 'T' ? 'Grantee' : val === 'F' ? 'Grantor' : val;
                                    td.innerHTML = `<span style="${colors}padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;">${label2}</span>`;
                                } else {
                                    td.textContent = val;
                                }
                                tr.appendChild(td);
                            });

                            // Download (preview) + This is the Deed buttons
                            const tdAction = document.createElement('td');
                            tdAction.style.cssText = 'padding:10px 14px;text-align:center;white-space:nowrap;';

                            const btnDownload = document.createElement('button');
                            btnDownload.textContent = 'Download';
                            btnDownload.style.cssText = 'background:#f3f4f6;color:#374151;border:1px solid #d1d5db;padding:5px 12px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;margin-right:6px;';
                            btnDownload.addEventListener('mouseenter', () => btnDownload.style.background = '#e5e7eb');
                            btnDownload.addEventListener('mouseleave', () => btnDownload.style.background = '#f3f4f6');
                            btnDownload.addEventListener('click', async (e) => {
                                e.stopPropagation();
                                btnDownload.textContent = 'Opening…';
                                btnDownload.disabled = true;
                                try {
                                    const pdfUrl = new URL(row.href, location.href).href;
                                    const res    = await fetch(pdfUrl, { credentials: 'include', headers: { 'Referer': location.href } });
                                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                    const blob    = await res.blob();
                                    const blobUrl = URL.createObjectURL(blob);
                                    window.open(blobUrl, '_blank');
                                    // Revoke after short delay
                                    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
                                } catch (err) {
                                    alert(`Preview failed: ${err.message}`);
                                } finally {
                                    btnDownload.textContent = 'Download';
                                    btnDownload.disabled = false;
                                }
                            });

                            const btnConfirm = document.createElement('button');
                            btnConfirm.textContent = '✓ This is the Deed';
                            btnConfirm.style.cssText = 'background:#16a34a;color:#fff;border:none;padding:5px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;';
                            btnConfirm.addEventListener('mouseenter', () => btnConfirm.style.background = '#15803d');
                            btnConfirm.addEventListener('mouseleave', () => btnConfirm.style.background = '#16a34a');
                            btnConfirm.addEventListener('click', (e) => {
                                e.stopPropagation();
                                document.getElementById('__sam-preview-frame')?.remove();
                                overlay.remove();
                                window.__samModalResult = row.href;
                            });

                            tdAction.appendChild(btnDownload);
                            tdAction.appendChild(btnConfirm);
                            tr.appendChild(tdAction);
                            tbody.appendChild(tr);
                        });

                        table.appendChild(tbody);
                        body.appendChild(table);
                        modal.appendChild(header);
                        modal.appendChild(body);
                        overlay.appendChild(modal);
                        document.body.appendChild(overlay);

                        document.getElementById('__sam-modal-close')?.addEventListener('click', () => {
                            overlay.remove();
                            window.__samModalResult = '__cancelled__';
                        });
                    },
                    args: [results, columns || [], label || ''],
                }).catch(() => {});

                // Poll for selection
                const poll = setInterval(async () => {
                    const r = await chrome.scripting.executeScript({
                        target: { tabId },
                        func:   () => window.__samModalResult,
                    }).catch(() => [{ result: null }]);
                    const val = r?.[0]?.result;
                    if (val === '__cancelled__') {
                        clearInterval(poll); clearTimeout(timer);
                        reject(new Error('Researcher cancelled selection'));
                    } else if (val) {
                        clearInterval(poll); clearTimeout(timer);
                        resolve(val);
                    }
                }, 500);
            });

            return { ok: true, href: selectedHref };
        }


        case 'injectBanner': {
            const { title, message, type } = params;
            const isCaptcha  = type === 'captcha';
            const isComplete = type === 'complete';
            const isStart    = type === 'start';
            const bgColor    = isCaptcha ? '#dc2626' : isComplete ? '#16a34a' : isStart ? '#1e40af' : '#d97706';
            const icon       = isCaptcha ? '🤖' : isComplete ? '✅' : isStart ? '🚀' : '⏸';
            const pulse      = isCaptcha ? 'animation:__sam-pulse 1.2s ease-in-out infinite;' : '';

            // Inject into all active tabs
            const tabs = await chrome.tabs.query({ active: true });
            for (const t of tabs) {
                if (t.url?.startsWith('chrome://') || t.url?.startsWith('chrome-extension://')) continue;
                chrome.scripting.executeScript({
                    target: { tabId: t.id },
                    func: (title, message, bgColor, icon, pulse) => {
                        document.getElementById('__sam-scraper-banner')?.remove();
                        const banner = document.createElement('div');
                        banner.id = '__sam-scraper-banner';
                        banner.style.cssText = `
                            position:fixed;top:16px;right:16px;z-index:2147483647;
                            background:${bgColor};color:#fff;
                            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                            font-size:13px;font-weight:600;
                            padding:12px 16px;border-radius:10px;
                            box-shadow:0 4px 24px rgba(0,0,0,0.3);
                            max-width:320px;cursor:pointer;
                            animation:__sam-slidein 0.3s ease;${pulse}
                        `;
                        banner.innerHTML = `
                            <style>
                                @keyframes __sam-slidein{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:translateY(0)}}
                                @keyframes __sam-pulse{0%,100%{opacity:1}50%{opacity:0.7}}
                            </style>
                            <div style="display:flex;align-items:flex-start;gap:8px;">
                                <span style="font-size:18px;flex-shrink:0;">${icon}</span>
                                <div style="flex:1;">
                                    <div style="font-size:11px;opacity:0.85;margin-bottom:2px;">SAM Scraper</div>
                                    <div>${title}</div>
                                    <div style="font-size:11px;font-weight:400;margin-top:3px;opacity:0.9;">${message}</div>
                                </div>
                                <span style="font-size:16px;opacity:0.7;cursor:pointer;flex-shrink:0;" onclick="this.closest('#__sam-scraper-banner').remove()">✕</span>
                            </div>
                        `;
                        banner.onclick = (e) => { if (e.target.tagName !== 'SPAN') banner.remove(); };
                        document.body.appendChild(banner);
                        setTimeout(() => banner.remove(), 30000);
                    },
                    args: [title, message, bgColor, icon, pulse],
                }).catch(() => {});
            }

            // Fire OS notification for start events
            if (type === 'start') {
                const startNotifId = `sam-start-${jobId}`;
                chrome.notifications.create(startNotifId, {
                    type:     'basic',
                    iconUrl:  'icons/icon48.png',
                    title:    '🚀 SAM Scraper — Started',
                    message:  message || 'Scraping has begun',
                    priority: 1,
                });

                // Click → store jobId and open popup
                const startHandler = async (clickedId) => {
                    if (clickedId !== startNotifId) return;
                    chrome.notifications.onClicked.removeListener(startHandler);
                    chrome.notifications.clear(startNotifId);
                    await chrome.storage.local.set({ __samFocusJobId: jobId });
                    chrome.tabs.update(tabId, { active: true }).catch(() => {});
                    const tab = await chrome.tabs.get(tabId).catch(() => null);
                    if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
                };
                chrome.notifications.onClicked.addListener(startHandler);

                // Auto-clear after 5s
                setTimeout(() => chrome.notifications.clear(startNotifId), 5000);
            }

            return { ok: true };
        }

        case 'notifyHandoff': {
            const bridge    = activeBridges.get(jobId);
            if (bridge) bridge.pendingHandoff = params.message || 'Action required';
            notifyPopup('HANDOFF_REQUIRED', { jobId, tabId, message: params.message });

            const isCaptcha = (params.message || '').toLowerCase().includes('captcha');
            const title     = isCaptcha ? 'CAPTCHA Detected!' : 'Action Required';
            const message   = params.message || 'Please complete the required action';
            const type      = isCaptcha ? 'captcha' : 'handoff';
            const notifId   = `sam-handoff-${jobId}`;

            // OS notification — clicking focuses tab + shows resume modal
            chrome.notifications.create(notifId, {
                type:               'basic',
                iconUrl:            'icons/icon48.png',
                title:              `SAM Scraper — ${title}`,
                message,
                priority:           2,
                requireInteraction: isCaptcha, // stay visible for CAPTCHA
            });

            // Click notification → focus tab + open popup with job selected
            const notifHandler = async (clickedId) => {
                if (clickedId !== notifId) return;
                chrome.notifications.onClicked.removeListener(notifHandler);
                chrome.notifications.clear(notifId);

                // Store jobId so popup auto-selects it on open
                await chrome.storage.local.set({ __samFocusJobId: jobId });

                // Focus the bot tab
                chrome.tabs.update(tabId, { active: true }).catch(() => {});
                const tab = await chrome.tabs.get(tabId).catch(() => null);
                if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});

                if (isCaptcha) {
                    // Inject CAPTCHA resume modal into bot tab
                    chrome.scripting.executeScript({
                        target: { tabId },
                        func: (msg) => {
                            document.getElementById('__sam-resume-modal')?.remove();
                            const overlay = document.createElement('div');
                            overlay.id = '__sam-resume-modal';
                            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;';
                            overlay.innerHTML = `
                                <div style="background:#fff;border-radius:12px;padding:28px 32px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center;">
                                    <div style="font-size:36px;margin-bottom:12px;">🤖</div>
                                    <div style="font-weight:700;font-size:16px;margin-bottom:8px;">CAPTCHA Detected</div>
                                    <div style="font-size:13px;color:#555;margin-bottom:20px;">${msg}</div>
                                    <div style="font-size:12px;color:#888;margin-bottom:20px;">Solve the CAPTCHA on the page, then click Resume below.</div>
                                    <button id="__sam-resume-btn" style="background:#16a34a;color:#fff;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;width:100%;">✓ Resume</button>
                                </div>
                            `;
                            document.body.appendChild(overlay);
                            document.getElementById('__sam-resume-btn')?.addEventListener('click', () => {
                                overlay.remove();
                                window.__samResumeClicked = true;
                            });
                        },
                        args: [message],
                    }).catch(() => {});

                    // Poll for resume click
                    const resumePoll = setInterval(async () => {
                        const r = await chrome.scripting.executeScript({
                            target: { tabId },
                            func:   () => window.__samResumeClicked,
                        }).catch(() => [{ result: null }]);
                        if (r?.[0]?.result) {
                            clearInterval(resumePoll);
                            await chrome.scripting.executeScript({
                                target: { tabId },
                                func:   () => { window.__samResumeClicked = false; },
                            }).catch(() => {});
                            // Fire resume via the jobs API
                            const cfg = await getConfig();
                            fetch(`${cfg.apiUrl}/jobs/${jobId}/resume`, {
                                method:  'POST',
                                headers: { 'Authorization': `Bearer ${cfg.apiSecret}` },
                            }).catch(() => {});
                        }
                    }, 500);

                    // Stop polling after 10 minutes
                    setTimeout(() => clearInterval(resumePoll), 600000);
                }
            };
            chrome.notifications.onClicked.addListener(notifHandler);

            // Inject banner as well
            await executeCommand(jobId, { action: 'injectBanner', params: { title, message, type } }, jobId);
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

    // Subscribe/re-subscribe to push notifications
    // (removed — using banner injection instead)

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
// Popup opens automatically when extension icon is clicked (defined in manifest)