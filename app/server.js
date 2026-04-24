'use strict';

/**
 * server.js — Entry point
 *
 * Boots Express, wires middleware and routes, starts listening.
 * All logic lives in middleware/, routes/, functions/, store/.
 */

const express = require('express');
const path    = require('path');
const dotenv  = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const auth      = require('./middleware/auth');
const jobRoutes = require('./routes/jobs');

const app  = express();
const PORT = process.env.NODE_PORT || 4000;

// ── global middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(auth);

// ── routes ────────────────────────────────────────────────────────────────────
app.use('/jobs', jobRoutes);

// ── start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[server] listening on port ${PORT}`);
    console.log(`[server] auth: ${process.env.NODE_API_SECRET ? 'enabled' : 'disabled'}`);
});