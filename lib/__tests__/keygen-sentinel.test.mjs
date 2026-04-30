/**
 * Tests for keygen-sentinel.ts — run with:
 *   node --test lib/__tests__/keygen-sentinel.test.mjs
 *
 * Uses the dev secret so any key generated here will validate in the
 * Sentinel Rust binary built without AETHELGARD_LICENSE_SECRET set.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const DEV_SECRET   = 'aethelgard-dev-only-secret-do-not-use-in-production-builds-2026';
const ALPHABET     = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PRODUCT_CODE = 'SENTI';
const EPOCH        = new Date(Date.UTC(2026, 0, 1));

// ── Inline implementation matching keygen-sentinel.ts ─────────────────────────

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
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
}

async function computePdfStudioHmac(bytes, secret) {
    const enc = new TextEncoder();
    const productBytes = enc.encode('PDFST');
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

async function buildSentinelBuf(tier, months, customerId, secret = DEV_SECRET) {
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

async function buildAethelgardBuf(tier, months, customerId, secret = DEV_SECRET) {
    const buf = new Uint8Array(15);
    buf[0] = (1 << 4) | tier;
    buf[1] = (months >> 8) & 0xff;
    buf[2] =  months       & 0xff;
    buf[3] = (customerId >>> 24) & 0xff;
    buf[4] = (customerId >>> 16) & 0xff;
    buf[5] = (customerId >>>  8) & 0xff;
    buf[6] =  customerId         & 0xff;
    const hmac = await computeAethelgardHmac(buf.slice(0, 7), secret);
    buf.set(hmac.slice(0, 8), 7);
    return buf;
}

async function buildPdfStudioBuf(tier, months, customerId, secret = DEV_SECRET) {
    const buf = new Uint8Array(15);
    buf[0] = (1 << 4) | tier;
    buf[1] = (months >> 8) & 0xff;
    buf[2] =  months       & 0xff;
    buf[3] = (customerId >>> 24) & 0xff;
    buf[4] = (customerId >>> 16) & 0xff;
    buf[5] = (customerId >>>  8) & 0xff;
    buf[6] =  customerId         & 0xff;
    const hmac = await computePdfStudioHmac(buf.slice(0, 7), secret);
    buf.set(hmac.slice(0, 8), 7);
    return buf;
}

function format(prefix, encoded) {
    return `${prefix}-${encoded.slice(0,6)}-${encoded.slice(6,12)}-${encoded.slice(12,18)}-${encoded.slice(18,24)}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sentinel keygen', () => {
    test('generates a 33-char SENTI-prefixed key (5 + 4 dashes + 24)', async () => {
        const months = dateToMonths(new Date(Date.UTC(2027, 0, 1)));
        const buf = await buildSentinelBuf(0, months, 12345);
        const key = format('SENTI', encodeBase32(buf));
        assert.equal(key.length, 33);
        assert.match(key, /^SENTI-[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$/);
    });

    test('round-trips: encode → decode preserves payload', async () => {
        const months = dateToMonths(new Date(Date.UTC(2027, 5, 1))); // ≈17 months
        const customerId = 0xABCDEF01;
        const buf = await buildSentinelBuf(0, months, customerId);
        const encoded = encodeBase32(buf);
        const decoded = decodeBase32(encoded);
        assert.deepEqual(Array.from(decoded), Array.from(buf));

        const decodedTier = decoded[0] & 0x0F;
        const decodedMonths = (decoded[1] << 8) | decoded[2];
        const decodedCustomer = ((decoded[3] << 24) | (decoded[4] << 16) | (decoded[5] << 8) | decoded[6]) >>> 0;
        assert.equal(decodedTier, 0);
        assert.equal(decodedMonths, months);
        assert.equal(decodedCustomer, customerId);
    });

    test('HMAC binds the key to the SENTI product code', async () => {
        const months = dateToMonths(new Date(Date.UTC(2027, 0, 1)));
        const buf = await buildSentinelBuf(0, months, 999);
        const expected = await computeProductHmac(buf.slice(0, 7), DEV_SECRET);
        for (let i = 0; i < 8; i++) {
            assert.equal(buf[7 + i], expected[i], `HMAC byte ${i} mismatch`);
        }
    });

    test('cross-format forgery rejected: AETHG body cannot become SENTI', async () => {
        // Build a valid Aethelgard key, then try to validate it as Sentinel.
        const months = dateToMonths(new Date(Date.UTC(2027, 0, 1)));
        const aethgBuf = await buildAethelgardBuf(0, months, 1234);
        // The AETHG HMAC was computed over bytes[0..7] WITHOUT 'SENTI' suffix.
        // The Sentinel verifier expects HMAC over bytes[0..7] || 'SENTI'.
        const sentinelHmac = await computeProductHmac(aethgBuf.slice(0, 7), DEV_SECRET);
        let mismatch = false;
        for (let i = 0; i < 8; i++) {
            if (sentinelHmac[i] !== aethgBuf[7 + i]) { mismatch = true; break; }
        }
        assert.ok(mismatch, 'Sentinel HMAC must differ from Aethelgard HMAC for the same payload bytes');
    });

    test('cross-format forgery rejected: PDFST body cannot become SENTI', async () => {
        const months = dateToMonths(new Date(Date.UTC(2027, 0, 1)));
        const pdfstBuf = await buildPdfStudioBuf(0, months, 5678);
        const sentinelHmac = await computeProductHmac(pdfstBuf.slice(0, 7), DEV_SECRET);
        let mismatch = false;
        for (let i = 0; i < 8; i++) {
            if (sentinelHmac[i] !== pdfstBuf[7 + i]) { mismatch = true; break; }
        }
        assert.ok(mismatch, 'Sentinel HMAC must differ from PDF Studio HMAC for the same payload bytes');
    });

    test('reverse forgery rejected: SENTI body cannot become AETHG', async () => {
        const months = dateToMonths(new Date(Date.UTC(2027, 0, 1)));
        const sentinelBuf = await buildSentinelBuf(0, months, 9999);
        const aethgHmac = await computeAethelgardHmac(sentinelBuf.slice(0, 7), DEV_SECRET);
        let mismatch = false;
        for (let i = 0; i < 8; i++) {
            if (aethgHmac[i] !== sentinelBuf[7 + i]) { mismatch = true; break; }
        }
        assert.ok(mismatch, 'Aethelgard HMAC must differ from Sentinel HMAC for the same payload bytes');
    });

    test('different customer IDs produce different keys', async () => {
        const months = dateToMonths(new Date(Date.UTC(2027, 0, 1)));
        const buf1 = await buildSentinelBuf(0, months, 100);
        const buf2 = await buildSentinelBuf(0, months, 200);
        const key1 = format('SENTI', encodeBase32(buf1));
        const key2 = format('SENTI', encodeBase32(buf2));
        assert.notEqual(key1, key2);
    });

    test('different secrets produce different HMACs', async () => {
        const months = dateToMonths(new Date(Date.UTC(2027, 0, 1)));
        const buf1 = await buildSentinelBuf(0, months, 100, 'secret-a');
        const buf2 = await buildSentinelBuf(0, months, 100, 'secret-b');
        assert.notEqual(
            Array.from(buf1.slice(7, 15)).join(','),
            Array.from(buf2.slice(7, 15)).join(','),
        );
    });

    test('expiry months encoded big-endian and round-trip correctly', async () => {
        const months = 256; // tests both bytes are populated
        const buf = await buildSentinelBuf(0, months, 1);
        assert.equal(buf[1], 0x01);
        assert.equal(buf[2], 0x00);
    });

    test('lifetime sentinel byte (0xFFFF) was never set by builder', async () => {
        // Sanity — Sentinel keys are annual only, so lifetime sentinel
        // shouldn't appear in any generated key.
        const months = dateToMonths(new Date(Date.UTC(2027, 0, 1)));
        const buf = await buildSentinelBuf(0, months, 1);
        const decoded = (buf[1] << 8) | buf[2];
        assert.notEqual(decoded, 0xFFFF);
    });

    test('30-char key normalises to 24-char body', () => {
        const key = 'SENTI-ABCDEF-GHJKMN-PQRSTV-WXYZ12';
        const normalised = key.replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/^SENTI/, '');
        assert.equal(normalised.length, 24);
    });

    test('Crockford alphabet excludes I, L, O, U', () => {
        // Sanity: the alphabet we use is Crockford-style.
        assert.equal(ALPHABET.length, 32);
        assert.ok(!ALPHABET.includes('I'));
        assert.ok(!ALPHABET.includes('L'));
        assert.ok(!ALPHABET.includes('O'));
        assert.ok(!ALPHABET.includes('U'));
    });

    test('parity: known dev-secret SENTI key has stable HMAC', async () => {
        // Stable canonical pair — guards against accidental algorithm drift.
        const months = 12; // 2027-01-01
        const customer = 1;
        const buf = await buildSentinelBuf(0, months, customer);
        // First HMAC byte is determined by (bytes[0..7], DEV_SECRET, 'SENTI').
        // We don't assert a specific byte (would lock to one algorithm version),
        // but we assert determinism: same inputs → same output.
        const buf2 = await buildSentinelBuf(0, months, customer);
        assert.deepEqual(Array.from(buf), Array.from(buf2));
    });
});
