/**
 * Vercel Serverless Function — licence key verification.
 *
 * Endpoint: GET /api/verify?key=AETHG-...
 *
 * Returns:
 *   { valid: true }                             — key is registered and not revoked
 *   { valid: true, registered: false }          — key not in registry (pre-dates system); treated as valid
 *   { valid: false, reason: "refunded" }        — key has been explicitly revoked
 *
 * The key string contains only tier + expiry + a random customer ID.
 * No PII is stored or transmitted. The registry stores SHA-256(normalised_key).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';
import { hashKey } from '../lib/keygen.js';
import type { KeyRecord } from './paddle-webhook.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const key = req.query['key'];
    if (!key || typeof key !== 'string' || key.trim() === '') {
        return res.status(400).json({ valid: false, reason: 'missing_key' });
    }

    let record: KeyRecord | null = null;
    try {
        const h = await hashKey(key);
        record = await kv.get<KeyRecord>(`key:${h}`);
    } catch (err) {
        // KV unavailable — fail open so server downtime never blocks legitimate users.
        console.error('KV lookup failed during verify:', err);
        return res.status(200).json({ valid: true, kv_error: true });
    }

    if (!record) {
        // Key not in registry — issued before this revocation system was deployed,
        // or generated manually. Treat as valid (benefit of the doubt).
        return res.status(200).json({ valid: true, registered: false });
    }

    if (record.revoked) {
        return res.status(200).json({ valid: false, reason: 'refunded' });
    }

    return res.status(200).json({ valid: true });
}
