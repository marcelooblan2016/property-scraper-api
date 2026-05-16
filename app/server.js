'use strict';

/**
 * app/server.js — Entry point
 *
 * Boots Express + WebSocket server, wires middleware and routes.
 *
 * HTTP endpoints:  http://your-server:4000/jobs/...
 * WebSocket logs:  ws://your-server:4000/logs?jobId=<jobId>
 */

const http    = require('http');
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const dotenv  = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const auth      = require('./middleware/auth');
const jobRoutes = require('./routes/jobs');
const logServer    = require('./functions/logServer');
const cdpBridge    = require('./functions/cdpBridge');

const app        = express();
const httpServer = http.createServer(app);
const PORT       = process.env.NODE_PORT || 4000;

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
    origin:  process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── global middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(auth);

// ── routes ────────────────────────────────────────────────────────────────────
app.use('/jobs', jobRoutes);

// ── start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, async () => {
    console.log(`[server] listening on port ${PORT}`);
    console.log(`[server] auth: ${process.env.NODE_API_SECRET ? 'enabled' : 'disabled'}`);
    logServer.attach(httpServer);
    cdpBridge.start();

    // Clean up legacy jobs with no uuid — they're from before UUID isolation
    try {
        const { redis } = require('./store/jobStore');
        const ids = await redis.smembers('jobs:index');
        let removed = 0;
        for (const id of ids) {
            const raw = await redis.hgetall(`job:${id}`);
            if (!raw || !raw.uuid || raw.uuid === '__null__') {
                await redis.srem('jobs:index', id);
                await redis.del(`job:${id}`);
                removed++;
            }
        }
        if (removed > 0) console.log(`[server] cleaned up ${removed} legacy jobs with no uuid`);
    } catch (err) {
        console.warn('[server] cleanup error:', err.message);
    }
});