'use strict';

/**
 * app/functions/logServer.js
 *
 * WebSocket server that broadcasts real-time job action logs to Nuxt 3.
 * Runs on the same port as Express using HTTP server upgrade.
 *
 * NUXT 3 CONNECTION
 * ──────────────────
 *   ws://your-server:4000/logs?jobId=<jobId>
 *
 * With auth (if NODE_API_SECRET is set):
 *   ws://your-server:4000/logs?jobId=<jobId>&token=<NODE_API_SECRET>
 *
 * NUXT 3 EXAMPLE
 * ───────────────
 *   const ws = new WebSocket(`ws://your-api:4000/logs?jobId=${jobId}`)
 *   ws.onmessage = (e) => {
 *     const log = JSON.parse(e.data)
 *     logs.value.push(log)
 *   }
 */

const WebSocket = require('ws');

class LogServer {

    constructor() {
        // Map<jobId, Set<WebSocket>> — clients subscribed per job
        this.clients = new Map();
        this.wss     = null;
    }

    /**
     * Attach WebSocket server to existing HTTP server.
     * Called once from server.js after app.listen().
     * @param {http.Server} httpServer
     */
    attach(httpServer) {
        this.wss = new WebSocket.Server({ noServer: true });

        // Handle HTTP → WebSocket upgrade
        httpServer.on('upgrade', (req, socket, head) => {
            const url    = new URL(req.url, `http://${req.headers.host}`);
            const jobId  = url.searchParams.get('jobId');
            const token  = url.searchParams.get('token');
            const secret = process.env.NODE_API_SECRET || null;

            // Reject if no jobId
            if (!jobId) {
                socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                socket.destroy();
                return;
            }

            // Auth check if secret is set
            if (secret && token !== secret) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            // Only handle /logs path
            if (!url.pathname.startsWith('/logs')) {
                return; // let other upgrade handlers deal with it
            }

            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this._onConnect(ws, jobId);
            });
        });

        console.log('[logServer] WebSocket server attached');
    }

    /**
     * Broadcast a log event to all clients subscribed to a job.
     * @param {string} jobId
     * @param {object} event
     */
    broadcast(jobId, event) {
        const subscribers = this.clients.get(jobId);
        if (!subscribers || subscribers.size === 0) return;

        const payload = JSON.stringify(event);
        for (const ws of subscribers) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
            }
        }
    }

    // ── private ───────────────────────────────────────────────────────────────

    _onConnect(ws, jobId) {
        console.log(`[logServer] client connected | jobId: ${jobId}`);

        // Register client
        if (!this.clients.has(jobId)) {
            this.clients.set(jobId, new Set());
        }
        this.clients.get(jobId).add(ws);

        // Send welcome message
        ws.send(JSON.stringify({
            jobId,
            type:      'info',
            message:   'Connected to job log stream',
            timestamp: new Date().toISOString(),
        }));

        // Remove on disconnect
        ws.on('close', () => {
            const subs = this.clients.get(jobId);
            if (subs) {
                subs.delete(ws);
                if (subs.size === 0) this.clients.delete(jobId);
            }
            console.log(`[logServer] client disconnected | jobId: ${jobId}`);
        });

        ws.on('error', (err) => {
            console.error(`[logServer] ws error | jobId: ${jobId}:`, err.message);
        });
    }
}

// Singleton — shared across the whole app
const logServer = new LogServer();
module.exports = logServer;