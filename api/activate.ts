/**
 * Vercel Serverless Function — licence activation.
 *
 * Endpoint: POST /api/activate
 * Body:     { "key": "AETHG-...", "fingerprint": "<64-hex>", "device_name": "..." }
 *
 * Responses:
 *   200 { activated: true,  registered: false }                      — beta / pre-registry key
 *   200 { activated: true,  existing: false, customer_email, limit, devices_used }
 *   200 { activated: true,  existing: true,  customer_email, limit, devices_used }
 *   403 { activated: false, reason: "revoked" }
 *   409 { activated: false, reason: "limit_reached", limit, devices: [{device_name, activated_at}] }
 *   400 { error: "..." }                                              — validation failure
 *   500 { error: "server_error" }                                     — KV unreachable etc.
 *
 * This endpoint fails hard on server errors (no fail-open). First activation
 * is the one place where we require connectivity — see operations/integrity-chain-email.md
 * and the wider design plan. The Tauri client surfaces a clear "internet required"
 * message; once activated, the app works offline.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../lib/redis.js';
import { hashKey } from '../lib/keygen.js';
import {
    activateDevice,
    isValidFingerprint,
    sanitiseDeviceName,
} from '../lib/activation.js';

interface ActivateBody {
    key?:         unknown;
    fingerprint?: unknown;
    device_name?: unknown;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    // Vercel's Node runtime parses JSON bodies automatically when content-type
    // is application/json. Accept both parsed objects and raw strings to be safe.
    let body: ActivateBody;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
    } catch {
        return res.status(400).json({ error: 'invalid_json' });
    }

    // ── Validate fields ───────────────────────────────────────────────────────
    if (typeof body.key !== 'string' || body.key.trim() === '') {
        return res.status(400).json({ error: 'missing_key' });
    }
    if (!isValidFingerprint(body.fingerprint)) {
        return res.status(400).json({ error: 'invalid_fingerprint' });
    }
    const device_name = sanitiseDeviceName(body.device_name);

    // ── Hash key and delegate ─────────────────────────────────────────────────
    let keyHash: string;
    try {
        keyHash = await hashKey(body.key);
    } catch (err) {
        console.error('hashKey failed during activate:', err);
        return res.status(500).json({ error: 'server_error' });
    }

    let result;
    try {
        result = await activateDevice(kv, {
            keyHash,
            fingerprint: body.fingerprint,
            device_name,
        });
    } catch (err) {
        console.error('activateDevice failed:', err);
        return res.status(500).json({ error: 'server_error' });
    }

    // ── Translate result to HTTP response ─────────────────────────────────────
    switch (result.status) {
        case 'unregistered':
            return res.status(200).json({ activated: true, registered: false });

        case 'revoked':
            return res.status(403).json({ activated: false, reason: 'revoked' });

        case 'limit_reached':
            return res.status(409).json({
                activated: false,
                reason:    'limit_reached',
                limit:     result.limit,
                devices:   result.devices.map(d => ({
                    device_name:  d.device_name,
                    activated_at: d.activated_at,
                    last_seen_at: d.last_seen_at,
                })),
            });

        case 'activated':
            return res.status(200).json({
                activated:      true,
                existing:       result.existing,
                customer_email: result.record.customer_email,
                limit:          result.record.device_limit,
                devices_used:   result.record.devices.length,
            });
    }
}
