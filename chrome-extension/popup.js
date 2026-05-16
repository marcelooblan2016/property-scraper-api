/**
 * popup.js — SAM Scraper Extension Popup / Side Panel
 * - 3 tabs keyed by propertyId
 * - Per-tab live log feed via WebSocket
 * - Auto-refresh every 3s
 */

// ── State ─────────────────────────────────────────────────────────────────────
let activeTab        = 0;
let debuggerAttached = true;
let logSockets       = {}; // jobId → WebSocket
let logBuffers       = {}; // jobId → string[]
let historyLoaded    = {}; // jobId → bool — prevents re-fetching on every render
const MAX_LOG_LINES  = 150;

function updateNotifBanner(permission) {
    const existing = document.getElementById('notifBanner');
    if (permission === 'granted') {
        existing?.remove();
        return;
    }
    if (existing) return; // already showing

    const banner = document.createElement('div');
    banner.id = 'notifBanner';
    banner.style.cssText = `
        background: ${permission === 'denied' ? '#fee2e2' : '#fef9c3'};
        border-bottom: 1px solid ${permission === 'denied' ? '#fca5a5' : '#fde68a'};
        padding: 10px 16px;
        font-size: 11px;
        color: ${permission === 'denied' ? '#991b1b' : '#92400e'};
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    `;

    if (permission === 'denied') {
        banner.innerHTML = `
            <span>🔕 Notifications blocked — you won't be alerted for CAPTCHA or handoffs.</span>
            <a href="chrome://settings/content/notifications" style="color:inherit;font-weight:600;white-space:nowrap;text-decoration:underline;" target="_blank">Fix</a>
        `;
    } else {
        banner.innerHTML = `
            <span>🔔 Allow notifications to get CAPTCHA alerts</span>
            <button id="notifAllowBtn" style="font-size:11px;padding:3px 10px;border:1px solid #d97706;border-radius:4px;background:#fff;cursor:pointer;color:#92400e;white-space:nowrap;">Allow</button>
        `;
        banner.querySelector('#notifAllowBtn')?.addEventListener('click', () => {
            Notification.requestPermission().then(p => updateNotifBanner(p));
        });
    }

    // Insert after header
    const header = document.querySelector('.header');
    header?.insertAdjacentElement('afterend', banner);
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
    const data = await chrome.storage.local.get(['apiUrl', 'apiSecret', 'bridgePort']);
    const apiUrl    = data.apiUrl     || '';
    const apiSecret = data.apiSecret  || '';
    const bridgePort = data.bridgePort || 9223;
    if (document.getElementById('apiUrl'))     document.getElementById('apiUrl').value     = apiUrl;
    if (document.getElementById('apiSecret'))  document.getElementById('apiSecret').value  = apiSecret;
    if (document.getElementById('bridgePort')) document.getElementById('bridgePort').value = bridgePort;
    // Show settings drawer automatically if not configured
    if (!apiSecret) {
        document.getElementById('settingsDrawer')?.classList.add('open');
    }
}

async function saveSettings() {
    const apiUrl     = document.getElementById('apiUrl').value.trim();
    const apiSecret  = document.getElementById('apiSecret').value.trim();
    const bridgePort = parseInt(document.getElementById('bridgePort').value) || 9223;
    if (!apiUrl || !apiSecret) { showToast('API URL and Secret are required', 'error'); return; }
    await chrome.storage.local.set({ apiUrl, apiSecret, bridgePort });
    document.getElementById('settingsDrawer')?.classList.remove('open');
    chrome.runtime.sendMessage({ type: 'STOP_POLLING' }, () => {
        chrome.runtime.sendMessage({ type: 'START_POLLING' }, () => {
            updateStatusPill();
            refreshJobs();
        });
    });
    showToast('Saved ✓');
}

// ── Status pill ───────────────────────────────────────────────────────────────
async function updateStatusPill() {
    const pill      = document.getElementById('statusPill');
    const statusTxt = document.getElementById('statusText');
    const pollingDot = document.getElementById('pollingDot');
    const pollingStatus = document.getElementById('pollingStatus');
    if (!pill) return;

    const state    = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve));
    const bridges  = state?.bridges || [];
    const polling  = state?.polling;
    const data     = await chrome.storage.local.get(['apiSecret']);

    if (!data.apiSecret) {
        setPill(pill, statusTxt, 'stopped', 'Not configured');
    } else if (!polling) {
        setPill(pill, statusTxt, 'stopped', 'Not connected');
    } else if (bridges.length > 0) {
        setPill(pill, statusTxt, 'connected', `${bridges.length} active`);
    } else {
        setPill(pill, statusTxt, 'polling', 'Polling...');
    }

    // Also update legacy pollingDot if present
    if (pollingDot && pollingStatus) {
        pollingDot.className = polling ? 'status-dot polling' : 'status-dot';
        pollingStatus.textContent = polling ? `polling · ${bridges.length} active` : 'stopped';
    }
}

function setPill(pill, txt, state, label) {
    pill.className  = `status-pill ${state}`;
    txt.textContent = label;
}

// ── Log WebSocket ─────────────────────────────────────────────────────────────
async function connectLogSocket(jobId, jobStatus) {
    const isDone = ['completed', 'failed'].includes(jobStatus);

    // Load history once if buffer is empty and not already loading
    if (!logBuffers[jobId]?.length && !historyLoaded[jobId]) {
        historyLoaded[jobId] = true; // mark immediately to prevent parallel fetches
        await fetchLogHistory(jobId);
    }

    // For completed/failed jobs — no WS needed
    if (isDone) return;

    // Already connected
    if (logSockets[jobId]?.readyState === WebSocket.OPEN) return;

    const data      = await chrome.storage.local.get(['apiUrl', 'apiSecret']);
    const apiUrl    = data.apiUrl    || 'http://localhost:4000';
    const apiSecret = data.apiSecret || '';
    const wsUrl     = apiUrl.replace(/^http/, 'ws') + `/logs?jobId=${jobId}&token=${apiSecret}`;

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log(`[log] connected for job: ${jobId}`);
        logSockets[jobId] = ws;
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            const line = formatLogLine(msg);
            if (!line) return;
            if (!logBuffers[jobId]) logBuffers[jobId] = [];
            logBuffers[jobId].push(line);
            if (logBuffers[jobId].length > MAX_LOG_LINES) logBuffers[jobId].shift();
            renderLogIfActive(jobId);
        } catch {}
    };

    ws.onclose = () => {
        delete logSockets[jobId];
        // Fetch history so logs persist after job completes
        if (!historyLoaded[jobId] || logBuffers[jobId]?.length === 0) {
            historyLoaded[jobId] = false; // allow one more fetch
            fetchLogHistory(jobId);
        }
    };

    ws.onerror = () => {
        delete logSockets[jobId];
    };
}

async function fetchLogHistory(jobId) {
    try {
        const data      = await chrome.storage.local.get(['apiUrl', 'apiSecret']);
        const apiUrl    = data.apiUrl    || 'http://localhost:4000';
        const apiSecret = data.apiSecret || '';
        const res = await fetch(`${apiUrl}/jobs/${jobId}/logs`, {
            headers: { 'Authorization': `Bearer ${apiSecret}` },
        });
        if (!res.ok) return;
        const json  = await res.json();
        const lines = Array.isArray(json) ? json : (json.lines || []);
        if (!lines.length) return;
        logBuffers[jobId] = lines.map(l => ({
            time:  new Date(l.timestamp || Date.now()).toLocaleTimeString('en-US', { hour12: false }),
            level: (l.type || 'INFO').toUpperCase(),
            text:  l.message || '',
        })).filter(l => l.text);
        renderLogIfActive(jobId);
    } catch {}
}

function formatLogLine(msg) {
    if (!msg?.type) return null;
    const time  = new Date().toLocaleTimeString('en-US', { hour12: false });
    const level = (msg.type || 'INFO').toUpperCase();
    const text  = msg.message || msg.data || '';
    if (!text) return null;
    return { time, level, text };
}

function disconnectLogSocket(jobId) {
    if (logSockets[jobId]) {
        logSockets[jobId].close();
        delete logSockets[jobId];
    }
}

function renderLogIfActive(jobId) {
    // Only render if the log feed is currently showing this job
    const logEl = document.getElementById('logFeed');
    if (!logEl) return;
    // Check active tab's job matches
    renderLogFeed(jobId);
}

function renderLogFeed(jobId) {
    const logEl = document.getElementById('logFeed');
    if (!logEl) return;

    const lines = logBuffers[jobId] || [];

    // Job switched — clear and reset
    if (logEl.dataset.jobId !== jobId) {
        logEl.dataset.jobId     = jobId;
        logEl.dataset.lineCount = '0';
        logEl.innerHTML         = '';
    }

    if (lines.length === 0) {
        logEl.innerHTML = '<div class="log-empty">No logs yet...</div>';
        return;
    }

    // Compute new lines AFTER potential reset
    const prevCount = parseInt(logEl.dataset.lineCount || '0');
    const newLines  = lines.slice(prevCount);

    // No new lines — do nothing, preserve scroll
    if (newLines.length === 0) return;

    // Check if user is at bottom BEFORE appending
    const isAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;

    // Append only new lines
    const fragment = document.createDocumentFragment();
    for (const l of newLines) {
        const cls = levelClass(l.level);
        const div = document.createElement('div');
        div.className = `log-line ${cls}`;
        div.innerHTML = `<span class="log-time">${l.time}</span><span class="log-level">${l.level}</span><span class="log-text">${escHtml(l.text)}</span>`;
        fragment.appendChild(div);
    }
    logEl.appendChild(fragment);
    logEl.dataset.lineCount = String(lines.length);

    // Only auto-scroll if already at bottom
    if (isAtBottom) {
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function levelClass(level) {
    if (level === 'ERROR')   return 'log-error';
    if (level === 'ACTION')  return 'log-action';
    if (level === 'HANDOFF') return 'log-handoff';
    if (level === 'COMPLETE') return 'log-complete';
    return 'log-info';
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ── Jobs / Tabs ───────────────────────────────────────────────────────────────
let lastJobIds = [];

async function refreshJobs() {
    const data      = await chrome.storage.local.get(['apiUrl', 'apiSecret', 'bridgePort']);
    const apiUrl    = data.apiUrl    || '';
    const apiSecret = data.apiSecret || '';

    const focused = document.activeElement;
    if (focused !== document.getElementById('apiUrl'))     document.getElementById('apiUrl').value    = apiUrl;
    if (focused !== document.getElementById('apiSecret'))  document.getElementById('apiSecret').value = apiSecret;
    if (focused !== document.getElementById('bridgePort')) document.getElementById('bridgePort').value = data.bridgePort || 9223;

    // Not configured — show setup prompt and stop
    if (!apiUrl || !apiSecret) {
        document.getElementById('jobList').innerHTML = `
            <div class="no-secret">
                <strong>Not configured</strong>
                Click ⚙ above to enter your API URL and Secret.
            </div>`;
        document.getElementById('settingsDrawer')?.classList.add('open');
        return;
    }

    try {
        const uuid = await new Promise(resolve => chrome.storage.local.get('uuid', d => resolve(d.uuid || '')));
        const res  = await fetch(`${apiUrl}/jobs?uuid=${uuid}`, { headers: { 'Authorization': `Bearer ${apiSecret}` } });
        const jobs = await res.json();
        const state = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve));
        const activeBridgeIds = new Set((state?.bridges || []).map(b => b.jobId));

        const activeJobs = Array.isArray(jobs)
            ? jobs.filter(j => ['waiting', 'running', 'completed', 'failed'].includes(j.status)).slice(0, 3)
            : [];

        // Connect log sockets for new jobs
        for (const job of activeJobs) {
            if (!logSockets[job.id]) {
                logBuffers[job.id] = logBuffers[job.id] || [];
                connectLogSocket(job.id, job.status);
            }
        }

        // Disconnect sockets for jobs no longer active
        const activeIds = new Set(activeJobs.map(j => j.id));
        for (const jobId of Object.keys(logSockets)) {
            if (!activeIds.has(jobId)) disconnectLogSocket(jobId);
        }

        renderTabs(activeJobs, activeBridgeIds);
    } catch (err) {
        renderTabs([], null, err.message);
    }
}

function renderTabs(jobs, activeBridgeIds = new Set(), errorMsg = null) {
    const container = document.getElementById('jobList');
    if (errorMsg) {
        container.innerHTML = `<div class="empty">Cannot reach API: ${errorMsg}</div>`;
        return;
    }
    if (jobs.length === 0) {
        container.innerHTML = `<div class="empty">No active jobs</div>`;
        return;
    }

    if (activeTab >= jobs.length) activeTab = 0;

    // ── Vertical job list ─────────────────────────────────────────────────────
    const jobListHtml = jobs.map((job, i) => {
        const propertyId = job.propertyId || job.query?.propertyId || '—';
        const label      = propertyId !== '—' ? `79-${propertyId}-47` : job.id.slice(0, 8);
        const isActive   = i === activeTab;
        const bridged    = activeBridgeIds.has(job.id);
        const county     = job.query?.county || '';
        const state      = job.query?.state  || '';
        return `
            <a class="job-list-item ${isActive ? 'active' : ''}" data-tab="${i}" href="#">
                <span class="job-list-dot tag-${job.status}"></span>
                <span class="job-list-body">
                    <span class="job-list-label">${label}</span>
                    <span class="job-list-meta">${county}${county && state ? ', ' : ''}${state}</span>
                </span>
                ${bridged ? '<span class="job-list-bridged">⚡</span>' : ''}
            </a>`;
    }).join('');

    // ── Job detail ────────────────────────────────────────────────────────────
    const job        = jobs[activeTab];
    const bridged    = activeBridgeIds.has(job.id);
    const propertyId = job.propertyId || job.query?.propertyId || '—';
    const label      = propertyId !== '—' ? `79-${propertyId}-47` : job.id.slice(0, 8);
    const county     = job.query?.county || '—';
    const state      = job.query?.state  || '—';
    const isHandoff  = job.status === 'waiting' && bridged;
    const isDone     = ['completed', 'failed'].includes(job.status);
    const s3Url      = job.result?.s3Url || null;

    const logs        = logBuffers[job.id] || [];
    const lastHandoff = [...logs].reverse().find(l => l.level === 'HANDOFF');
    const isCaptcha   = lastHandoff?.text?.toLowerCase().includes('captcha');

    const detail = `
        <div class="job-detail" id="jobDetail">
            <div class="job-detail-row">
                <span class="job-detail-label">Property ID</span>
                <a href="https://titlesearch.afxllc.com/projects/${propertyId}" target="_blank" class="job-detail-link">${label}</a>
            </div>
            <div class="job-detail-row">
                <span class="job-detail-label">County</span>
                <span class="job-detail-value">${county}</span>
            </div>
            <div class="job-detail-row">
                <span class="job-detail-label">State</span>
                <span class="job-detail-value">${state}</span>
            </div>
            <div class="job-detail-row">
                <span class="job-detail-label">Status</span>
                <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                    <span class="tag tag-${job.status}">${job.status}</span>
                    ${bridged ? '<span class="tag" style="background:#dcfce7;color:#16a34a;">⚡ bridged</span>' : ''}
                    ${isHandoff ? '<span class="tag" style="background:#fff7ed;color:#c2410c;">⏸ waiting for you</span>' : ''}
                </div>
            </div>
            ${isHandoff ? `<div class="handoff-banner">⏸ Action required — go to the tab and complete it, then click Resume</div>` : ''}
            ${isCaptcha && isHandoff ? `<div class="captcha-banner">🤖 CAPTCHA detected — please solve it in the tab</div>` : ''}
            ${s3Url ? `
            <div class="s3-result">
                <div class="s3-label">✅ Deed PDF</div>
                <a href="${s3Url}" target="_blank" class="s3-link">${s3Url.split('/').slice(-2).join('/')}</a>
            </div>` : ''}
            <div class="job-actions">
                ${isHandoff ? `<button class="btn btn-warning" data-action="gototab" data-job="${job.id}">Go to Tab</button>` : ''}
                ${isHandoff ? `<button class="btn btn-primary" data-action="resume" data-job="${job.id}">Resume</button>` : ''}
                ${!isHandoff && job.status === 'waiting' && !bridged ? `<button class="btn btn-primary" data-action="connect" data-job="${job.id}">Connect</button>` : ''}
                ${bridged && !isDone ? `<button class="btn btn-secondary" data-action="disconnect" data-job="${job.id}">Disconnect</button>` : ''}
                ${isDone || job.status === 'failed' ? `<button class="btn btn-warning" data-action="restart" data-job="${job.id}">↺ Restart</button>` : ''}
                <button class="btn btn-secondary" data-action="closetab" data-job="${job.id}">Dismiss</button>
            </div>
        </div>
        <div class="log-section">
            <div class="log-header">Live Log</div>
            <div class="log-feed" id="logFeed"></div>
        </div>`;

    // Preserve log feed across refreshes
    const existingList   = container.querySelector('.job-list');
    const existingDetail = container.querySelector('#jobDetail');
    const existingLog    = container.querySelector('#logFeed');

    if (!existingDetail || !existingLog) {
        container.innerHTML = `<div class="job-list">${jobListHtml}</div>${detail}`;
    } else {
        existingList.innerHTML = jobListHtml;
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = detail;
        existingDetail.replaceWith(tempDiv.querySelector('#jobDetail'));
        // logFeed untouched — scroll preserved
    }

    // Job list clicks
    container.querySelectorAll('.job-list-item[data-tab]').forEach(a => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            activeTab = parseInt(a.dataset.tab);
            refreshJobs();
        });
    });

    // Action buttons
    container.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            const jobId  = btn.dataset.job;
            if (action === 'connect')    connectBridge(jobId);
            if (action === 'resume')     resumeJob(jobId);
            if (action === 'disconnect') disconnectBridge(jobId);
            if (action === 'gototab')    gotoTab(jobId);
            if (action === 'closetab')   closeTab(jobId);
            if (action === 'restart')    restartJob(jobId);
        });
    });

    renderLogFeed(job.id);
}

async function restartJob(jobId) {
    const data      = await chrome.storage.local.get(['apiUrl', 'apiSecret']);
    const apiUrl    = data.apiUrl    || 'http://localhost:4000';
    const apiSecret = data.apiSecret || '';

    try {
        const res  = await fetch(`${apiUrl}/jobs/${jobId}`, { headers: { 'Authorization': `Bearer ${apiSecret}` } });
        const job  = await res.json();

        // Re-submit with the same query and scraper
        const newRes = await fetch(`${apiUrl}/jobs`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiSecret}` },
            body:    JSON.stringify({
                scraper:    job.scraper,
                query:      job.query,
                webhookUrl: job.webhookUrl || null,
            }),
        });

        if (!newRes.ok) throw new Error(`HTTP ${newRes.status}`);

        // Dismiss the old job
        await fetch(`${apiUrl}/jobs/${jobId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${apiSecret}` } });
        delete logBuffers[jobId];
        disconnectLogSocket(jobId);

        showToast('Job restarted ✓');
        setTimeout(refreshJobs, 500);
    } catch (err) {
        showToast(`Restart failed: ${err.message}`, 'error');
    }
}

async function gotoTab(jobId) {
    chrome.runtime.sendMessage({ type: 'FOCUS_TAB', jobId }, (res) => {
        if (!res?.ok) showToast(res?.error || 'Tab not found', 'error');
    });
}

async function closeTab(jobId) {
    const data      = await chrome.storage.local.get(['apiUrl', 'apiSecret']);
    const apiUrl    = data.apiUrl    || 'http://localhost:4000';
    const apiSecret = data.apiSecret || '';

    // Try to close Chrome tab via background
    chrome.runtime.sendMessage({ type: 'CLOSE_TAB', jobId }, () => {});

    // Delete job from Redis so it disappears from the list
    try {
        await fetch(`${apiUrl}/jobs/${jobId}`, {
            method:  'DELETE',
            headers: { 'Authorization': `Bearer ${apiSecret}` },
        });
    } catch {}

    // Remove from local log buffer
    delete logBuffers[jobId];
    delete historyLoaded[jobId];
    disconnectLogSocket(jobId);

    showToast('Job dismissed');
    setTimeout(refreshJobs, 300);
}
async function connectBridge(jobId) {
    showToast(`Connecting...`);
    chrome.runtime.sendMessage({ type: 'START_BRIDGE', jobId }, (res) => {
        if (res?.ok) { showToast('Connected ✓'); refreshJobs(); }
        else showToast(res?.error || 'Failed', 'error');
    });
}

async function disconnectBridge(jobId) {
    chrome.runtime.sendMessage({ type: 'STOP_BRIDGE', jobId }, () => {
        showToast('Disconnected');
        refreshJobs();
    });
}

async function resumeJob(jobId) {
    chrome.runtime.sendMessage({ type: 'RESUME_JOB', jobId }, () => {
        showToast('Resumed ✓');
        setTimeout(refreshJobs, 500);
    });
}

// ── Polling indicator (kept for compatibility) ────────────────────────────────
async function updatePollingIndicator() {
    await updateStatusPill();
}

// ── Debugger toggle ───────────────────────────────────────────────────────────
async function updateDebuggerToggle() {
    const state   = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve));
    const bridges = state?.bridges || [];
    const section = document.getElementById('debuggerToggleSection');
    const btn     = document.getElementById('debuggerToggleBtn');
    const statusEl = document.getElementById('debuggerStatusText');
    if (bridges.length === 0) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    if (debuggerAttached) {
        statusEl.textContent = '🟢 attached — banner visible';
        statusEl.style.color = '#166534';
        btn.textContent      = 'Detach (hide banner)';
        btn.className        = 'btn btn-secondary';
    } else {
        statusEl.textContent = '⚪ detached — banner hidden';
        statusEl.style.color = '#666';
        btn.textContent      = 'Re-attach';
        btn.className        = 'btn btn-primary';
    }
}

async function toggleDebugger() {
    const msg = debuggerAttached ? 'DETACH_DEBUGGER' : 'ATTACH_DEBUGGER';
    chrome.runtime.sendMessage({ type: msg }, (res) => {
        if (res?.ok) {
            debuggerAttached = !debuggerAttached;
            updateDebuggerToggle();
            showToast(debuggerAttached ? 'Debugger attached' : 'Debugger detached');
        } else showToast(res?.error || 'Failed', 'error');
    });
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
        position:fixed;bottom:12px;left:50%;transform:translateX(-50%);
        background:${type === 'error' ? '#ef4444' : '#1a1a1a'};
        color:white;padding:6px 14px;border-radius:6px;
        font-size:12px;z-index:9999;white-space:nowrap;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

// ── Background events ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BRIDGE_STATUS' || msg.type === 'AUTO_CONNECTING') {
        updatePollingIndicator();
        refreshJobs();
    }
    if (msg.type === 'HANDOFF_REQUIRED') {
        // Refresh to show "Go to Tab" button
        refreshJobs();
    }
});

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Request notification permission if not granted
    if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            updateNotifBanner(permission);
        });
    } else {
        updateNotifBanner(Notification.permission);
    }
    document.getElementById('saveBtn')?.addEventListener('click', saveSettings);
    document.getElementById('refreshBtn')?.addEventListener('click', refreshJobs);
    document.getElementById('debuggerToggleBtn')?.addEventListener('click', toggleDebugger);
    document.getElementById('copyFlagBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText('--silent-debugger-extension-api').then(() => {
            showToast('Flag copied!');
        });
    });
    document.getElementById('settingsGear')?.addEventListener('click', () => {
        document.getElementById('settingsDrawer')?.classList.toggle('open');
    });

    document.getElementById('resetUuidBtn')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'RESET_UUID' }, (res) => {
            const el = document.getElementById('uuidDisplay');
            if (el) el.textContent = res?.uuid || '—';
            showToast('Browser ID reset ✓');
        });
    });

    // Show uuid in settings drawer
    chrome.runtime.sendMessage({ type: 'GET_UUID' }, (res) => {
        const el = document.getElementById('uuidDisplay');
        if (el) el.textContent = res?.uuid || '—';
    });

    loadSettings();
    updateStatusPill();
    updateDebuggerToggle();
    refreshJobs();

    // Auto-refresh every 3s, skip if user is typing
    setInterval(() => {
        const focused  = document.activeElement;
        const isTyping = ['apiUrl', 'apiSecret', 'bridgePort'].includes(focused?.id);
        if (!isTyping) {
            updateStatusPill();
            updateDebuggerToggle();
            refreshJobs();
        }
    }, 3000);
});