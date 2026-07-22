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

// ── Global daily ceiling ────────────────────────────────────────────────────
// The per-licence limits above bound ONE licence. They do not bound the bill:
// total spend scales linearly with licences issued, and every call is charged
// to a single Anthropic account. A leaked key, a bulk re-issuance, or simply
// more customers than expected all show up as cost with nothing to stop them.
//
// This is a ceiling on the whole proxy, across all licences, per UTC day.
// Sizing (haiku-4.5, max_tokens capped at 1024): a call costs roughly
// $0.005-0.01, so 1,000 calls/day is on the order of $5-10/day worst case.
// Tune via ANTHROPIC_PROXY_GLOBAL_DAILY_CAP without a redeploy.
//
// NOTE: this is defence in depth, not the backstop. It lives in the same
// process as the thing it limits and depends on KV being up (see the
// fail-open note below). The real backstop is a spend limit configured on the
// Anthropic account itself, which cannot fail open. Set both.
const GLOBAL_PER_DAY = (() => {
    const raw = process.env['ANTHROPIC_PROXY_GLOBAL_DAILY_CAP'];
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 1000;
})();

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
    const globalKey = `anth:global:day:${utcDay()}`;
    try {
        const [hourCount, dayCount, globalCount] = await Promise.all([
            incrAndExpire(hourKey, SEC_HOUR),
            incrAndExpire(dayKey, SEC_DAY),
            incrAndExpire(globalKey, SEC_DAY),
        ]);
        if (globalCount > GLOBAL_PER_DAY) {
            // Deliberately loud: crossing this means either unexpected demand
            // or something wrong. It should never be hit in normal operation,
            // so a hit is worth investigating rather than just raising the cap.
            console.error(
                `[anthropic-proxy] GLOBAL DAILY CAP HIT — ${globalCount}/${GLOBAL_PER_DAY} calls on ${utcDay()}. ` +
                `All managed-mode AI is now refused until UTC midnight. Check for a leaked licence or raise ` +
                `ANTHROPIC_PROXY_GLOBAL_DAILY_CAP if this is genuine demand.`,
            );
            return res.status(429).json({
                type: 'error',
                error: {
                    type: 'rate_limit_error',
                    message:
                        'The managed AI service has reached its daily capacity. ' +
                        'This is a limit on the service, not on your licence. It resets at UTC midnight — ' +
                        'or switch Settings to your own Anthropic key to continue now.',
                },
            });
        }
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
        //
        // Be clear-eyed about what this costs: while KV is down there is NO
        // rate limit and NO global cap, so spend is unbounded for the duration
        // of the outage. That is an accepted trade (an Upstash outage taking
        // out a paid-for feature is the worse failure at this scale), but it is
        // exactly why an account-level spend limit at Anthropic is required as
        // well — it is the only control here that cannot fail open.
        console.error('[anthropic-proxy] KV UNAVAILABLE — rate limit AND global cap are OFF, spend is uncapped until it recovers:', err);
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

        // Mirror Anthropic's status + body verbatim so the client sees
        // exactly the same error shapes it would on a direct call.
        const text = await resp.text();

        // Accumulate real token usage for the day. Calls are a poor proxy for
        // cost — a 200-token question and a 4,000-token ledger summary bill
        // very differently — so without this there is no honest answer to
        // "what is this costing?", which is the question a spend alert exists
        // to answer. Tokens only: no content, no identifiers.
        const usage = extractUsage(text);
        let dayTokens: { input: number; output: number } | null = null;
        if (usage) {
            dayTokens = await recordUsage(usage).catch((err) => {
                // Accounting must never break the response the user is waiting for.
                console.warn('[anthropic-proxy] usage accounting failed (request itself was fine):', err);
                return null;
            });
        }

        // Privacy-bounded log line: keyHash + model + status, plus this call's
        // tokens and the running day total. Grep `day_in=` to see the trend.
        const usagePart = usage ? ` in=${usage.input} out=${usage.output}` : '';
        const dayPart = dayTokens ? ` day_in=${dayTokens.input} day_out=${dayTokens.output}` : '';
        console.log(`[anthropic-proxy] kh=${license.keyHash.slice(0, 16)} model=${model} status=${resp.status}${usagePart}${dayPart}`);

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

/** Current UTC date as `YYYY-MM-DD` — the bucket key for per-day counters. */
function utcDay(): string {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Pull `usage.input_tokens` / `usage.output_tokens` out of an Anthropic
 * response body. Returns null for error responses, non-JSON, or any shape we
 * do not recognise — accounting is best-effort and must never throw into the
 * request path.
 */
function extractUsage(body: string): { input: number; output: number } | null {
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const usage = parsed['usage'];
        if (!usage || typeof usage !== 'object') return null;
        const u = usage as Record<string, unknown>;
        const input = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : 0;
        const output = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : 0;
        if (input === 0 && output === 0) return null;
        return { input, output };
    } catch {
        return null;
    }
}

/**
 * Add this call's tokens to the running UTC-day totals and return the new
 * totals. Keys expire after a day, so this is a rolling window with no
 * retention and nothing to clean up.
 */
async function recordUsage(usage: { input: number; output: number }): Promise<{ input: number; output: number }> {
    const day = utcDay();
    const inKey = `anth:tokens:in:${day}`;
    const outKey = `anth:tokens:out:${day}`;
    const [input, output] = await Promise.all([
        incrByAndExpire(inKey, usage.input, SEC_DAY),
        incrByAndExpire(outKey, usage.output, SEC_DAY),
    ]);
    return { input, output };
}

async function incrByAndExpire(key: string, by: number, ttlSec: number): Promise<number> {
    const next = await kv.incrby(key, by);
    // Set the TTL when the counter is first created. `next === by` is the
    // first-write signal (INCRBY from absent starts at 0).
    if (next === by) {
        await kv.expire(key, ttlSec);
    }
    return next;
}
