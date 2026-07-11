/**
 * Vercel Serverless Function — admin triage feed for "Request a bank" submissions.
 *
 * GET /api/bank-requests
 * Header: Authorization: Bearer <BANK_REQUESTS_ADMIN_TOKEN>
 *
 * Returns the queued submissions (newest first) so a human — or a scheduled
 * Cowork triage agent — can see and prioritise which bank adapters to build.
 * Read-only; does not clear the queue. The queue holds only the REDACTED
 * submission (headers + a faked sample), never real financial data.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../lib/redis.js';

const QUEUE_KEY = 'bank-requests';

/** Constant-time string compare so the token check doesn't leak length/prefix via timing. */
function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const adminToken = process.env['BANK_REQUESTS_ADMIN_TOKEN'];
    if (!adminToken) {
        console.error('BANK_REQUESTS_ADMIN_TOKEN not configured');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    const rawAuth = req.headers['authorization'];
    const auth = Array.isArray(rawAuth) ? (rawAuth[0] ?? '') : (rawAuth ?? '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!bearer || !safeEqual(bearer, adminToken)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const raw = (await kv.lrange(QUEUE_KEY, 0, -1)) as unknown[];
        const requests = raw.map(entry => {
            if (typeof entry === 'string') {
                try { return JSON.parse(entry); } catch { return { raw: entry }; }
            }
            return entry;
        });
        return res.status(200).json({ count: requests.length, requests });
    } catch (err) {
        console.error('Failed to read bank-requests queue:', err);
        return res.status(500).json({ error: 'Failed to read queue' });
    }
}
