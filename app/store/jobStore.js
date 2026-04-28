'use strict';

/**
 * app/store/jobStore.js
 *
 * Redis-backed job store using ioredis.
 * Survives server restarts and supports multiple Node processes.
 *
 * JobRecord persisted in Redis (JSON):
 * {
 *   id:          string
 *   scraper:     'bot' | 'human'
 *   status:      'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
 *   liveViewUrl: string | null
 *   webhookUrl:  string | null
 *   result:      object | null
 *   error:       string | null
 *   createdAt:   string (ISO)
 *   updatedAt:   string (ISO)
 * }
 *
 * resumeEmitter (EventEmitter) is NOT stored in Redis — it only needs to
 * exist for the lifetime of the current process. It lives in a local Map
 * keyed by jobId. If the process restarts mid-job, the job stays in Redis
 * as "running" but the emitter is gone. The resume route handles this
 * gracefully by falling back to a Redis pub/sub signal.
 *
 * Required .env vars:
 *   REDIS_URL  — e.g. redis://localhost:6379 or rediss://user:pass@host:6380
 *
 * Redis key pattern:
 *   job:<id>   — Hash storing all job fields (TTL: 7 days)
 *   jobs:index — Set of all job IDs (for listJobs)
 */

const Redis       = require('ioredis');
const EventEmitter = require('events');

// ── Redis client ──────────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    lazyConnect:          true,
});

redis.on('connect',   () => console.log('[redis] connected'));
redis.on('error',     (err) => console.error('[redis] error:', err.message));
redis.on('reconnecting', () => console.log('[redis] reconnecting...'));

// ── local emitter store (in-process only) ─────────────────────────────────────
// Keyed by jobId. Cleared when process restarts.
const emitters = new Map();

const JOB_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const KEY  = (id) => `job:${id}`;
const INDEX = 'jobs:index';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEmitter(jobId) {
    const emitter = new EventEmitter();
    emitters.set(jobId, emitter);
    return emitter;
}

function getEmitter(jobId) {
    return emitters.get(jobId) || null;
}

function serialize(job) {
    // Redis hset doesn't store null — convert null to empty string sentinel '__null__'
    const n = (v) => (v === null || v === undefined) ? '__null__' : v;
    return {
        id:          job.id,
        scraper:     job.scraper,
        status:      job.status,
        liveViewUrl: n(job.liveViewUrl),
        sessionId:   n(job.sessionId),
        webhookUrl:  n(job.webhookUrl),
        result:      job.result ? JSON.stringify(job.result) : '__null__',
        error:       n(job.error),
        createdAt:   job.createdAt instanceof Date
            ? job.createdAt.toISOString()
            : job.createdAt,
        updatedAt:   job.updatedAt instanceof Date
            ? job.updatedAt.toISOString()
            : job.updatedAt,
    };
}

function deserialize(raw) {
    if (!raw) return null;
    // Restore null from sentinel '__null__' or legacy 'null' or empty string
    const n = (v) => (!v || v === '__null__' || v === 'null') ? null : v;
    return {
        ...raw,
        result:        n(raw.result) ? JSON.parse(raw.result) : null,
        liveViewUrl:   n(raw.liveViewUrl),
        sessionId:     n(raw.sessionId),
        webhookUrl:    n(raw.webhookUrl),
        error:         n(raw.error),
        resumeEmitter: getEmitter(raw.id),
    };
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Create a new job in Redis.
 * @param {object} job — must include id, scraper, status, webhookUrl
 * @returns {Promise<object>} the full job record (with resumeEmitter attached)
 */
async function createJob(job) {
    const emitter   = makeEmitter(job.id);
    const now       = new Date().toISOString();
    const toStore   = serialize({
        ...job,
        createdAt: now,
        updatedAt: now,
    });

    const pipeline = redis.pipeline();
    pipeline.hset(KEY(job.id), toStore);
    pipeline.expire(KEY(job.id), JOB_TTL_SECONDS);
    pipeline.sadd(INDEX, job.id);
    await pipeline.exec();

    return { ...job, resumeEmitter: emitter, createdAt: now, updatedAt: now };
}

/**
 * Retrieve a job by id.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function getJob(id) {
    const raw = await redis.hgetall(KEY(id));
    if (!raw || Object.keys(raw).length === 0) return null;
    return deserialize(raw);
}

/**
 * Patch a job's fields and update updatedAt.
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<void>}
 */
async function updateJob(id, patch) {
    const now     = new Date().toISOString();
    const current = await getJob(id);
    if (!current) return;

    const updated = serialize({ ...current, ...patch, updatedAt: now });
    const pipeline = redis.pipeline();
    pipeline.hset(KEY(id), updated);
    pipeline.expire(KEY(id), JOB_TTL_SECONDS);
    await pipeline.exec();
}

/**
 * Return all jobs as an array (most recent first).
 * @returns {Promise<object[]>}
 */
async function listJobs() {
    const ids = await redis.smembers(INDEX);
    if (!ids.length) return [];

    const pipeline = redis.pipeline();
    ids.forEach(id => pipeline.hgetall(KEY(id)));
    const results = await pipeline.exec();

    return results
        .map(([err, raw]) => err ? null : deserialize(raw))
        .filter(Boolean)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Strip internal fields before sending to clients.
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

/**
 * Emit a signal on the job's local resumeEmitter.
 * Falls back to Redis pub/sub if the emitter doesn't exist in this process
 * (e.g. after a restart while a job was mid-flight).
 * @param {string} id
 * @param {'resume'|'cancel'|'takeover'} signal
 * @returns {Promise<void>}
 */
async function signalJob(id, signal) {
    const emitter = getEmitter(id);
    if (emitter) {
        emitter.emit(signal);
    } else {
        await redis.publish(`job:signal:${id}`, signal);
        console.warn(`[jobStore] emitter not found for job ${id} — published via Redis pub/sub`);
    }
}

module.exports = {
    redis,
    createJob,
    getJob,
    updateJob,
    listJobs,
    serializeJob,
    signalJob,
    makeEmitter,
    getEmitter,
};