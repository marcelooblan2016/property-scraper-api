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
async function refreshJobs() {
    const data      = await chrome.storage.local.get(['apiUrl', 'apiSecret']);
    const apiUrl    = data.apiUrl    || 'http://localhost:4000';
    const apiSecret = data.apiSecret || '';

    // Only update fields if user is NOT currently focused on them
    const focused = document.activeElement;
    if (focused !== document.getElementById('apiUrl'))     document.getElementById('apiUrl').value    = apiUrl;
    if (focused !== document.getElementById('apiSecret'))  document.getElementById('apiSecret').value = apiSecret;
    if (focused !== document.getElementById('bridgePort')) document.getElementById('bridgePort').value = (await chrome.storage.local.get('bridgePort')).bridgePort || 9223;

    if (!apiSecret) {
        document.getElementById('jobList').innerHTML = '<div class="empty">Save your API Secret above to enable auto-connect</div>';
        return;
    }

    document.getElementById('jobList').innerHTML = '<div class="empty">Loading...</div>';

    try {
        const res  = await fetch(`${apiUrl}/jobs`, { headers: { 'Authorization': `Bearer ${apiSecret}` } });
        const jobs = await res.json();

        const state = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve));
        const activeBridgeIds = new Set((state?.bridges || []).map(b => b.jobId));

        const activeJobs = Array.isArray(jobs)
            ? jobs.filter(j => ['waiting', 'running'].includes(j.status)).slice(0, 10)
            : [];

        if (!activeJobs.length) {
            document.getElementById('jobList').innerHTML = '<div class="empty">No active jobs — submit a job to start</div>';
            return;
        }

        document.getElementById('jobList').innerHTML = activeJobs.map(job => {
            const bridged = activeBridgeIds.has(job.id);
            return `
                <div class="job-card">
                    <div class="job-card-id">${job.id}</div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
                        <div style="display:flex;align-items:center;gap:6px;">
                            <span class="tag tag-${job.status}">${job.status}</span>
                            ${bridged ? '<span class="tag" style="background:#dcfce7;color:#16a34a;">⚡ bridged</span>' : ''}
                        </div>
                        <div style="display:flex;gap:4px;">
                            ${job.status === 'waiting' && !bridged ? `
                                <button class="btn btn-primary" data-action="connect" data-job="${job.id}"
                                    style="width:auto;padding:4px 10px;margin:0;font-size:11px;">Connect</button>
                            ` : ''}
                            ${job.status === 'waiting' && bridged ? `
                                <button class="btn btn-warning" data-action="resume" data-job="${job.id}"
                                    style="width:auto;padding:4px 10px;margin:0;font-size:11px;">Resume</button>
                            ` : ''}
                            ${bridged ? `
                                <button class="btn btn-secondary" data-action="disconnect" data-job="${job.id}"
                                    style="width:auto;padding:4px 10px;margin:0;font-size:11px;">Disconnect</button>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // Event delegation
        document.getElementById('jobList').addEventListener('click', (e) => {
            const btn    = e.target.closest('button[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const jobId  = btn.dataset.job;
            if (action === 'connect')    connectBridge(jobId);
            if (action === 'resume')     resumeJob(jobId);
            if (action === 'disconnect') disconnectBridge(jobId);
        });

    } catch (err) {
        document.getElementById('jobList').innerHTML = `<div class="empty">Cannot reach API: ${err.message}</div>`;
    }
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

    loadSettings();
    updatePollingIndicator();
    refreshJobs();

    // Auto-refresh every 5s while popup is open, but skip if user is typing
    setInterval(() => {
        const focused = document.activeElement;
        const isTyping = ['apiUrl', 'apiSecret', 'bridgePort'].includes(focused?.id);
        if (!isTyping) {
            updatePollingIndicator();
            refreshJobs();
        }
    }, 5000);
});