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
const { v4: uuidv4 }    = require('uuid');
const EventEmitter    = require('events');
const fs              = require('fs');
const path            = require('path');
const { createJob, getJob, updateJob, listJobs, serializeJob, signalJob } = require('../store/jobStore');
const { runScraper }  = require('../functions/jobRunner');
const { fireWebhook } = require('../functions/webhook');
const logServer       = require('../functions/logServer');

const router = Router();

// ── POST /jobs ────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const { scraper = 'bot', query = {}, webhookUrl = null, uuid = null } = req.body;

    if (!['bot', 'human'].includes(scraper)) {
        return res.status(400).json({ error: 'scraper must be "bot" or "human"' });
    }

    const job = await createJob({
        id:            uuidv4(),
        scraper,
        status:        'queued',
        liveViewUrl:   null,
        resumeEmitter: new EventEmitter(),
        webhookUrl,
        propertyId:    query.propertyId || null,
        query:         query,
        uuid:      uuid || null,
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
        // Broadcast failure to WebSocket clients
        logServer.broadcast(job.id, {
            jobId:     job.id,
            type:      'error',
            message:   `Job failed | ${err.message}`,
            timestamp: new Date().toISOString(),
        });
    });

    return res.status(202).json({ jobId: job.id, status: 'queued' });
});

// ── DELETE /jobs/:id ──────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    const { redis } = require('../store/jobStore');
    await redis.srem('jobs:index', req.params.id);
    await redis.del(`job:${req.params.id}`);
    return res.json({ ok: true, deleted: req.params.id });
});

// ── DELETE /jobs ──────────────────────────────────────────────────────────────
// Clear all jobs from Redis (dev/debug only)
router.delete('/', async (req, res) => {
    const jobs     = await listJobs();
    const pipeline = require('../store/jobStore').redis.pipeline();
    jobs.forEach(j => {
        pipeline.del(`job:${j.id}`);
    });
    pipeline.del('jobs:index');
    await pipeline.exec();
    return res.json({ ok: true, cleared: jobs.length });
});
router.get('/', async (req, res) => {
    const uuid = req.query.uuid || req.query.clientId || null;
    let jobs = await listJobs();
    // uuid=null jobs are unclaimed — show to all extensions so they can claim them
    if (uuid) jobs = jobs.filter(j => !j.uuid || j.uuid === uuid);
    return res.json(jobs.map(serializeJob));
});


// ── GET /dataset/check?state=FL&county=DIXIE ─────────────────────────────────
// Must be before /:id to avoid being matched as a job ID
// ── GET /jobs/dataset/export ── export all datasets as JSON for seeding ────────
router.get('/dataset/export', (req, res) => {
    const datasetRoot = path.join(process.cwd(), 'dataset');
    if (!fs.existsSync(datasetRoot)) {
        return res.json({ scraper_mds: [], scraper_configs: [] });
    }

    const scraperMds     = [];
    const scraperConfigs = [];
    const mdIndex        = {}; // "STATE/FILENAME" → md name for deduplication

    const states = fs.readdirSync(datasetRoot).filter(f =>
        fs.statSync(path.join(datasetRoot, f)).isDirectory()
    );

    for (const state of states) {
        const stateDir  = path.join(datasetRoot, state);
        const mdFiles   = fs.readdirSync(stateDir).filter(f => f.endsWith('.md'));

        // Separate DEFAULT variants from main files
        // e.g. DEFAULT-lot.md, DEFAULT-lot-subdivision.md → retries of DEFAULT.md
        const mainFiles    = mdFiles.filter(f => !f.match(/^DEFAULT-.+\.md$/));
        const retryFiles   = mdFiles.filter(f =>  f.match(/^DEFAULT-.+\.md$/));

        // Build retry object — { "lot": "md content", "block_lot": "md content" }
        const retries = {};
        for (const retryFile of retryFiles) {
            const variantName = retryFile
                .replace('.md', '')
                .replace('DEFAULT-', '')
                .replace(/-/g, '_'); // block-lot → block_lot
            const retryMd = fs.readFileSync(path.join(stateDir, retryFile), 'utf8');
            retries[variantName] = retryMd;
        }

        for (const mdFile of mainFiles) {
            const mdPath     = path.join(stateDir, mdFile);
            const jsonPath   = path.join(stateDir, mdFile.replace('.md', '.json'));
            const countyTxt  = path.join(stateDir, 'counties.txt');
            const countyName = mdFile.replace('.md', '');

            const md = fs.readFileSync(mdPath, 'utf8');
            let config      = {};
            let scraperType = 'bot-human';

            if (fs.existsSync(jsonPath)) {
                try {
                    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                    scraperType = json.type || 'bot-human';
                    const { type: _, ...rest } = json;
                    config = rest;
                } catch {}
            }

            // Inject retries into config if this is DEFAULT and variants exist
            if (countyName === 'DEFAULT' && Object.keys(retries).length > 0) {
                config = { ...config, retries };
            }

            const mdKey  = `${state}/${mdFile}`;
            const mdName = `${state} ${countyName}`;

            if (!mdIndex[mdKey]) {
                mdIndex[mdKey] = mdName;
                scraperMds.push({ name: mdName, md, config });
            }

            // Build scraper_configs entries
            if (countyName === 'DEFAULT') {
                if (fs.existsSync(countyTxt)) {
                    const counties = fs.readFileSync(countyTxt, 'utf8')
                        .split('\n')
                        .map(l => l.trim())
                        .filter(Boolean);

                    for (const county of counties) {
                        scraperConfigs.push({
                            state_code:      state,
                            county_name:     county,
                            scraper_md_name: mdName,
                            scraper_type:    scraperType,
                            config,
                        });
                    }
                } else {
                    scraperConfigs.push({
                        state_code:      state,
                        county_name:     'DEFAULT',
                        scraper_md_name: mdName,
                        scraper_type:    scraperType,
                        config,
                    });
                }
            } else {
                scraperConfigs.push({
                    state_code:      state,
                    county_name:     countyName.replace(/_/g, ' '),
                    scraper_md_name: mdName,
                    scraper_type:    scraperType,
                    config,
                });
            }
        }
    }

    return res.json({ scraper_mds: scraperMds, scraper_configs: scraperConfigs });
});

router.get('/dataset/check', (req, res) => {
    const state  = (req.query.state  || '').trim().toUpperCase();
    const county = (req.query.county || '').trim().toUpperCase().replace(/\s+/g, '_');

    if (!state || !county) {
        return res.status(400).json({ ok: false, error: 'state and county are required' });
    }

    const datasetDir  = path.join(process.cwd(), 'dataset', state);
    const countyFile  = path.join(datasetDir, `${county}.md`);
    const defaultFile = path.join(datasetDir, 'DEFAULT.md');
    const countiesTxt = path.join(datasetDir, 'counties.txt');

    // 1. Exact county file
    if (fs.existsSync(countyFile)) {
        return res.json({ ok: true, match: 'exact', file: `dataset/${state}/${county}.md` });
    }

    // 2. DEFAULT.md + counties.txt
    if (fs.existsSync(defaultFile) && fs.existsSync(countiesTxt)) {
        const counties = fs.readFileSync(countiesTxt, 'utf8')
            .split('\n')
            .map(l => l.trim().toUpperCase().replace(/\s+/g, '_'))
            .filter(Boolean);
        if (counties.includes(county)) {
            return res.json({ ok: true, match: 'default', file: `dataset/${state}/DEFAULT.md`, county });
        }
    }

    // 3. Not found
    return res.status(404).json({ ok: false, error: `County ${county}, ${state} is not supported` });
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

// ── POST /jobs/:id/bridge-ready ───────────────────────────────────────────────
// Called by the Chrome extension when it has attached the debugger to a tab.
// The extension passes the tabId — Node signals cdpBridge to resolve.
router.post('/:id/bridge-ready', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { tabId, bridgePort, uuid } = req.body;
    console.log(`[bridge-ready] job: ${req.params.id} | tabId: ${tabId}`);
    if (uuid) await updateJob(req.params.id, { uuid });

    const cdpBridge = require('../functions/cdpBridge');
    cdpBridge.signalReady(req.params.id, { tabId, bridgePort });

    return res.json({ ok: true });
});
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