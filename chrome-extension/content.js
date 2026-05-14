/**
 * content.js — SAM Scraper Bridge
 * Injected into https://titlesearch.afxllc.com/*
 *
 * Communication with the page uses window.postMessage with namespaced
 * type prefixes: "SAM_SCRAPER:*" to avoid conflicts with other scripts.
 *
 * Page → Extension:
 *   SAM_SCRAPER:CHECK          — is extension configured?
 *   SAM_SCRAPER:START_JOB      — start a scraping job
 *   SAM_SCRAPER:GET_JOBS       — list active jobs
 *
 * Extension → Page:
 *   SAM_SCRAPER:CHECK_RESPONSE
 *   SAM_SCRAPER:JOB_STARTED
 *   SAM_SCRAPER:JOB_ERROR
 *   SAM_SCRAPER:JOBS_RESPONSE
 */

'use strict';

// ── Signal extension is present + expose UUID ─────────────────────────────────
document.documentElement.setAttribute('data-sam-scraper', 'true');
document.documentElement.setAttribute('data-sam-scraper-version', '1.0.0');

// Expose UUID so the page can read it without postMessage
chrome.storage.local.get(['uuid', 'clientId'], (data) => {
    const uuid = data.uuid || data.clientId || null;
    if (uuid) {
        document.documentElement.setAttribute('data-sam-scraper-uuid', uuid);
    }
});

// ── Single message listener — routes by namespaced type ──────────────────────
window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    const { type, ...payload } = event.data || {};

    // Only handle SAM_SCRAPER: prefixed messages
    if (!type?.startsWith('SAM_SCRAPER:')) return;

    const data      = await chrome.storage.local.get(['apiUrl', 'apiSecret']);
    const apiUrl    = data.apiUrl    || '';
    const apiSecret = data.apiSecret || '';

    switch (type) {

        // ── Check if extension is configured ─────────────────────────────────
        case 'SAM_SCRAPER:CHECK': {
            const uuid = await new Promise(resolve =>
                chrome.storage.local.get('uuid', d => resolve(d.uuid || null))
            );
            window.postMessage({
                type:       'SAM_SCRAPER:CHECK_RESPONSE',
                installed:  true,
                configured: !!(apiUrl && apiSecret),
                apiUrl,
                uuid,
            }, '*');
            break;
        }

        // ── Start a scraping job ──────────────────────────────────────────────
        case 'SAM_SCRAPER:START_JOB': {
            if (!apiUrl || !apiSecret) {
                window.postMessage({
                    type:  'SAM_SCRAPER:JOB_ERROR',
                    error: 'Extension not configured — open SAM Scraper Bridge and set API URL + Secret',
                    requestId: payload.requestId,
                }, '*');
                break;
            }
            try {
                const uuid = await new Promise(resolve =>
                    chrome.storage.local.get('uuid', d => resolve(d.uuid || null))
                );
                const res  = await fetch(`${apiUrl}/jobs`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiSecret}` },
                    body:    JSON.stringify({
                        scraper:    payload.scraper || 'human',
                        query:      payload.query,
                        webhookUrl: payload.webhookUrl || null,
                        uuid,
                    }),
                });
                const json = await res.json();
                window.postMessage({
                    type:      'SAM_SCRAPER:JOB_STARTED',
                    jobId:     json.jobId,
                    requestId: payload.requestId,
                }, '*');
            } catch (err) {
                window.postMessage({
                    type:      'SAM_SCRAPER:JOB_ERROR',
                    error:     err.message,
                    requestId: payload.requestId,
                }, '*');
            }
            break;
        }

        // ── Get active jobs ───────────────────────────────────────────────────
        case 'SAM_SCRAPER:GET_JOBS': {
            if (!apiUrl || !apiSecret) {
                window.postMessage({ type: 'SAM_SCRAPER:JOBS_RESPONSE', jobs: [] }, '*');
                break;
            }
            try {
                const uuid = await new Promise(resolve =>
                    chrome.storage.local.get('uuid', d => resolve(d.uuid || null))
                );
                const res  = await fetch(`${apiUrl}/jobs?uuid=${uuid}`, {
                    headers: { 'Authorization': `Bearer ${apiSecret}` },
                });
                const jobs = await res.json();
                window.postMessage({
                    type:      'SAM_SCRAPER:JOBS_RESPONSE',
                    jobs:      Array.isArray(jobs) ? jobs : [],
                    requestId: payload.requestId,
                }, '*');
            } catch {
                window.postMessage({ type: 'SAM_SCRAPER:JOBS_RESPONSE', jobs: [], requestId: payload.requestId }, '*');
            }
            break;
        }

        default:
            // Unknown SAM_SCRAPER: type — ignore
            break;
    }
});