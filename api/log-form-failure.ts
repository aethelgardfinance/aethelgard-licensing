/**
 * Vercel Serverless Function — capture client-side form-submission failures.
 *
 * The aethelgard.finance website forms (waitlist, design-partner, mac/PDF
 * Studio waitlist) catch their own fetch failures and tell the user to email
 * contact@aethelgard.finance directly. Without this endpoint, those failures
 * are invisible to the operator: a backend outage, a CORS regression, or a
 * regional CDN issue could be silently dropping submissions and we wouldn't
 * see it until the inbound mail trickle stopped.
 *
 * The website POSTs to here (or fires `navigator.sendBeacon`) with a small
 * structured payload describing what failed. We log it to stderr (so it
 * surfaces in Vercel logs) and fire an admin Slack alert when configured.
 *
 * Privacy: callers are explicitly asked NOT to send PII. The schema below
 * accepts only:
 *   - `context`     — short identifier of the form (waitlist / design-partner / etc)
 *   - `errorBrief`  — short string description (≤ 200 chars)
 *   - `status`      — optional HTTP status code seen by the client
 * Anything else is dropped. No emails, names, or backgrounds.
 *
 * Rate-limited at 10 requests per IP per minute (slightly more permissive
 * than /api/waitlist because a misbehaving page could legitimately trigger
 * a few of these in succession; still bites the spam case).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../lib/redis.js';

const ALLOWED_ORIGIN = 'https://aethelgard.finance';
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 10;
const MAX_CONTEXT = 60;
const MAX_ERROR = 200;

function setCorsHeaders(res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clientIp(req: VercelRequest): string {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) {
        const first = raw.split(',')[0]?.trim();
        if (first) return first;
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim();
    return 'unknown';
}

async function isRateLimited(ip: string): Promise<boolean> {
    try {
        const key = `form-fail-rate:${ip}`;
        const count = (await kv.incr(key)) as number;
        if (count === 1) await kv.expire(key, RATE_LIMIT_WINDOW_SECONDS);
        return count > RATE_LIMIT_MAX;
    } catch (err) {
        console.warn('Rate-limit KV check failed (form-failure), allowing through:', err);
        return false;
    }
}

async function fireSlackAlert(message: string): Promise<void> {
    const webhookUrl = process.env['SLACK_ALERT_WEBHOOK_URL'];
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: `:warning: ${message}` }),
        });
    } catch (err) {
        console.error('Slack form-failure alert post failed:', err);
    }
}

function sanitiseShort(raw: unknown, maxLen: number): string {
    if (typeof raw !== 'string') return '';
    const stripped = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
    return stripped.length > maxLen ? stripped.slice(0, maxLen) : stripped;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = clientIp(req);
    if (await isRateLimited(ip)) {
        // Soft-fail with 204 — beacons should not alarm the user even when
        // they're rate-limited; the data is best-effort observability.
        return res.status(204).end();
    }

    let body: Record<string, unknown> = {};
    try {
        body = (typeof req.body === 'object' && req.body !== null) ? req.body as Record<string, unknown> : {};
    } catch {
        body = {};
    }

    const context = sanitiseShort(body['context'], MAX_CONTEXT);
    const errorBrief = sanitiseShort(body['errorBrief'], MAX_ERROR);
    const statusRaw = body['status'];
    const status = typeof statusRaw === 'number' && Number.isFinite(statusRaw) && statusRaw >= 0 && statusRaw < 1000
        ? Math.floor(statusRaw)
        : null;

    if (!context) {
        return res.status(400).json({ error: 'Invalid context' });
    }

    const summary = `[FORM-FAILURE] context=${context} status=${status ?? 'n/a'} error=${errorBrief || 'n/a'} ip=${ip}`;
    console.warn(summary);
    await fireSlackAlert(summary);

    return res.status(204).end();
}
