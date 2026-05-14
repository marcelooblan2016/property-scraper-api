'use strict';

/**
 * app/functions/cdpBridge.js
 *
 * WebSocket bridge between Node.js and the Chrome Extension.
 * Node sends high-level action commands, extension executes them.
 *
 * Commands (JSON):
 *   { id, action: 'goto',       params: { url } }
 *   { id, action: 'evaluate',   params: { expression } }
 *   { id, action: 'click',      params: { selector } }
 *   { id, action: 'type',       params: { selector, text } }
 *   { id, action: 'getUrl',     params: {} }
 *   { id, action: 'waitForUrl', params: { fragment, timeout } }
 *   { id, action: 'screenshot', params: {} }
 *   { id, action: 'handoff',    params: { message } }
 *   { id, action: 'ping',       params: {} }
 */

const WebSocket = require('ws');

class CdpBridge {
    constructor() {
        this.extensions = new Map(); // jobId → WebSocket (extension)
        this.resolvers  = new Map(); // jobId → resolve fn (waitForExtension)
        this.pending    = new Map(); // id → { resolve, reject } (command responses)
        this.wss        = null;
        this._cmdId     = 0;
    }

    start() {
        const port = parseInt(process.env.BRIDGE_PORT || '9223');
        this.wss   = new WebSocket.Server({ port });

        this.wss.on('connection', (ws, req) => {
            const url    = new URL(req.url, `http://localhost:${port}`);
            const jobId  = url.searchParams.get('jobId');
            const token  = url.searchParams.get('token');
            const role   = url.searchParams.get('role') || 'extension';
            const secret = process.env.NODE_API_SECRET || null;

            if (!jobId) { ws.close(1008, 'Missing jobId'); return; }
            if (secret && token !== secret) { ws.close(1008, 'Unauthorized'); return; }

            if (role === 'extension') {
                this._onExtensionConnect(ws, jobId);
            }
            // No separate client connection needed — Node calls sendCommand() directly
        });

        console.log(`[cdpBridge] listening on ws://localhost:${port}/bridge`);
    }

    _onExtensionConnect(ws, jobId) {
        console.log(`[cdpBridge] extension connected | job: ${jobId}`);
        this.extensions.set(jobId, ws);

        // Resolve waitForExtension()
        const resolve = this.resolvers.get(jobId);
        if (resolve) {
            console.log(`[cdpBridge] resolving waitForExtension | job: ${jobId}`);
            resolve(ws);
            this.resolvers.delete(jobId);
        }

        // Handle responses from extension
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.id !== undefined) {
                    const pending = this.pending.get(msg.id);
                    if (pending) {
                        this.pending.delete(msg.id);
                        if (msg.error) pending.reject(new Error(msg.error));
                        else pending.resolve(msg.result);
                    }
                }
            } catch (err) {
                console.error('[cdpBridge] response parse error:', err);
            }
        });

        ws.on('close', () => {
            console.log(`[cdpBridge] extension disconnected | job: ${jobId}`);
            this.extensions.delete(jobId);
            // Store reconnect resolver so sendCommand can wait for reconnect
            // Extension auto-reconnects via polling within 5s
        });
    }

    // ── Wait for extension to reconnect (used mid-job) ────────────────────────
    waitForReconnect(jobId, timeoutMs = 15000) {
        const existing = this.extensions.get(jobId);
        if (existing?.readyState === WebSocket.OPEN) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.resolvers.delete(jobId);
                reject(new Error('Extension reconnect timeout'));
            }, timeoutMs);

            this.resolvers.set(jobId, (ws) => {
                clearTimeout(timer);
                resolve(ws);
            });
        });
    }

    // ── Send command to extension ─────────────────────────────────────────────
    async sendCommand(jobId, action, params = {}, timeoutMs = 30000) {
        let ws = this.extensions.get(jobId);

        // If not connected, wait up to 15s for reconnect before failing
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.log(`[cdpBridge] extension not connected for job: ${jobId} — waiting for reconnect...`);
            try {
                ws = await this.waitForReconnect(jobId, 15000);
                console.log(`[cdpBridge] extension reconnected | job: ${jobId}`);
            } catch {
                throw new Error(`Extension not connected for job: ${jobId}`);
            }
        }

        return new Promise((resolve, reject) => {
            const id    = ++this._cmdId;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Command timeout: ${action}`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve: (val) => { clearTimeout(timer); resolve(val); },
                reject:  (err) => { clearTimeout(timer); reject(err); },
            });

            console.log(`[cdpBridge] → extension: ${action}`);
            ws.send(JSON.stringify({ id, action, params }));
        });
    }

    // ── Wait for extension to connect ─────────────────────────────────────────
    waitForExtension(jobId, timeoutMs = 5 * 60 * 1000) {
        const existing = this.extensions.get(jobId);
        if (existing?.readyState === WebSocket.OPEN) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.resolvers.has(jobId)) {
                    this.resolvers.delete(jobId);
                    reject(new Error('Extension connection timeout'));
                }
            }, timeoutMs);

            this.resolvers.set(jobId, (ws) => {
                clearTimeout(timer);
                resolve(ws);
            });
        });
    }

    signalReady(jobId, info) {
        console.log(`[cdpBridge] bridge-ready signal | job: ${jobId} | tabId: ${info?.tabId}`);
    }

    closeJob(jobId) {
        try { this.extensions.get(jobId)?.close(); } catch {}
        this.extensions.delete(jobId);
        console.log(`[cdpBridge] job closed | job: ${jobId}`);
    }
}

const cdpBridge = new CdpBridge();
module.exports = cdpBridge;