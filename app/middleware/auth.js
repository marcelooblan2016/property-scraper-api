'use strict';

/**
 * middleware/auth.js
 *
 * Optional bearer token authentication.
 * Set NODE_API_SECRET in .env to enable.
 * If not set, all requests pass through (useful for local dev).
 *
 * Laravel should send:
 *   Authorization: Bearer <NODE_API_SECRET>
 */

const SECRET = process.env.NODE_API_SECRET || null;

function auth(req, res, next) {
    if (!SECRET) return next();

    const header = req.headers['authorization'] || '';
    if (header !== `Bearer ${SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}

module.exports = auth;