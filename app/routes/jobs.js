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

// ── POST /jobs/:id/cancel ─────────────────────────────────────────────────────
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

module.exports = router;