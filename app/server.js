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
const path    = require('path');
const dotenv  = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const auth      = require('./middleware/auth');
const jobRoutes = require('./routes/jobs');
const logServer = require('./functions/logServer');

const app        = express();
const httpServer = http.createServer(app);
const PORT       = process.env.NODE_PORT || 4000;

// ── global middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(auth);

// ── routes ────────────────────────────────────────────────────────────────────
app.use('/jobs', jobRoutes);

// ── start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
    console.log(`[server] auth: ${process.env.NODE_API_SECRET ? 'enabled' : 'disabled'}`);
    logServer.attach(httpServer);
});