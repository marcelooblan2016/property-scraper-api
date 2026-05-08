/**
 * popup.js — SAM Scraper Extension Popup
 * Shows active bridges, auto-connect status, and allows manual control
 */

// ── Load settings ─────────────────────────────────────────────────────────────
async function loadSettings() {
    const data = await chrome.storage.local.get(['apiUrl', 'apiSecret', 'bridgePort']);
    document.getElementById('apiUrl').value     = data.apiUrl     || 'http://localhost:4000';
    document.getElementById('apiSecret').value  = data.apiSecret  || '';
    document.getElementById('bridgePort').value = data.bridgePort || 9223;
    console.log('[popup] settings loaded:', { apiUrl: data.apiUrl, hasSecret: !!data.apiSecret });
}

async function saveSettings() {
    const apiUrl     = document.getElementById('apiUrl').value.trim();
    const apiSecret  = document.getElementById('apiSecret').value.trim();
    const bridgePort = parseInt(document.getElementById('bridgePort').value) || 9223;

    if (!apiUrl || !apiSecret) { showToast('API URL and Secret are required', 'error'); return; }

    await chrome.storage.local.set({ apiUrl, apiSecret, bridgePort });

    chrome.runtime.sendMessage({ type: 'STOP_POLLING' }, () => {
        chrome.runtime.sendMessage({ type: 'START_POLLING' }, () => {
            updatePollingIndicator();
            refreshJobs();
        });
    });
    showToast('Settings saved ✓');
}

// ── Active bridges ────────────────────────────────────────────────────────────
let activeTab = 0; // currently selected tab index (0-2)

async function refreshJobs() {
    const data      = await chrome.storage.local.get(['apiUrl', 'apiSecret', 'bridgePort']);
    const apiUrl    = data.apiUrl    || 'http://localhost:4000';
    const apiSecret = data.apiSecret || '';

    // Only update fields if user is NOT currently focused on them
    const focused = document.activeElement;
    if (focused !== document.getElementById('apiUrl'))     document.getElementById('apiUrl').value    = apiUrl;
    if (focused !== document.getElementById('apiSecret'))  document.getElementById('apiSecret').value = apiSecret;
    if (focused !== document.getElementById('bridgePort')) document.getElementById('bridgePort').value = data.bridgePort || 9223;

    if (!apiSecret) {
        renderTabs([]);
        return;
    }

    try {
        const res  = await fetch(`${apiUrl}/jobs`, { headers: { 'Authorization': `Bearer ${apiSecret}` } });
        const jobs = await res.json();
        const state = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve));
        const activeBridgeIds = new Set((state?.bridges || []).map(b => b.jobId));

        const activeJobs = Array.isArray(jobs)
            ? jobs.filter(j => ['waiting', 'running'].includes(j.status)).slice(0, 3)
            : [];

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
        container.innerHTML = `
            <div class="tab-bar">
                <div class="tab tab-empty active">—</div>
                <div class="tab tab-empty">—</div>
                <div class="tab tab-empty">—</div>
            </div>
            <div class="empty">No active jobs — submit a job to start</div>`;
        return;
    }

    // Clamp activeTab
    if (activeTab >= jobs.length) activeTab = 0;

    // Build tab bar — always show 3 slots
    const tabBar = Array.from({ length: 3 }, (_, i) => {
        const job = jobs[i];
        if (!job) return `<div class="tab tab-empty">—</div>`;
        const propertyId = job.propertyId || job.query?.propertyId || '—';
        const tabLabel   = propertyId !== '—' ? propertyId : job.id.slice(0, 8);
        const isActive   = i === activeTab;
        const bridged    = activeBridgeIds.has(job.id);
        return `
            <div class="tab ${isActive ? 'active' : ''} ${bridged ? 'bridged' : ''}"
                 data-tab="${i}" title="Job ${job.id}">
                <span class="tab-property">${tabLabel}</span>
                <span class="tab-dot tag-${job.status}"></span>
            </div>`;
    }).join('');

    // Build content for selected tab
    const job        = jobs[activeTab];
    const bridged    = activeBridgeIds.has(job.id);
    const propertyId = job.propertyId || job.query?.propertyId || '—';
    const county     = job.query?.county || '—';
    const state      = job.query?.state  || '—';
    const tabLabel   = propertyId !== '—' ? propertyId : job.id.slice(0, 8);

    const content = `
        <div class="job-detail">
            <div class="job-detail-row">
                <span class="job-detail-label">Property ID</span>
                <span class="job-detail-value">${propertyId}</span>
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
                <div style="display:flex;align-items:center;gap:4px;">
                    <span class="tag tag-${job.status}">${job.status}</span>
                    ${bridged ? '<span class="tag" style="background:#dcfce7;color:#16a34a;">⚡ bridged</span>' : ''}
                </div>
            </div>
            <div class="job-detail-row">
                <span class="job-detail-label">Job ID</span>
                <span class="job-detail-value mono">${job.id.slice(0, 16)}...</span>
            </div>
            <div class="job-actions">
                ${job.status === 'waiting' && !bridged ? `
                    <button class="btn btn-primary" data-action="connect" data-job="${job.id}">Connect</button>
                ` : ''}
                ${job.status === 'waiting' && bridged ? `
                    <button class="btn btn-warning" data-action="resume" data-job="${job.id}">Resume</button>
                ` : ''}
                ${bridged ? `
                    <button class="btn btn-secondary" data-action="disconnect" data-job="${job.id}">Disconnect</button>
                ` : ''}
            </div>
        </div>`;

    container.innerHTML = `<div class="tab-bar">${tabBar}</div>${content}`;

    // Tab click
    container.querySelectorAll('.tab[data-tab]').forEach(t => {
        t.addEventListener('click', () => {
            activeTab = parseInt(t.dataset.tab);
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
        });
    });
}

async function connectBridge(jobId) {
    showToast(`Connecting job ${jobId.slice(0, 8)}...`);
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
        setTimeout(refreshJobs, 1000);
    });
}

// ── Polling indicator ─────────────────────────────────────────────────────────
async function updatePollingIndicator() {
    const state  = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve));
    const dot    = document.getElementById('pollingDot');
    const status = document.getElementById('pollingStatus');

    if (state?.polling) {
        dot.className    = 'status-dot polling';
        status.textContent = `polling · ${(state.bridges || []).length} active`;
    } else {
        dot.className    = 'status-dot';
        status.textContent = 'stopped';
    }
}

// ── Debugger toggle ───────────────────────────────────────────────────────────
let debuggerAttached = true;

async function updateDebuggerToggle() {
    const state    = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve));
    const bridges  = state?.bridges || [];
    const section  = document.getElementById('debuggerToggleSection');
    const btn      = document.getElementById('debuggerToggleBtn');
    const statusEl = document.getElementById('debuggerStatusText');

    if (bridges.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';

    if (debuggerAttached) {
        statusEl.textContent  = '🟢 attached — banner visible';
        statusEl.style.color  = '#166534';
        btn.textContent       = 'Detach (hide banner)';
        btn.className         = 'btn btn-secondary';
    } else {
        statusEl.textContent  = '⚪ detached — banner hidden';
        statusEl.style.color  = '#666';
        btn.textContent       = 'Re-attach';
        btn.className         = 'btn btn-primary';
    }
}

async function toggleDebugger() {
    const msg = debuggerAttached ? 'DETACH_DEBUGGER' : 'ATTACH_DEBUGGER';
    chrome.runtime.sendMessage({ type: msg }, (res) => {
        if (res?.ok) {
            debuggerAttached = !debuggerAttached;
            updateDebuggerToggle();
            showToast(debuggerAttached ? 'Debugger attached' : 'Debugger detached — banner hidden');
        } else {
            showToast(res?.error || 'Failed', 'error');
        }
    });
}
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

// ── Listen for background events ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BRIDGE_STATUS' || msg.type === 'AUTO_CONNECTING') {
        updatePollingIndicator();
        refreshJobs();
    }
});

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('saveBtn').addEventListener('click', saveSettings);
    document.getElementById('refreshBtn').addEventListener('click', refreshJobs);
    document.getElementById('debuggerToggleBtn').addEventListener('click', toggleDebugger);
    document.getElementById('copyFlagBtn').addEventListener('click', () => {
        navigator.clipboard.writeText('--silent-debugger-extension-api').then(() => {
            showToast('Flag copied — relaunch Chrome with this flag to hide the banner');
        });
    });

    loadSettings();
    updatePollingIndicator();
    updateDebuggerToggle();
    refreshJobs();

    // Auto-refresh every 5s while popup is open, but skip if user is typing
    setInterval(() => {
        const focused = document.activeElement;
        const isTyping = ['apiUrl', 'apiSecret', 'bridgePort'].includes(focused?.id);
        if (!isTyping) {
            updatePollingIndicator();
            updateDebuggerToggle();
            refreshJobs();
        }
    }, 5000);
});