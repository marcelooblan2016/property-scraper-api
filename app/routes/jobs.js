'use strict';

/**
 * app/routes/jobs.js
 *
 * All /jobs endpoints. Mounted at /jobs in server.js.
 *
 * POST   /jobs              — start a new scraper job
 * GET    /jobs              — list all jobs
 * GET    /jobs/:id          — get a single job status
 * POST   /jobs/:id/resume   — resume a waiting type2 job
 * POST   /jobs/:id/cancel   — cancel any active job
 */

const { Router }      = require('express');
const { v4: uuid }    = require('uuid');
const EventEmitter    = require('events');
const fs              = require('fs');
const path            = require('path');
const { createJob, getJob, updateJob, listJobs, serializeJob, signalJob } = require('../store/jobStore');
const { runScraper }  = require('../functions/jobRunner');
const { fireWebhook } = require('../functions/webhook');

const router = Router();

// ── POST /jobs ────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const { scraper = 'bot', query = {}, webhookUrl = null } = req.body;

    if (!['bot', 'human'].includes(scraper)) {
        return res.status(400).json({ error: 'scraper must be "bot" or "human"' });
    }

    const job = await createJob({
        id:            uuid(),
        scraper,
        status:        'queued',
        liveViewUrl:   null,
        resumeEmitter: new EventEmitter(), // stored locally, not in Redis
        webhookUrl,
        propertyId:    query.propertyId || null,
        result:        null,
        error:         null,
        createdAt:     new Date(),
        updatedAt:     new Date(),
    });

    // Fire and forget — do not await
    runScraper(job, query).catch(async (err) => {
        console.error(`[job:${job.id}] unhandled runner error:`, err.message);
        await updateJob(job.id, { status: 'failed', error: err.message });
        await fireWebhook(job, { status: 'failed', error: err.message });
    });

    return res.status(202).json({ jobId: job.id, status: 'queued' });
});

// ── GET /jobs ─────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    const jobs = await listJobs();
    return res.json(jobs.map(serializeJob));
});

// ── GET /jobs/:id ─────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    return res.json(serializeJob(job));
});

// ── POST /jobs/:id/resume ─────────────────────────────────────────────────────
router.post('/:id/resume', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status !== 'waiting') {
        return res.status(409).json({
            error: `Job cannot be resumed (status: ${job.status})`,
        });
    }

    await signalJob(job.id, 'resume');
    return res.json({ ok: true });
});

// ── POST /jobs/:id/takeover ───────────────────────────────────────────────────
// Human can request control at any point — even mid-action.
// The scraper checks this flag between actions and pauses itself.
router.post('/:id/takeover', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (!['running', 'waiting'].includes(job.status)) {
        return res.status(409).json({
            error: `Job cannot be taken over (status: ${job.status})`,
        });
    }

    await signalJob(job.id, 'takeover');
    return res.json({ ok: true, message: 'Takeover requested — bot will pause after current action' });
});

// ── GET /jobs/:id/debug ───────────────────────────────────────────────────────
// Returns Steel session viewer URL for the human to monitor/interact.
router.get('/:id/debug', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (!['running', 'waiting'].includes(job.status)) {
        return res.status(409).json({ error: `Job is not active (status: ${job.status})` });
    }

    if (!job.sessionId) {
        return res.status(404).json({ error: 'Session not ready yet — try again in a moment' });
    }

    return res.json({
        jobId:       job.id,
        status:      job.status,
        // Open this URL in a browser for full native interaction via WebRTC
        liveViewUrl: job.liveViewUrl,
        sessionId:   job.sessionId,
    });
});
router.post('/:id/cancel', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        return res.status(409).json({ error: `Job is already ${job.status}` });
    }

    await signalJob(job.id, 'cancel');
    await updateJob(job.id, { status: 'cancelled' });
    return res.json({ ok: true });
});

// ── GET /jobs/:id/logs ────────────────────────────────────────────────────────
// Returns the log file contents for a job (today's log by default)
router.get('/:id/logs', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const propertyId = job.propertyId || req.query.propertyId || job.id;
    const date       = req.query.date || new Date().toISOString().slice(0, 10);
    const logFile    = path.resolve(`./logs/${propertyId}/property.log`);

    try {
        const content = await fs.promises.readFile(logFile, 'utf8');
        const lines   = content.trim().split('\n').map(line => {
            const match = line.match(/^\[(.+?)\] \[(.+?)\] (.+)$/);
            if (!match) return { raw: line };
            return { timestamp: match[1], type: match[2].toLowerCase(), message: match[3] };
        });
        return res.json({ jobId: job.id, propertyId, lines });
    } catch {
        return res.json({ jobId: job.id, propertyId, lines: [] });
    }
});

// ── GET /jobs/:id/logs/internal ───────────────────────────────────────────────
// Returns the internal debug log (action + response pairs) for investigation
router.get('/:id/logs/internal', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const propertyId = job.propertyId || req.query.propertyId || job.id;
    const date       = req.query.date || new Date().toISOString().slice(0, 10);
    const logFile    = path.resolve(`./logs/${propertyId}/property-internal.log`);

    try {
        const content = await fs.promises.readFile(logFile, 'utf8');
        const blocks  = content.split('---\n').filter(b => b.trim());
        const entries = blocks.map(block => {
            const lines    = block.trim().split('\n');
            const header   = lines[0]?.match(/^\[(.+?)\] \[(.+?)\]$/);
            const action   = lines[1]?.replace('Action:   ', '').trim();
            const response = lines[2]?.replace('Response: ', '').trim();
            return {
                timestamp: header?.[1] || '',
                status:    header?.[2]?.toLowerCase() === 'error' ? 'error' : 'ok',
                action:    action || '',
                response:  response || '',
            };
        });
        return res.json({ jobId: job.id, propertyId, entries });
    } catch {
        return res.json({ jobId: job.id, propertyId, entries: [] });
    }
});

module.exports = router;