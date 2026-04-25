'use strict';

/**
 * app/functions/jobRunner.js
 *
 * Resolves the correct scraper class, injects lifecycle callbacks,
 * and runs the scraper asynchronously.
 *
 * Callbacks injected into the scraper:
 *
 *  onHandoff({ liveViewUrl, message })
 *    type2 only — suspends until POST /jobs/:id/resume is called.
 *    Uses local EventEmitter if available, falls back to Redis pub/sub
 *    if the process restarted mid-job.
 *
 *  onComplete({ filePath, s3Key, s3Url })
 *    Sets job status → "completed", fires webhook to Laravel.
 *
 *  onError({ error })
 *    Sets job status → "failed", fires webhook to Laravel.
 */

const { updateJob, getEmitter, redis } = require('../store/jobStore');
const { fireWebhook }                  = require('./webhook');

const HANDOFF_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Start a scraper job asynchronously.
 * The caller should NOT await this — it is fire-and-forget.
 *
 * @param {object} job   — full job record (includes resumeEmitter)
 * @param {object} query — scraper query params from Laravel
 */
async function runScraper(job, query) {
    await updateJob(job.id, { status: 'running' });
    console.log(`[job:${job.id}] starting | scraper=${job.scraper}`);

    // ── resolve scraper class ─────────────────────────────────────────────────
    let ScraperClass;
    if (job.scraper === 'human') {
        ScraperClass = require('../scrapers/propertyScraperHuman');
    } else {
        ScraperClass = require('../scrapers/propertyScraper');
    }

    // ── lifecycle callbacks ───────────────────────────────────────────────────
    const callbacks = {

        /**
         * onHandoff — type2 only
         * Suspends until signalJob('resume') or signalJob('cancel') is called.
         * Supports both local EventEmitter and Redis pub/sub (for post-restart resilience).
         */
        onHandoff: async ({ liveViewUrl, message }) => {
            await updateJob(job.id, { status: 'waiting', liveViewUrl });
            console.log(`[job:${job.id}] waiting for human | liveViewUrl: ${liveViewUrl}`);

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    subscriber?.disconnect();
                    reject(new Error(`Handoff timed out after ${HANDOFF_TIMEOUT_MS / 60000} minutes`));
                }, HANDOFF_TIMEOUT_MS);

                // ── Strategy 1: local EventEmitter (same process) ─────────────
                const emitter = getEmitter(job.id);
                if (emitter) {
                    emitter.once('resume', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                    emitter.once('cancel', () => {
                        clearTimeout(timeout);
                        reject(new Error('Job cancelled by user'));
                    });
                }

                // ── Strategy 2: Redis pub/sub (post-restart fallback) ─────────
                // Always subscribe so signals work even if emitter exists
                let subscriber;
                try {
                    subscriber = redis.duplicate();
                    subscriber.subscribe(`job:signal:${job.id}`, (err) => {
                        if (err) console.error('[jobRunner] pub/sub subscribe error:', err.message);
                    });
                    subscriber.on('message', (channel, signal) => {
                        clearTimeout(timeout);
                        subscriber.disconnect();
                        if (signal === 'resume') resolve();
                        else reject(new Error('Job cancelled by user'));
                    });
                } catch (err) {
                    console.warn('[jobRunner] pub/sub unavailable:', err.message);
                }
            });

            await updateJob(job.id, { status: 'running', liveViewUrl: null });
            console.log(`[job:${job.id}] resumed by human`);
        },

        /**
         * onComplete — PDF downloaded and uploaded to S3
         */
        onComplete: async ({ filePath, s3Key, s3Url }) => {
            await updateJob(job.id, { status: 'completed', result: { filePath, s3Key, s3Url } });
            console.log(`[job:${job.id}] completed | s3: ${s3Url || filePath}`);
            await fireWebhook(job, { status: 'completed', filePath, s3Key, s3Url });
        },

        /**
         * onError — unrecoverable scraper error
         */
        onError: async ({ error }) => {
            await updateJob(job.id, { status: 'failed', error });
            console.error(`[job:${job.id}] failed | ${error}`);
            await fireWebhook(job, { status: 'failed', error });
        },
    };

    // ── run ───────────────────────────────────────────────────────────────────
    const instance = new ScraperClass({ query, standalone: false, ...callbacks });
    await instance.startNow();
}

module.exports = { runScraper };