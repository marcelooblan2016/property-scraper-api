'use strict';

/**
 * store/jobStore.js
 *
 * In-memory job store.
 *
 * JobRecord shape:
 * {
 *   id:            string        — uuid
 *   scraper:       'bot'|'human' — type1 or type2
 *   status:        'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
 *   liveViewUrl:   string|null   — Browserbase live view URL (type2 only, while waiting)
 *   resumeEmitter: EventEmitter  — internal signal bus for handoff/cancel
 *   webhookUrl:    string|null   — Laravel callback URL
 *   result:        object|null   — e.g. { filePath }
 *   error:         string|null
 *   createdAt:     Date
 *   updatedAt:     Date
 * }
 *
 * NOTE: For multi-process / horizontally scaled deployments, replace this
 * Map with a Redis-backed store and use pub/sub for the resume signal.
 */

const jobs = new Map();

/**
 * Add a new job to the store.
 * @param {object} job
 * @returns {object} the same job
 */
function createJob(job) {
    jobs.set(job.id, job);
    return job;
}

/**
 * Retrieve a job by id.
 * @param {string} id
 * @returns {object|undefined}
 */
function getJob(id) {
    return jobs.get(id);
}

/**
 * Patch a job's fields and update `updatedAt`.
 * @param {string} id
 * @param {object} patch
 */
function updateJob(id, patch) {
    const job = jobs.get(id);
    if (!job) return;
    Object.assign(job, patch, { updatedAt: new Date() });
}

/**
 * Return all jobs as an array.
 * @returns {object[]}
 */
function listJobs() {
    return [...jobs.values()];
}

/**
 * Strip internal fields (resumeEmitter) before sending to clients.
 * @param {object} job
 * @returns {object}
 */
function serializeJob(job) {
    return {
        id:          job.id,
        scraper:     job.scraper,
        status:      job.status,
        liveViewUrl: job.liveViewUrl,
        result:      job.result,
        error:       job.error,
        createdAt:   job.createdAt,
        updatedAt:   job.updatedAt,
    };
}

module.exports = {
    createJob,
    getJob,
    updateJob,
    listJobs,
    serializeJob,
};