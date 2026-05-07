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
let pollInterval         = null;
let autoConnected        = new Set();
const manuallyDisconnected = new Set(); // jobs user explicitly disconnected // track jobs we already auto-connected

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
    await fetch(`${config.apiUrl}/jobs/${jobId}/bridge-ready`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiSecret}` },
        body:    JSON.stringify({ tabId, bridgePort: config.bridgePort }),
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
        stopBridge(jobId);
    };

    ws.onerror = () => {
        console.error(`[bridge] WS error | job: ${jobId}`);
        stopBridge(jobId);
    };

    // Forward CDP events → Node
    chrome.debugger.onEvent.addListener((source, method, params) => {
        const bridge = activeBridges.get(jobId);
        if (source.tabId === tabId && bridge?.ws?.readyState === WebSocket.OPEN) {
            bridge.ws.send(JSON.stringify({ type: 'event', method, params }));
        }
    });

    // Auto-reattach on unexpected detach
    chrome.debugger.onDetach.addListener(async (source, reason) => {
        if (source.tabId !== tabId) return;
        if (!activeBridges.has(jobId)) return;
        if (reason === 'target_closed') { stopBridge(jobId); return; }
        console.log(`[bridge] debugger detached (${reason}) — reattaching tab ${tabId}...`);
        try {
            await new Promise(r => setTimeout(r, 500));
            await chrome.debugger.attach({ tabId }, '1.3');
            await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
            await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
            console.log(`[bridge] debugger re-attached | tab ${tabId}`);
        } catch (err) {
            console.error('[bridge] re-attach failed:', err.message);
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

        case 'downloadnewtab': {
            // Find the most recently opened tab (the PDF viewer tab)
            // We look for a tab that was opened after our bot tab
            const allTabs = await chrome.tabs.query({});

            // Sort by id descending — newest tab has highest id
            const sortedTabs = allTabs
                .filter(t => t.id !== tabId) // not our bot tab
                .sort((a, b) => b.id - a.id);

            let pdfTab = sortedTabs[0]; // most recently opened tab

            // If no other tab yet, wait for one to appear
            if (!pdfTab || pdfTab.status !== 'complete') {
                pdfTab = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('New tab timeout — PDF tab did not open')), 15000);

                    // Check for existing loading tabs first
                    chrome.tabs.query({}, (tabs) => {
                        const candidate = tabs
                            .filter(t => t.id !== tabId)
                            .sort((a, b) => b.id - a.id)[0];
                        if (candidate) {
                            if (candidate.status === 'complete') {
                                clearTimeout(timer);
                                resolve(candidate);
                                return;
                            }
                            // Wait for it to finish loading
                            function onUpdated(updatedTabId, info) {
                                if (updatedTabId === candidate.id && info.status === 'complete') {
                                    chrome.tabs.onUpdated.removeListener(onUpdated);
                                    clearTimeout(timer);
                                    chrome.tabs.get(candidate.id, resolve);
                                }
                            }
                            chrome.tabs.onUpdated.addListener(onUpdated);
                        } else {
                            // No tab yet — wait for creation
                            function onCreated(tab) {
                                chrome.tabs.onCreated.removeListener(onCreated);
                                function onUpdated(updatedTabId, info) {
                                    if (updatedTabId === tab.id && info.status === 'complete') {
                                        chrome.tabs.onUpdated.removeListener(onUpdated);
                                        clearTimeout(timer);
                                        chrome.tabs.get(tab.id, resolve);
                                    }
                                }
                                chrome.tabs.onUpdated.addListener(onUpdated);
                            }
                            chrome.tabs.onCreated.addListener(onCreated);
                        }
                    });
                });
            }

            const pdfUrl = pdfTab.url;
            console.log(`[bridge] downloading from tab: ${pdfUrl}`);

            // Close the PDF tab
            await chrome.tabs.remove(pdfTab.id).catch(() => {});

            // Download using extension fetch (has session cookies)
            const response = await fetch(pdfUrl);
            if (!response.ok) throw new Error(`Download failed: ${response.status} ${pdfUrl}`);

            const buffer = await response.arrayBuffer();
            // Convert to base64 in chunks to avoid call stack overflow on large files
            const bytes   = new Uint8Array(buffer);
            const chunkSize = 8192;
            let binary = '';
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
            }
            const base64 = btoa(binary);

            return { ok: true, base64, url: pdfUrl, savePath: params.savePath };
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
            const cfg  = await getConfig();
            const res  = await fetch(`${cfg.apiUrl}/jobs`, {
                headers: { 'Authorization': `Bearer ${cfg.apiSecret}` },
            });
            if (!res.ok) return;
            const jobs = await res.json();
            if (!Array.isArray(jobs)) return;

            const waitingJobs = jobs.filter(j => j.status === 'waiting');

            for (const job of waitingJobs) {
                if (autoConnected.has(job.id)) continue;
                if (activeBridges.has(job.id)) continue;
                if (manuallyDisconnected.has(job.id)) continue; // skip manually disconnected

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
                sendResponse({
                    bridges: Array.from(activeBridges.values()).map(b => ({ jobId: b.jobId, tabId: b.tabId })),
                    polling: pollInterval !== null,
                });

            } else if (msg.type === 'START_BRIDGE') {
                await startBridge(msg.jobId);
                sendResponse({ ok: true });

            } else if (msg.type === 'STOP_BRIDGE') {
                await stopBridge(msg.jobId, true); // manual disconnect
                sendResponse({ ok: true });

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
                // Re-attach debugger to all active tabs
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