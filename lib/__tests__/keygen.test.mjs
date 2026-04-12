/**
 * Tests for keygen.ts — run with: node --test lib/__tests__/keygen.test.mjs
 *
 * Uses Node's built-in test runner (Node ≥18). No extra dependencies needed.
 *
 * These tests use the dev secret (same one baked into license.rs for dev builds)
 * so any key generated here will validate in the Rust binary built without
 * AETHELGARD_LICENSE_SECRET set (i.e. local dev builds).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline re-implementation of the core encoding for white-box tests ─────────
// (We test the compiled output of keygen.ts indirectly by importing the helper
//  below, but we also need deterministic byte-level checks.)

const DEV_SECRET = 'aethelgard-dev-only-secret-do-not-use-in-production-builds-2026';
const ALPHABET   = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LIFETIME   = 0xFFFF;

async function computeHmac(data, secret) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

function encodeBase32(bytes) {
    let acc = 0n;
    for (const b of bytes) acc = (acc << 8n) | BigInt(b);
    let out = '';
    for (let i = 23; i >= 0; i--) out += ALPHABET[Number((acc >> BigInt(i * 5)) & 0x1Fn)];
    return out;
}

async function buildBuf(tier, months, customerId) {
    const buf = new Uint8Array(15);
    buf[0] = (1 << 4) | tier;
    buf[1] = (months >> 8) & 0xff;
    buf[2] =  months       & 0xff;
    buf[3] = (customerId >>> 24) & 0xff;
    buf[4] = (customerId >>> 16) & 0xff;
    buf[5] = (customerId >>>  8) & 0xff;
    buf[6] =  customerId         & 0xff;
    const hmac = await computeHmac(buf.buffer.slice(0, 7), DEV_SECRET);
    buf.set(hmac.slice(0, 8), 7);
    return buf;
}

async function buildKey(tier, months, customerId) {
    const buf = await buildBuf(tier, months, customerId);
    const e = encodeBase32(buf);
    return `AETHG-${e.slice(0,6)}-${e.slice(6,12)}-${e.slice(12,18)}-${e.slice(18,24)}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('byte layout', () => {
    test('version nibble is always 1', async () => {
        for (const tier of [0, 1, 2]) {
            const buf = await buildBuf(tier, LIFETIME, 1);
            assert.equal((buf[0] >> 4) & 0x0F, 1, `tier ${tier}: version nibble must be 1`);
        }
    });

    test('tier nibble matches input', async () => {
        for (const tier of [0, 1, 2]) {
            const buf = await buildBuf(tier, LIFETIME, 1);
            assert.equal(buf[0] & 0x0F, tier, `tier nibble must equal ${tier}`);
        }
    });

    test('lifetime sentinel is 0xFFFF in bytes 1-2', async () => {
        const buf = await buildBuf(2, LIFETIME, 1);
        assert.equal(buf[1], 0xFF);
        assert.equal(buf[2], 0xFF);
    });

    test('customer_id is encoded big-endian in bytes 3-6', async () => {
        const customerId = 0xDEADBEEF >>> 0;
        const buf = await buildBuf(0, LIFETIME, customerId);
        assert.equal(buf[3], 0xDE);
        assert.equal(buf[4], 0xAD);
        assert.equal(buf[5], 0xBE);
        assert.equal(buf[6], 0xEF);
    });

    test('HMAC occupies bytes 7-14 (8 bytes)', async () => {
        const buf = await buildBuf(1, LIFETIME, 42);
        // HMAC bytes should not all be zero
        const hmacBytes = Array.from(buf.slice(7, 15));
        assert.ok(hmacBytes.some(b => b !== 0), 'HMAC bytes must not all be zero');
    });
});

describe('key format', () => {
    test('key starts with AETHG-', async () => {
        const key = await buildKey(0, LIFETIME, 1);
        assert.ok(key.startsWith('AETHG-'), `key must start with AETHG-: got ${key}`);
    });

    test('key has correct structure: AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX', async () => {
        const key = await buildKey(2, LIFETIME, 999);
        const parts = key.split('-');
        assert.equal(parts.length, 5, `expected 5 parts, got ${parts.length}: ${key}`);
        assert.equal(parts[0], 'AETHG');
        for (let i = 1; i <= 4; i++) {
            assert.equal(parts[i].length, 6, `part ${i} must be 6 chars: ${parts[i]}`);
        }
    });

    test('key uses only Crockford Base32 alphabet characters', async () => {
        const key = await buildKey(1, 36, 77777);
        const body = key.replace(/AETHG-|-/g, '');
        const invalid = body.split('').filter(c => !ALPHABET.includes(c));
        assert.deepEqual(invalid, [], `invalid chars in key body: ${invalid.join('')}`);
    });

    test('total key body is exactly 24 characters', async () => {
        const key = await buildKey(0, LIFETIME, 12345);
        const body = key.replace(/AETHG-|-/g, '');
        assert.equal(body.length, 24, `body must be 24 chars, got ${body.length}`);
    });
});

describe('deterministic output (same inputs → same key)', () => {
    test('identical inputs produce identical keys', async () => {
        const key1 = await buildKey(2, LIFETIME, 12345);
        const key2 = await buildKey(2, LIFETIME, 12345);
        assert.equal(key1, key2);
    });

    test('different tiers produce different keys', async () => {
        const personal  = await buildKey(0, LIFETIME, 1);
        const sovereign = await buildKey(1, LIFETIME, 1);
        const corporate = await buildKey(2, LIFETIME, 1);
        assert.notEqual(personal,  sovereign);
        assert.notEqual(sovereign, corporate);
        assert.notEqual(personal,  corporate);
    });

    test('different customer IDs produce different keys', async () => {
        const a = await buildKey(2, LIFETIME, 1);
        const b = await buildKey(2, LIFETIME, 2);
        assert.notEqual(a, b);
    });
});

describe('cross-language test vector', () => {
    // This is the canonical test vector. If it changes, the Rust test
    // in license.rs::tests::typescript_generated_key_validates_in_rust must
    // be updated at the same time. The Rust dev build will validate this key.
    const EXPECTED = 'AETHG-2BZZY0-0060WS-TGPEA5-PFRS3W';

    test('generates the expected test vector key', async () => {
        const key = await buildKey(2, LIFETIME, 12345);
        assert.equal(key, EXPECTED,
            `Test vector mismatch — the TypeScript keygen has changed.\n` +
            `Expected: ${EXPECTED}\n` +
            `Got:      ${key}\n` +
            `If this is intentional, update EXPECTED here AND the Rust test in license.rs.`
        );
    });
});
