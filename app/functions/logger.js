'use strict';

/**
 * app/functions/logger.js
 *
 * Shared logger used by both type1 and type2 scrapers.
 * Each job gets its own logger instance that:
 *
 *  1. Broadcasts log events via WebSocket to connected Nuxt 3 clients
 *  2. Writes to ./downloads/<propertyId>/logs/<YYYY-MM-DD>.log          (user-facing)
 *  3. Writes to ./downloads/<propertyId>/logs/<YYYY-MM-DD>-internal.log (debug/investigation)
 *
 * USER LOG  — human readable, sent to Nuxt via WebSocket
 * INTERNAL LOG — verbose action + response pairs for debugging
 *
 * Internal log format:
 *   [2026-04-29T04:00:01Z] [ACTION]
 *   Action:   [page][goto] https://www.google.com
 *   Response: OK
 *   ---
 *   [2026-04-29T04:00:05Z] [ERROR]
 *   Action:   [page][clickselector] #submit-btn
 *   Response: ERROR — Element not found: #submit-btn
 *   ---
 */

const fs   = require('fs');
const path = require('path');

class JobLogger {

    /**
     * @param {string} jobId
     * @param {string|null} propertyId  — used for log file path
     * @param {object} wsServer         — WebSocket server instance from logServer
     */
    constructor(jobId, propertyId, wsServer) {
        this.jobId      = jobId;
        this.propertyId = propertyId || jobId;
        this.wsServer   = wsServer;
    }

    // ── public log methods (user-facing) ──────────────────────────────────────

    action(message)   { this._log('action',   message); }
    info(message)     { this._log('info',     message); }
    handoff(message)  { this._log('handoff',  message); }
    complete(message) { this._log('complete', message); }
    error(message)    { this._log('error',    message); }

    // ── internal log (action + response pairs) ────────────────────────────────

    /**
     * Log an action + its result to the internal log.
     * Called by executeActions after each verb runs.
     *
     * @param {string} rawAction  — the raw .md line e.g. "[page][goto] https://..."
     * @param {string} status     — 'ok' | 'error'
     * @param {string} [detail]   — error message or response detail
     */
    internal(rawAction, status, detail = '') {
        try {
            const timestamp = new Date().toISOString();
            const date      = timestamp.slice(0, 10);
            const dir       = path.resolve(`./logs/${this.propertyId}`);
            const logFile   = path.join(dir, `${date}-internal.log`);

            fs.mkdirSync(dir, { recursive: true });

            const type     = status === 'error' ? 'ERROR' : 'OK';
            const response = detail
                ? (status === 'error' ? `ERROR — ${detail}` : detail)
                : 'OK';

            const block = [
                `[${timestamp}] [${type}]`,
                `Action:   ${rawAction}`,
                `Response: ${response}`,
                `---`,
                '',
            ].join('\n');

            fs.appendFileSync(logFile, block, 'utf8');
        } catch (err) {
            console.error('[logger] failed to write internal log:', err.message);
        }
    }

    // ── core ──────────────────────────────────────────────────────────────────

    _log(type, message) {
        const event = {
            jobId:     this.jobId,
            type,
            message,
            timestamp: new Date().toISOString(),
        };

        // 1. Broadcast via WebSocket to Nuxt 3
        this.wsServer?.broadcast(this.jobId, event);

        // 2. Write to user-facing log file
        this._writeToFile(event);

        // 3. Console
        console.log(`[${type.toUpperCase()}][job:${this.jobId}] ${message}`);
    }

    _writeToFile(event) {
        try {
            const date    = new Date().toISOString().slice(0, 10);
            const dir     = path.resolve(`./logs/${this.propertyId}`);
            const logFile = path.join(dir, `property.log`);

            fs.mkdirSync(dir, { recursive: true });

            const line = `[${event.timestamp}] [${event.type.toUpperCase()}] ${event.message}\n`;
            fs.appendFileSync(logFile, line, 'utf8');
        } catch (err) {
            console.error('[logger] failed to write log file:', err.message, err.stack);
        }
    }
}

module.exports = { JobLogger };