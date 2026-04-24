'use strict';

/**
 * routes/jobs.js
 *
 * All /jobs endpoints. Mounted at /jobs in server.js.
 *
 * POST   /jobs              — start a new scraper job
 * GET    /jobs              — list all jobs (debug)
 * GET    /jobs/:id          — get a single job status
 * POST   /jobs/:id/resume   — resume a waiting type2 job (human clicked "Done")
 * POST   /jobs/:id/cancel   — cancel any active job
 *
 * ── Laravel integration ────────────────────────────────────────────────────────
 *
 * Start a job:
 *   POST /jobs
 *   {
 *     "scraper":    "bot" | "human",
 *     "query":      { state, county, book, page, propertyId, ... },
 *     "webhookUrl": "https://your-laravel.com/api/scraper/callback"
 *   }
 *   → 202 { jobId, status: "queued" }
 *
 * Poll status (type2 — poll until status = "waiting" to get liveViewUrl):
 *   GET /jobs/:id
 *   → 200 { id, scraper, status, liveViewUrl, result, error, createdAt, updatedAt }
 *
 * Resume (human is done):
 *   POST /jobs/:id/resume
 *   → 200 { ok: true }
 *
 * Cancel:
 *   POST /jobs/:id/cancel
 *   → 200 { ok: true }
 */

const { Router }       = require('express');
const { v4: uuid }     = require('uuid');
const EventEmitter     = require('events');
const { createJob, getJob, updateJob, listJobs, serializeJob } = require('../store/jobStore');
const { runScraper }   = require('../functions/jobRunner');
const { fireWebhook }  = require('../functions/webhook');

const router = Router();

// ── POST /jobs ────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const { scraper = 'bot', query = {}, webhookUrl = null } = req.body;

    if (!['bot', 'human'].includes(scraper)) {
        return res.status(400).json({ error: 'scraper must be "bot" or "human"' });
    }

    const job = createJob({
        id:            uuid(),
        scraper,
        status:        'queued',
        liveViewUrl:   null,
        resumeEmitter: new EventEmitter(),
        webhookUrl,
        result:        null,
        error:         null,
        createdAt:     new Date(),
        updatedAt:     new Date(),
    });

    // Fire and forget — do not await
    runScraper(job, query).catch(err => {
        console.error(`[job:${job.id}] unhandled runner error:`, err.message);
        updateJob(job.id, { status: 'failed', error: err.message });
        fireWebhook(job, { status: 'failed', error: err.message });
    });

    return res.status(202).json({ jobId: job.id, status: 'queued' });
});

// ── GET /jobs ─────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
    return res.json(listJobs().map(serializeJob));
});

// ── GET /jobs/:id ─────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    return res.json(serializeJob(job));
});

// ── POST /jobs/:id/resume ─────────────────────────────────────────────────────
router.post('/:id/resume', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status !== 'waiting') {
        return res.status(409).json({
            error: `Job cannot be resumed (status: ${job.status})`,
        });
    }

    job.resumeEmitter.emit('resume');
    return res.json({ ok: true });
});

// ── POST /jobs/:id/cancel ─────────────────────────────────────────────────────
router.post('/:id/cancel', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        return res.status(409).json({
            error: `Job is already ${job.status}`,
        });
    }

    job.resumeEmitter.emit('cancel');
    updateJob(job.id, { status: 'cancelled' });
    return res.json({ ok: true });
});

module.exports = router;