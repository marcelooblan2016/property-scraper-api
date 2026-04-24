'use strict';

/**
 * functions/webhook.js
 *
 * Fires a POST callback to Laravel when a job completes, fails, or errors.
 *
 * Laravel receives:
 * {
 *   "jobId":    "uuid",
 *   "status":   "completed" | "failed",
 *   "filePath": "./downloads/789/deed.pdf",  // on completed
 *   "error":    "message"                    // on failed
 * }
 *
 * The same NODE_API_SECRET bearer token is sent back so Laravel can
 * verify the callback is genuine.
 */

const SECRET = process.env.NODE_API_SECRET || null;

/**
 * @param {object} job     — full job record
 * @param {object} payload — additional fields to merge into the body
 */
async function fireWebhook(job, payload) {
    if (!job.webhookUrl) return;

    try {
        const body = JSON.stringify({ jobId: job.id, ...payload });

        const response = await fetch(job.webhookUrl, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(SECRET ? { 'Authorization': `Bearer ${SECRET}` } : {}),
            },
            body,
        });

        console.log(`[webhook] → ${job.webhookUrl} | status: ${response.status}`);
    } catch (err) {
        console.error(`[webhook] failed for job ${job.id}:`, err.message);
    }
}

module.exports = { fireWebhook };