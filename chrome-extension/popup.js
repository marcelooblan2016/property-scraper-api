/**
 * popup.js — SAM Scraper Extension Popup
 */

// ── Load settings ─────────────────────────────────────────────────────────────
async function loadSettings() {
    const data = await chrome.storage.local.get(['apiUrl', 'apiSecret', 'bridgePort']);

    console.log('[popup] loading settings from storage:', data);

    document.getElementById('apiUrl').value     = data.apiUrl     || 'http://localhost:4000';
    document.getElementById('apiSecret').value  = data.apiSecret  || '';
    document.getElementById('bridgePort').value = data.bridgePort || 9223;
}

async function saveSettings() {
    const apiUrl     = document.getElementById('apiUrl').value.trim();
    const apiSecret  = document.getElementById('apiSecret').value.trim();
    const bridgePort = parseInt(document.getElementById('bridgePort').value) || 9223;

    if (!apiUrl || !apiSecret) {
        showToast('API URL and Secret are required', 'error');
        return;
    }

    await chrome.storage.local.set({ apiUrl, apiSecret, bridgePort });

    // Verify it saved
    const saved = await chrome.storage.local.get(['apiUrl', 'apiSecret', 'bridgePort']);
    console.log('[popup] saved settings:', saved);

    // Restart polling with new settings
    chrome.runtime.sendMessage({ type: 'STOP_POLLING' }, () => {
        chrome.runtime.sendMessage({ type: 'START_POLLING' }, () => {
            updatePollingIndicator();
            refreshJobs();
        });
    });

    showToast('Settings saved ✓');
}

// ── Bridge ────────────────────────────────────────────────────────────────────
async function connectBridge() {
    const jobId = document.getElementById('jobIdInput').value.trim();
    if (!jobId) {
        showToast('Enter a job ID first', 'error');
        return;
    }

    const connectBtn = document.getElementById('connectBtn');
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';

    chrome.runtime.sendMessage({ type: 'START_BRIDGE', jobId }, (res) => {
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect Bridge to Current Tab';

        if (res?.ok) {
            updateBridgeUI(true, jobId);
            showToast('Bridge connected ✓');
        } else {
            showToast(res?.error || 'Failed to connect', 'error');
        }
    });
}

async function disconnectBridge() {
    chrome.runtime.sendMessage({ type: 'STOP_BRIDGE' }, () => {
        updateBridgeUI(false, null);
        showToast('Bridge disconnected');
    });
}

function updateBridgeUI(connected, jobId) {
    const statusEl   = document.getElementById('bridgeStatus');
    const statusText = document.getElementById('bridgeStatusText');
    const bridgeDot  = document.getElementById('bridgeDot');
    const disconnBtn = document.getElementById('disconnectBtn');
    const connectBtn = document.getElementById('connectBtn');

    if (connected) {
        statusEl.classList.remove('disconnected');
        statusText.textContent = `Connected | Job: ${jobId?.slice(0, 8)}...`;
        bridgeDot.className = 'status-dot connected';
        disconnBtn.disabled = false;
        connectBtn.disabled = true;
    } else {
        statusEl.classList.add('disconnected');
        statusText.textContent = 'Not connected';
        bridgeDot.className = 'status-dot';
        disconnBtn.disabled = true;
        connectBtn.disabled = false;
    }
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
async function refreshJobs() {
    const data      = await chrome.storage.local.get(['apiUrl', 'apiSecret']);
    const apiUrl    = data.apiUrl    || 'http://localhost:4000';
    const apiSecret = data.apiSecret || '';

    // Also update the input fields in case they weren't loaded yet
    document.getElementById('apiUrl').value    = apiUrl;
    document.getElementById('apiSecret').value = apiSecret;
    document.getElementById('bridgePort').value = (await chrome.storage.local.get('bridgePort')).bridgePort || 9223;

    if (!apiSecret) {
        document.getElementById('jobList').innerHTML =
            '<div class="empty">Save your API Secret above first</div>';
        return;
    }

    document.getElementById('jobList').innerHTML = '<div class="empty">Loading...</div>';

    try {
        const res  = await fetch(`${apiUrl}/jobs`, {
            headers: { 'Authorization': `Bearer ${apiSecret}` },
        });
        const jobs = await res.json();

        const activeJobs = Array.isArray(jobs)
            ? jobs.filter(j => ['waiting', 'running'].includes(j.status)).slice(0, 5)
            : [];

        if (!activeJobs.length) {
            document.getElementById('jobList').innerHTML =
                '<div class="empty">No active jobs</div>';
            return;
        }

        document.getElementById('jobList').innerHTML = activeJobs.map(job => `
            <div class="job-card">
                <div class="job-card-id">${job.id}</div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
                    <span class="tag tag-${job.status}">${job.status}</span>
                    <div style="display:flex;gap:4px;">
                        ${job.status === 'waiting' ? `
                            <button class="btn btn-warning" data-action="resume" data-job="${job.id}"
                                style="width:auto;padding:4px 10px;margin:0;font-size:11px;">Resume</button>
                        ` : ''}
                        <button class="btn btn-secondary" data-action="use" data-job="${job.id}"
                            style="width:auto;padding:4px 10px;margin:0;font-size:11px;">Use</button>
                    </div>
                </div>
            </div>
        `).join('');

        // Event delegation for job card buttons
        document.getElementById('jobList').addEventListener('click', (e) => {
            const btn    = e.target.closest('button[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const jobId  = btn.dataset.job;
            if (action === 'resume') resumeJob(jobId);
            if (action === 'use')    setJobId(jobId);
        });

    } catch (err) {
        document.getElementById('jobList').innerHTML =
            `<div class="empty">Cannot reach API: ${err.message}</div>`;
    }
}

function setJobId(jobId) {
    document.getElementById('jobIdInput').value = jobId;
    showToast('Job ID set — click Connect to bridge');
}

async function resumeJob(jobId) {
    chrome.runtime.sendMessage({ type: 'RESUME_JOB', jobId }, () => {
        showToast('Job resumed');
        setTimeout(refreshJobs, 1000);
    });
}

// ── Bridge status listener ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BRIDGE_STATUS') {
        updateBridgeUI(msg.status === 'connected', msg.jobId);
    }
});

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
        background: ${type === 'error' ? '#ef4444' : '#1a1a1a'};
        color: white; padding: 6px 14px; border-radius: 6px;
        font-size: 12px; z-index: 9999; white-space: nowrap;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

// ── Polling indicator ─────────────────────────────────────────────────────────
async function updatePollingIndicator() {
    const state = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve)
    );

    const dot    = document.getElementById('pollingDot');
    const status = document.getElementById('pollingStatus');

    if (state?.polling) {
        dot.className = 'status-dot polling';
        status.textContent = 'polling';
    } else {
        dot.className = 'status-dot';
        status.textContent = 'stopped';
    }

    if (state?.bridge) {
        updateBridgeUI(true, state.bridge.jobId);
    }
}

// ── Show current tab URL ──────────────────────────────────────────────────────
async function showCurrentTab() {
    const allTabs = await chrome.tabs.query({ active: true });
    const tab = allTabs.find(t => t.id && !t.url?.startsWith('chrome-extension://'));

    const hint = document.createElement('p');
    hint.style.cssText = 'font-size:10px;margin-top:4px;word-break:break-all;';

    if (!tab) {
        hint.style.color = '#ef4444';
        hint.textContent = '⚠ No tab found — open a browser tab first';
    } else {
        hint.style.color = '#16a34a';
        hint.textContent = `✓ A new tab will be created for the bot`;
    }

    const connectBtn = document.getElementById('connectBtn');
    connectBtn.parentNode.insertBefore(hint, connectBtn);
}
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('saveBtn').addEventListener('click', saveSettings);
    document.getElementById('connectBtn').addEventListener('click', connectBridge);
    document.getElementById('disconnectBtn').addEventListener('click', disconnectBridge);
    document.getElementById('refreshBtn').addEventListener('click', refreshJobs);

    loadSettings();
    updatePollingIndicator();
    refreshJobs();
    showCurrentTab();
});