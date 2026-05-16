'use strict';

/**
 * app/functions/pushNotifier.js
 * Web Push Notifications via VAPID
 * Subscriptions stored in Redis keyed by uuid
 */

const webpush = require('web-push');

// Configure VAPID
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_EMAIL || 'mailto:admin@example.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY,
    );
}

let redis = null;
function setRedis(r) { redis = r; }

// ── Store subscription ────────────────────────────────────────────────────────
async function saveSubscription(uuid, subscription) {
    if (!redis) throw new Error('Redis not connected');
    await redis.set(`push:${uuid}`, JSON.stringify(subscription));
    console.log(`[push] subscription saved | uuid: ${uuid}`);
}

// ── Remove subscription ───────────────────────────────────────────────────────
async function removeSubscription(uuid) {
    if (!redis) return;
    await redis.del(`push:${uuid}`);
    console.log(`[push] subscription removed | uuid: ${uuid}`);
}

// ── Send notification to a uuid ───────────────────────────────────────────────
async function sendNotification(uuid, { title, message, jobId, type = 'handoff' }) {
    if (!redis) return;
    if (!process.env.VAPID_PUBLIC_KEY) {
        console.warn('[push] VAPID keys not configured — skipping push');
        return;
    }

    const raw = await redis.get(`push:${uuid}`);
    if (!raw) {
        console.log(`[push] no subscription for uuid: ${uuid}`);
        return;
    }

    const subscription = JSON.parse(raw);
    const payload = JSON.stringify({ title, message, jobId, type });

    try {
        await webpush.sendNotification(subscription, payload);
        console.log(`[push] sent | uuid: ${uuid} | type: ${type}`);
    } catch (err) {
        console.error(`[push] failed | uuid: ${uuid} | ${err.message}`);
        // Remove invalid subscription (410 = gone)
        if (err.statusCode === 410) {
            await removeSubscription(uuid);
        }
    }
}

module.exports = { setRedis, saveSubscription, removeSubscription, sendNotification };