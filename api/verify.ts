/**
 * Vercel Serverless Function — licence key verification.
 *
 * Endpoint: GET /api/verify?key=AETHG-...&fingerprint=<hex>
 *
 * Returns (registered, not revoked):
 *   { valid: true, customer_email: "..." }
 * Returns (registered, revoked):
 *   { valid: false, reason: "refunded" }
 * Returns (not registered — pre-registry / beta keys):
 *   { valid: true, registered: false }
 *
 * The fingerprint query param is optional; when present and it matches a device
 * on the record, we update that device's last_seen_at so the operator can see
 * which installations are actively checking in.
 *
 * The key string contains only tier + expiry + a random customer ID.
 * The customer_email is stored server-side for support purposes and surfaced
 * here so the Tauri client can display it and bind it into the integrity chain.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../lib/redis.js';
import { hashKey } from '../lib/keygen.js';
import { withActivationDefaults, type KeyRecord } from './paddle-webhook.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const key = req.query['key'];
    if (!key || typeof key !== 'string' || key.trim() === '') {
        return res.status(400).json({ valid: false, reason: 'missing_key' });
    }

    const fingerprintRaw = req.query['fingerprint'];
    const fingerprint = typeof fingerprintRaw === 'string' && /^[0-9a-f]{64}$/.test(fingerprintRaw)
        ? fingerprintRaw
        : undefined;

    let record: KeyRecord | null = null;
    let recordHash: string | null = null;
    try {
        recordHash = await hashKey(key);
        record = await kv.get<KeyRecord>(`key:${recordHash}`);
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

    const normalised = withActivationDefaults(record);

    // Best-effort: refresh last_seen_at for the calling device. Any failure here
    // must never block a legitimate verify — if the write errors we still return valid.
    if (fingerprint && recordHash) {
        const idx = normalised.devices.findIndex(d => d.fingerprint === fingerprint);
        if (idx >= 0) {
            const updated: KeyRecord = {
                ...normalised,
                devices: normalised.devices.map((d, i) =>
                    i === idx ? { ...d, last_seen_at: new Date().toISOString() } : d
                ),
            };
            try { await kv.set(`key:${recordHash}`, updated); }
            catch (err) { console.warn('last_seen_at refresh failed (non-fatal):', err); }
        }
    }

    return res.status(200).json({ valid: true, customer_email: normalised.customer_email });
}
