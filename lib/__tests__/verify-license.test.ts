/**
 * Tests for verify-license.ts — run with:
 *   node --loader ts-node/esm --test lib/__tests__/verify-license.test.ts
 *
 * Uses the dev secret so any key generated here will also validate in the
 * Sentinel Rust binary built without AETHELGARD_LICENSE_SECRET set.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
// Node's native --experimental-strip-types resolves the .ts extension at
// runtime; tsc rejects .ts imports unless allowImportingTsExtensions is set
// project-wide. This test runs via `node --experimental-strip-types` (see
// package.json), so the runtime path is fine.
// @ts-expect-error TS5097 — .ts extension intentional for native strip-types
import { verifyLicense } from '../verify-license.ts';

const DEV_SECRET = 'aethelgard-dev-only-secret-do-not-use-in-production-builds-2026';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const EPOCH = new Date(Date.UTC(2026, 0, 1));

// ── Inline keygen mirroring lib/keygen-sentinel.ts and lib/keygen.ts ─────────

function dateToMonths(d: Date): number {
    return (d.getUTCFullYear() - EPOCH.getUTCFullYear()) * 12
        + (d.getUTCMonth() - EPOCH.getUTCMonth());
}

function encodeBase32(bytes: Uint8Array): string {
    let acc = 0n;
    for (const b of bytes) acc = (acc << 8n) | BigInt(b);
    let out = '';
    for (let i = 23; i >= 0; i--) {
        const idx = Number((acc >> BigInt(i * 5)) & 0x1fn);
        out += ALPHABET[idx];
    }
    return out;
}

function buildKey(prefix: string, tier: number, expiryMonths: number, customerId: number, productCode: string): string {
    const buf = new Uint8Array(15);
    buf[0] = (1 << 4) | (tier & 0x0f);
    buf[1] = (expiryMonths >> 8) & 0xff;
    buf[2] = expiryMonths & 0xff;
    buf[3] = (customerId >>> 24) & 0xff;
    buf[4] = (customerId >>> 16) & 0xff;
    buf[5] = (customerId >>> 8) & 0xff;
    buf[6] = customerId & 0xff;

    const mac = createHmac('sha256', DEV_SECRET);
    mac.update(Buffer.from(buf.slice(0, 7)));
    if (productCode) mac.update(Buffer.from(productCode, 'utf8'));
    const digest = mac.digest();
    for (let i = 0; i < 8; i++) buf[7 + i] = digest[i];

    const enc = encodeBase32(buf);
    return `${prefix}-${enc.slice(0, 6)}-${enc.slice(6, 12)}-${enc.slice(12, 18)}-${enc.slice(18, 24)}`;
}

const tierStandalone = 0;
const aethelgardSovereign = 1;
const aethelgardCorporate = 2;
const aethelgardPersonal = 0;
const LIFETIME = 0xFFFF;

// 36 months from epoch = 2029-01-01 — comfortably in the future.
const futureMonths = dateToMonths(new Date(Date.UTC(2029, 0, 1)));
// Negative months → epoch+negative = before 2026 → expired relative to test run date 2026-05-10.
const expiredMonths = dateToMonths(new Date(Date.UTC(2026, 1, 1)));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('verifyLicense — SENTI keys', () => {
    test('valid SENTI standalone key validates', () => {
        const key = buildKey('SENTI', tierStandalone, futureMonths, 1234, 'SENTI');
        const r = verifyLicense(key, DEV_SECRET);
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.equal(r.license.source, 'sentinel-standalone');
            assert.equal(r.license.customerId, 1234);
            assert.ok(r.license.expiresAt instanceof Date);
        }
    });

    test('lifetime SENTI key rejected', () => {
        const key = buildKey('SENTI', tierStandalone, LIFETIME, 1, 'SENTI');
        const r = verifyLicense(key, DEV_SECRET);
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.reason, 'lifetime-not-allowed');
    });

    test('expired SENTI key rejected', () => {
        const key = buildKey('SENTI', tierStandalone, expiredMonths, 1, 'SENTI');
        const r = verifyLicense(key, DEV_SECRET);
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.reason, 'expired');
    });

    test('tampered SENTI key rejected', () => {
        const key = buildKey('SENTI', tierStandalone, futureMonths, 1, 'SENTI');
        // Flip one character in the middle.
        const tampered = key.slice(0, 10) + (key[10] === '0' ? '1' : '0') + key.slice(11);
        const r = verifyLicense(tampered, DEV_SECRET);
        assert.equal(r.ok, false);
        if (!r.ok) {
            assert.ok(
                r.reason === 'signature-mismatch' || r.reason === 'malformed',
                `expected signature-mismatch or malformed, got ${r.reason}`,
            );
        }
    });

    test('cross-format forgery (AETHG body re-prefixed as SENTI) rejected', () => {
        const aethg = buildKey('AETHG', aethelgardSovereign, futureMonths, 999, '');
        const forged = aethg.replace(/^AETHG/, 'SENTI');
        const r = verifyLicense(forged, DEV_SECRET);
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.reason, 'signature-mismatch');
    });
});

describe('verifyLicense — AETHG keys', () => {
    test('Sovereign lifetime AETHG key validates', () => {
        const key = buildKey('AETHG', aethelgardSovereign, LIFETIME, 555, '');
        const r = verifyLicense(key, DEV_SECRET);
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.equal(r.license.source, 'aethelgard-entitled');
            assert.equal(r.license.expiresAt, null);
        }
    });

    test('Corporate annual AETHG key validates', () => {
        const key = buildKey('AETHG', aethelgardCorporate, futureMonths, 777, '');
        const r = verifyLicense(key, DEV_SECRET);
        assert.equal(r.ok, true);
    });

    test('Personal AETHG key rejected for Sentinel proxy', () => {
        const key = buildKey('AETHG', aethelgardPersonal, futureMonths, 1, '');
        const r = verifyLicense(key, DEV_SECRET);
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.reason, 'personal-tier-rejected');
    });

    test('expired AETHG key rejected', () => {
        const key = buildKey('AETHG', aethelgardSovereign, expiredMonths, 1, '');
        const r = verifyLicense(key, DEV_SECRET);
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.reason, 'expired');
    });
});

describe('verifyLicense — malformed input', () => {
    test('empty string', () => {
        const r = verifyLicense('', DEV_SECRET);
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.reason, 'missing');
    });

    test('garbage', () => {
        const r = verifyLicense('not-a-real-key', DEV_SECRET);
        assert.equal(r.ok, false);
        if (!r.ok) assert.ok(r.reason === 'unknown-prefix' || r.reason === 'malformed');
    });

    test('unknown prefix', () => {
        const r = verifyLicense('FOOBR-1234-5678-9ABC-DEFG-HIJK', DEV_SECRET);
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.reason, 'unknown-prefix');
    });

    test('whitespace + lowercase tolerated', () => {
        const key = buildKey('SENTI', tierStandalone, futureMonths, 42, 'SENTI');
        const r = verifyLicense(`  ${key.toLowerCase()}  `, DEV_SECRET);
        assert.equal(r.ok, true);
    });
});

describe('verifyLicense — keyHash', () => {
    test('hash stable across calls', () => {
        const key = buildKey('SENTI', tierStandalone, futureMonths, 1, 'SENTI');
        const a = verifyLicense(key, DEV_SECRET);
        const b = verifyLicense(key, DEV_SECRET);
        assert.equal(a.ok, true);
        assert.equal(b.ok, true);
        if (a.ok && b.ok) assert.equal(a.license.keyHash, b.license.keyHash);
    });

    test('SENTI and AETHG with same body bytes hash differently', () => {
        const senti = buildKey('SENTI', tierStandalone, futureMonths, 1, 'SENTI');
        const aethg = buildKey('AETHG', aethelgardSovereign, futureMonths, 1, '');
        const a = verifyLicense(senti, DEV_SECRET);
        const b = verifyLicense(aethg, DEV_SECRET);
        assert.equal(a.ok, true);
        assert.equal(b.ok, true);
        if (a.ok && b.ok) assert.notEqual(a.license.keyHash, b.license.keyHash);
    });
});
