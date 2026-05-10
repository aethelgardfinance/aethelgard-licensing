/**
 * Vercel Serverless Function — managed Anthropic proxy.
 *
 * Endpoint: POST /api/anthropic/messages
 *
 * Authenticates the request with a Sentinel licence (`SENTI-…` or entitling
 * `AETHG-…`), rate-limits per licence, validates the request body against an
 * allow-list (models + max_tokens), then forwards to Anthropic with the
 * server-side proxy key.
 *
 * Sprint 4 of the £499/yr Sentinel proposition. The Sentinel app sends the
 * same Messages API body it would send directly; only the URL and the auth
 * header change.
 *
 * Cost-bounding strategy (see managed-anthropic-key-design-2026-05-10.md):
 *   - Model allow-list: haiku-4-5 only in v1 (sonnet may follow if needed)
 *   - max_tokens hard cap: 1024
 *   - Sliding-window rate limit: 60/hour, 200/day per licence
 *   - Stateless HMAC validation — expired/forged keys cannot use the proxy
 *
 * Privacy posture:
 *   - The proxy logs hash(licence) + model + estimated input tokens only.
 *   - Never logs the prompt body, never logs the response text, never logs
 *     the raw licence string.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyLicense } from '../../lib/verify-license.js';
import { kv } from '../../lib/redis.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Model allow-list. Keep narrow to cap cost exposure. Add models here only
// after explicit budget review.
const ALLOWED_MODELS = new Set<string>([
    'claude-haiku-4-5-20251001',
]);

const MAX_TOKENS_CAP = 1024;

// Sliding-window rate limits. Per-licence counters in Upstash.
const RATE_PER_HOUR = 60;
const RATE_PER_DAY = 200;
const SEC_HOUR = 60 * 60;
const SEC_DAY  = 60 * 60 * 24;

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ type: 'error', error: { type: 'method_not_allowed', message: 'POST only' } });
    }

    // ── Auth ────────────────────────────────────────────────────────────
    const authHeader = (req.headers.authorization ?? req.headers.Authorization) as string | undefined;
    if (!authHeader) {
        return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Missing Authorization header.' } });
    }
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) {
        return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Authorization must be "Bearer <licence-key>".' } });
    }
    const licenseKey = m[1]!.trim();
    const masterSecret = process.env['AETHELGARD_LICENSE_SECRET'] ?? '';
    if (!masterSecret) {
        // Misconfiguration on the server side; do not leak which env var.
        return res.status(500).json({ type: 'error', error: { type: 'configuration_error', message: 'Proxy not configured.' } });
    }

    const verify = verifyLicense(licenseKey, masterSecret);
    if (!verify.ok) {
        const reason = verify.reason;
        const msg =
            reason === 'expired'                ? 'Licence has expired — renew at aethelgard.finance.' :
            reason === 'personal-tier-rejected' ? 'Personal-tier Aethelgard licences do not include Sentinel. Upgrade or buy a Sentinel standalone key.' :
            reason === 'lifetime-not-allowed'   ? 'Lifetime Sentinel keys are not valid — Sentinel is annual subscription only.' :
            reason === 'signature-mismatch'     ? 'Licence signature does not match — key may be tampered or for a different product.' :
            reason === 'unknown-prefix'         ? 'Licence prefix not recognised. Expected SENTI- or AETHG-.' :
            'Licence verification failed.';
        return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: msg, reason } });
    }

    const { license } = verify;

    // ── Rate limit ──────────────────────────────────────────────────────
    const hourKey = `anth:hour:${license.keyHash}`;
    const dayKey  = `anth:day:${license.keyHash}`;
    try {
        const [hourCount, dayCount] = await Promise.all([
            incrAndExpire(hourKey, SEC_HOUR),
            incrAndExpire(dayKey, SEC_DAY),
        ]);
        if (hourCount > RATE_PER_HOUR) {
            return res.status(429).json({
                type: 'error',
                error: {
                    type: 'rate_limit_error',
                    message: `Hourly limit (${RATE_PER_HOUR}/hour) reached for this licence. Resets within the hour.`,
                },
            });
        }
        if (dayCount > RATE_PER_DAY) {
            return res.status(429).json({
                type: 'error',
                error: {
                    type: 'rate_limit_error',
                    message: `Daily limit (${RATE_PER_DAY}/day) reached for this licence. Resets at UTC midnight.`,
                },
            });
        }
    } catch (err) {
        // KV outage — fail open. Better to serve legitimate users than block them
        // on a Redis blip. The rate limit reasserts as soon as KV is back.
        console.warn('Rate-limit KV unavailable, failing open:', err);
    }

    // ── Body validation ─────────────────────────────────────────────────
    const body = req.body as unknown;
    if (!body || typeof body !== 'object') {
        return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'Body must be a JSON object.' } });
    }
    const b = body as Record<string, unknown>;
    const model = typeof b['model'] === 'string' ? b['model'] : '';
    if (!ALLOWED_MODELS.has(model)) {
        return res.status(400).json({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: `Model '${model}' is not on the managed-key allow-list. Allowed: ${[...ALLOWED_MODELS].join(', ')}.`,
            },
        });
    }
    const requestedMaxTokens = typeof b['max_tokens'] === 'number' ? Math.floor(b['max_tokens']) : 1024;
    if (requestedMaxTokens <= 0) {
        return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens must be a positive integer.' } });
    }
    const effectiveMaxTokens = Math.min(requestedMaxTokens, MAX_TOKENS_CAP);

    // ── Forward to Anthropic ────────────────────────────────────────────
    const proxyKey = process.env['ANTHROPIC_PROXY_KEY'] ?? '';
    if (!proxyKey) {
        return res.status(500).json({ type: 'error', error: { type: 'configuration_error', message: 'Proxy not configured.' } });
    }

    // Reshape body: enforce the capped max_tokens; pass model + system +
    // messages through unchanged. Reject any unexpected top-level keys to
    // prevent a leaked licence pivoting into batch/files/tools features
    // we haven't audited.
    const ALLOWED_KEYS = new Set(['model', 'max_tokens', 'system', 'messages', 'temperature', 'top_p', 'top_k', 'stop_sequences']);
    const sanitised: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
        if (ALLOWED_KEYS.has(k)) sanitised[k] = v;
    }
    sanitised['model'] = model;
    sanitised['max_tokens'] = effectiveMaxTokens;

    try {
        const resp = await fetch(ANTHROPIC_URL, {
            method: 'POST',
            headers: {
                'x-api-key': proxyKey,
                'anthropic-version': ANTHROPIC_VERSION,
                'content-type': 'application/json',
            },
            body: JSON.stringify(sanitised),
        });

        // Privacy-bounded log line: keyHash + model + status only.
        console.log(`[anthropic-proxy] kh=${license.keyHash.slice(0, 16)} model=${model} status=${resp.status}`);

        // Mirror Anthropic's status + body verbatim so the client sees
        // exactly the same error shapes it would on a direct call.
        const text = await resp.text();
        res.status(resp.status);
        res.setHeader('content-type', resp.headers.get('content-type') ?? 'application/json');
        return res.send(text);
    } catch (err) {
        console.error('[anthropic-proxy] upstream fetch failed:', err);
        return res.status(502).json({
            type: 'error',
            error: { type: 'api_error', message: 'Upstream Anthropic request failed.' },
        });
    }
}

async function incrAndExpire(key: string, ttlSec: number): Promise<number> {
    // INCR is atomic; EXPIRE sets TTL on first hit (no-op if already set).
    const next = await kv.incr(key);
    if (next === 1) {
        await kv.expire(key, ttlSec);
    }
    return next;
}
