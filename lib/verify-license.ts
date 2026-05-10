/**
 * Stateless licence verifier for proxy endpoints.
 *
 * Mirrors Sentinel's Rust `license::validate` (`apps/sentinel/src-tauri/
 * src/license.rs`). Validates HMAC + expiry + tier rules without any KV
 * lookup so a Redis outage cannot block legitimate users.
 *
 * Accepts both `SENTI-XXXXXX-XXXXXX-XXXXXX-XXXXXX` (standalone) and
 * `AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX` (entitling Aethelgard) keys.
 * Rejects Personal-tier AETHG (tier 0) — those holders do not have
 * Sentinel access.
 *
 * Used by `api/anthropic/messages.ts` (sprint 4 proxy). The Sentinel
 * app does its own offline verification in Rust; this is the JS
 * counterpart for proxy authentication.
 */

import { createHash, createHmac } from 'crypto';

export type LicenseSource = 'sentinel-standalone' | 'aethelgard-entitled';

export interface VerifiedLicense {
    source: LicenseSource;
    /** Crockford-decoded customer ID (random u32, generated at issuance). */
    customerId: number;
    /** `null` only for lifetime AETHG keys (Sovereign or Corporate). */
    expiresAt: Date | null;
    /** SHA-256 hash of the normalised key — stable identifier for rate-limit keys. */
    keyHash: string;
}

export type VerifyResult =
    | { ok: true; license: VerifiedLicense }
    | { ok: false; reason: VerifyFailureReason; detail?: string };

export type VerifyFailureReason =
    | 'missing'
    | 'malformed'
    | 'unknown-prefix'
    | 'unsupported-version'
    | 'unknown-tier'
    | 'personal-tier-rejected'
    | 'signature-mismatch'
    | 'lifetime-not-allowed'
    | 'expired';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const EPOCH = new Date(Date.UTC(2026, 0, 1));
const LIFETIME = 0xFFFF;
const AETHELGARD_TIER_PERSONAL = 0;
const PRODUCT_CODE_SENTI = 'SENTI';

export function verifyLicense(rawKey: string, masterSecret: string): VerifyResult {
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
        return { ok: false, reason: 'missing' };
    }

    const normalised = rawKey.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

    let source: LicenseSource;
    let body: string;
    if (normalised.startsWith('SENTI')) {
        source = 'sentinel-standalone';
        body = normalised.slice(5);
    } else if (normalised.startsWith('AETHG')) {
        source = 'aethelgard-entitled';
        body = normalised.slice(5);
    } else if (normalised.length === 24) {
        // Bare 24-char body — treat as AETHG (legacy behaviour matching the Rust verifier).
        source = 'aethelgard-entitled';
        body = normalised;
    } else {
        return { ok: false, reason: 'unknown-prefix' };
    }

    if (body.length !== 24) {
        return { ok: false, reason: 'malformed', detail: `body length ${body.length}, expected 24` };
    }

    let bytes: Uint8Array;
    try {
        bytes = decodeBase32(body);
    } catch (err) {
        return { ok: false, reason: 'malformed', detail: String(err) };
    }

    const versionAndTier = bytes[0]!;
    if ((versionAndTier >> 4) !== 1) {
        return { ok: false, reason: 'unsupported-version' };
    }
    const tier = versionAndTier & 0x0f;
    const expiryMonths = (bytes[1]! << 8) | bytes[2]!;
    const customerId =
        ((bytes[3]! << 24) | (bytes[4]! << 16) | (bytes[5]! << 8) | bytes[6]!) >>> 0;

    // HMAC verification — same shape as license.rs.
    const macInput = bytes.slice(0, 7);
    const macSuffix = source === 'sentinel-standalone'
        ? Buffer.from(PRODUCT_CODE_SENTI, 'utf8')
        : Buffer.alloc(0);
    const expected = computeHmac(macInput, macSuffix, masterSecret);
    if (!constantTimeEqual(bytes.subarray(7, 15), expected.subarray(0, 8))) {
        return { ok: false, reason: 'signature-mismatch' };
    }

    if (source === 'aethelgard-entitled' && tier === AETHELGARD_TIER_PERSONAL) {
        return { ok: false, reason: 'personal-tier-rejected' };
    }

    let expiresAt: Date | null;
    if (expiryMonths === LIFETIME) {
        if (source === 'sentinel-standalone') {
            return { ok: false, reason: 'lifetime-not-allowed' };
        }
        expiresAt = null;
    } else {
        expiresAt = monthsToDate(expiryMonths);
        if (expiresAt.getTime() < Date.now()) {
            return { ok: false, reason: 'expired', detail: expiresAt.toISOString() };
        }
    }

    const keyHash = sha256Hex(normalised);

    return {
        ok: true,
        license: {
            source,
            customerId,
            expiresAt,
            keyHash,
        },
    };
}

// ── Internal helpers ────────────────────────────────────────────────────

function decodeBase32(s: string): Uint8Array {
    let acc = 0n;
    for (const c of s) {
        const idx = ALPHABET.indexOf(c);
        if (idx === -1) throw new Error(`invalid base32 char '${c}'`);
        acc = (acc << 5n) | BigInt(idx);
    }
    const out = new Uint8Array(15);
    for (let i = 14; i >= 0; i--) {
        out[i] = Number(acc & 0xffn);
        acc >>= 8n;
    }
    return out;
}

function monthsToDate(months: number): Date {
    const d = new Date(EPOCH);
    d.setUTCMonth(d.getUTCMonth() + months);
    return d;
}

function computeHmac(input: Uint8Array, suffix: Buffer, secret: string): Buffer {
    const mac = createHmac('sha256', secret);
    mac.update(input);
    if (suffix.length > 0) mac.update(suffix);
    return mac.digest();
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
    return diff === 0;
}

function sha256Hex(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}
