'use strict';

/**
 * functions/jobRunner.js
 *
 * Resolves the correct scraper class, injects lifecycle callbacks,
 * and runs the scraper asynchronously.
 *
 * Callbacks injected into the scraper:
 *
 *  onHandoff({ liveViewUrl, message })
 *    Called when [stagehand][handoff] is hit in the .md file (type2 only).
 *    Sets job status → "waiting", stores liveViewUrl for Laravel to poll.
 *    Suspends until the Express route receives POST /jobs/:id/resume.
 *    Times out after HANDOFF_TIMEOUT_MS (default 2 hours).
 *
 *  onComplete({ filePath })
 *    Called when the scraper successfully downloads the deed PDF.
 *    Sets job status → "completed", fires webhook to Laravel.
 *
 *  onError({ error })
 *    Called on a caught scraper error.
 *    Sets job status → "failed", fires webhook to Laravel.
 */

const { updateJob }    = require('../store/jobStore');
const { fireWebhook }  = require('./webhook');

const HANDOFF_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Start a scraper job asynchronously.
 * Returns immediately; the caller should not await this.
 *
 * @param {object} job   — full job record from jobStore
 * @param {object} query — scraper query params from Laravel
 */
async function runScraper(job, query) {
    updateJob(job.id, { status: 'running' });
    console.log(`[job:${job.id}] starting | scraper=${job.scraper}`);

    // ── resolve scraper class ─────────────────────────────────────────────────
    let ScraperClass;
    if (job.scraper === 'human') {
        ScraperClass = require('../scrapers/propertyScraperHuman');
    } else {
        ScraperClass = require('../scrapers/propertyScraper');
    }

    // ── build callbacks ───────────────────────────────────────────────────────
    const callbacks = {

        /**
         * onHandoff — type2 only
         * Suspends the scraper until the human clicks "Done" in Laravel,
         * which calls POST /jobs/:id/resume on the Express server.
         */
        onHandoff: async ({ liveViewUrl, message }) => {
            updateJob(job.id, { status: 'waiting', liveViewUrl });
            console.log(`[job:${job.id}] waiting for human | liveViewUrl: ${liveViewUrl}`);

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Handoff timed out after ${HANDOFF_TIMEOUT_MS / 60000} minutes`));
                }, HANDOFF_TIMEOUT_MS);

                job.resumeEmitter.once('resume', () => {
                    clearTimeout(timeout);
                    updateJob(job.id, { status: 'running', liveViewUrl: null });
                    console.log(`[job:${job.id}] resumed by human`);
                    resolve();
                });

                job.resumeEmitter.once('cancel', () => {
                    clearTimeout(timeout);
                    reject(new Error('Job cancelled by user'));
                });
            });
        },

        /**
         * onComplete — scraper downloaded the PDF successfully
         */
        onComplete: async ({ filePath }) => {
            updateJob(job.id, { status: 'completed', result: { filePath } });
            console.log(`[job:${job.id}] completed | file: ${filePath}`);
            await fireWebhook(job, { status: 'completed', filePath });
        },

        /**
         * onError — scraper hit an unrecoverable error
         */
        onError: async ({ error }) => {
            updateJob(job.id, { status: 'failed', error });
            console.error(`[job:${job.id}] failed | ${error}`);
            await fireWebhook(job, { status: 'failed', error });
        },
    };

    // ── run ───────────────────────────────────────────────────────────────────
    const instance = new ScraperClass({ query, ...callbacks });
    await instance.startNow();
}

module.exports = { runScraper };