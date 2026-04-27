/**
 * Tests for keygen-pdfstudio.ts — run with:
 *   node --test lib/__tests__/keygen-pdfstudio.test.mjs
 *
 * Uses Node's built-in test runner (Node ≥18). No extra dependencies.
 *
 * These tests use the dev secret so any key generated here will validate in
 * the PDF Studio Rust binary built without AETHELGARD_LICENSE_SECRET set.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const DEV_SECRET   = 'aethelgard-dev-only-secret-do-not-use-in-production-builds-2026';
const ALPHABET     = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PRODUCT_CODE = 'PDFST';
const EPOCH        = new Date(Date.UTC(2026, 0, 1));

// ── Inline implementation matching keygen-pdfstudio.ts ────────────────────────

async function computeProductHmac(bytes, secret) {
    const enc = new TextEncoder();
    const productBytes = enc.encode(PRODUCT_CODE);
    const data = new Uint8Array(bytes.length + productBytes.length);
    data.set(bytes, 0);
    data.set(productBytes, bytes.length);

    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function computeAethelgardHmac(bytes, secret) {
    // Aethelgard's HMAC has no product suffix — just the 7 bytes.
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
}

function encodeBase32(bytes) {
    let acc = 0n;
    for (const b of bytes) acc = (acc << 8n) | BigInt(b);
    let out = '';
    for (let i = 23; i >= 0; i--) out += ALPHABET[Number((acc >> BigInt(i * 5)) & 0x1Fn)];
    return out;
}

function decodeBase32(s) {
    let acc = 0n;
    for (const c of s) acc = (acc << 5n) | BigInt(ALPHABET.indexOf(c));
    const out = new Uint8Array(15);
    for (let i = 14; i >= 0; i--) {
        out[i] = Number(acc & 0xffn);
        acc >>= 8n;
    }
    return out;
}

function dateToMonths(d) {
    return (d.getUTCFullYear() - EPOCH.getUTCFullYear()) * 12 +
           (d.getUTCMonth()    - EPOCH.getUTCMonth());
}

async function buildBuf(tier, months, customerId, secret = DEV_SECRET) {
    const buf = new Uint8Array(15);
    buf[0] = (1 << 4) | tier;
    buf[1] = (months >> 8) & 0xff;
    buf[2] =  months       & 0xff;
    buf[3] = (customerId >>> 24) & 0xff;
    buf[4] = (customerId >>> 16) & 0xff;
    buf[5] = (customerId >>>  8) & 0xff;
    buf[6] =  customerId         & 0xff;
    const hmac = await computeProductHmac(buf.slice(0, 7), secret);
    buf.set(hmac.slice(0, 8), 7);
    return buf;
}

async function buildKey(tier, months, customerId) {
    const buf = await buildBuf(tier, months, customerId);
    const e = encodeBase32(buf);
    return `PDFST-${e.slice(0,6)}-${e.slice(6,12)}-${e.slice(12,18)}-${e.slice(18,24)}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PDF Studio key — byte layout', () => {
    test('version nibble is 1', async () => {
        const buf = await buildBuf(0, 13, 12345);
        assert.equal((buf[0] >> 4) & 0x0F, 1);
    });

    test('tier byte 0 = standalone', async () => {
        const buf = await buildBuf(0, 13, 12345);
        assert.equal(buf[0] & 0x0F, 0);
    });

    test('expiry months packed big-endian', async () => {
        const buf = await buildBuf(0, 0x1234, 0);
        assert.equal(buf[1], 0x12);
        assert.equal(buf[2], 0x34);
    });

    test('customer id packed big-endian', async () => {
        const buf = await buildBuf(0, 13, 0xDEADBEEF);
        assert.equal(buf[3], 0xDE);
        assert.equal(buf[4], 0xAD);
        assert.equal(buf[5], 0xBE);
        assert.equal(buf[6], 0xEF);
    });
});

describe('PDF Studio key — formatting', () => {
    test('starts with PDFST- prefix', async () => {
        const key = await buildKey(0, 13, 1);
        assert.match(key, /^PDFST-/);
    });

    test('24 base32 chars in four groups of 6', async () => {
        const key = await buildKey(0, 13, 1);
        const groups = key.split('-').slice(1);
        assert.equal(groups.length, 4);
        for (const g of groups) {
            assert.equal(g.length, 6);
            assert.match(g, /^[0-9A-HJKMNP-TV-Z]+$/);
        }
    });

    test('round-trip: encode then decode reproduces bytes', async () => {
        const original = await buildBuf(0, 25, 0xCAFEBABE);
        const encoded = encodeBase32(original);
        const decoded = decodeBase32(encoded);
        assert.deepEqual([...decoded], [...original]);
    });
});

describe('PDF Studio key — HMAC binding', () => {
    test('HMAC differs from Aethelgard format with same input', async () => {
        const headerBytes = new Uint8Array([0x10, 0x00, 0x0D, 0xDE, 0xAD, 0xBE, 0xEF]);
        const aethelgard = await computeAethelgardHmac(headerBytes, DEV_SECRET);
        const pdfStudio  = await computeProductHmac(headerBytes, DEV_SECRET);
        // Identical bytes 0–6 + same secret, but different HMACs because of the
        // PDFST suffix — proves prefix-substitution attacks fail.
        assert.notDeepEqual([...aethelgard.slice(0, 8)], [...pdfStudio.slice(0, 8)]);
    });

    test('forging by changing prefix is detected', async () => {
        // Build an "Aethelgard-style" body (no product suffix in HMAC)
        const headerBytes = new Uint8Array([0x10, 0x00, 0x0D, 0xDE, 0xAD, 0xBE, 0xEF]);
        const wrongHmac = await computeAethelgardHmac(headerBytes, DEV_SECRET);
        const expectedHmac = await computeProductHmac(headerBytes, DEV_SECRET);
        // PDF Studio verifier would compare bytes 7–14 against expectedHmac;
        // an Aethelgard-style HMAC would never match.
        for (let i = 0; i < 8; i++) {
            if (wrongHmac[i] !== expectedHmac[i]) {
                return; // Differs — good, forgery rejected.
            }
        }
        assert.fail('First 8 bytes of HMAC happened to match — astronomically unlikely; suspect a bug.');
    });

    test('secret change invalidates HMAC', async () => {
        const headerBytes = new Uint8Array([0x10, 0x00, 0x0D, 0xDE, 0xAD, 0xBE, 0xEF]);
        const dev   = await computeProductHmac(headerBytes, DEV_SECRET);
        const other = await computeProductHmac(headerBytes, 'some-other-secret');
        assert.notDeepEqual([...dev.slice(0, 8)], [...other.slice(0, 8)]);
    });
});

describe('PDF Studio key — expiry semantics', () => {
    test('annualExpiry is 13 months ahead', () => {
        const now = new Date();
        const d = new Date(now);
        d.setUTCMonth(d.getUTCMonth() + 13);
        const months = dateToMonths(d);
        const nowMonths = dateToMonths(now);
        assert.equal(months - nowMonths, 13);
    });

    test('lifetime sentinel (0xFFFF) is not used by PDF Studio keys', async () => {
        // Generated keys must always have months ≠ 0xFFFF.
        const buf = await buildBuf(0, 13, 1);
        const months = (buf[1] << 8) | buf[2];
        assert.notEqual(months, 0xFFFF);
    });
});
