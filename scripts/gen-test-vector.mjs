/**
 * Generates a deterministic test vector key for cross-language validation.
 *
 * Inputs must stay fixed forever — changing them would break the Rust test.
 *   tier:       Corporate (2)
 *   customerId: 12345
 *   expiry:     null (lifetime)
 *   secret:     dev fallback (same value embedded in license.rs MASTER_SECRET)
 *
 * Usage (from aethelgard-licensing/):
 *   node scripts/gen-test-vector.mjs
 *
 * Output: the key string, suitable for pasting into the Rust test.
 */

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
    const sig = await crypto.subtle.sign('HMAC', key, data);
    return new Uint8Array(sig);
}

function encodeBase32(bytes) {
    let acc = 0n;
    for (const b of bytes) acc = (acc << 8n) | BigInt(b);
    let out = '';
    for (let i = 23; i >= 0; i--) {
        out += ALPHABET[Number((acc >> BigInt(i * 5)) & 0x1Fn)];
    }
    return out;
}

async function generate() {
    const tier       = 2;       // Corporate
    const customerId = 12345;   // 0x00003039
    const months     = LIFETIME; // lifetime

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

    const e = encodeBase32(buf);
    const key = `AETHG-${e.slice(0,6)}-${e.slice(6,12)}-${e.slice(12,18)}-${e.slice(18,24)}`;

    console.log(key);
}

generate();
