/**
 * CLI tool to generate a single Aethelgard Sentinel license key.
 *
 * Usage (from aethelgard-licensing/):
 *   node scripts/generate-key-sentinel.mjs
 *   node scripts/generate-key-sentinel.mjs --tier standalone
 *   node scripts/generate-key-sentinel.mjs --customer-id 1234
 *
 * Sentinel is annual-only (no lifetime). Key expires 13 months from now.
 *
 * Reads AETHELGARD_LICENSE_SECRET from environment.
 * Falls back to the dev secret if not set (DEV ONLY — not for issued keys).
 */

const DEV_SECRET = 'aethelgard-dev-only-secret-do-not-use-in-production-builds-2026';
const SECRET     = process.env.AETHELGARD_LICENSE_SECRET ?? DEV_SECRET;

const TIER_BYTE    = { standalone: 0 };
const ALPHABET     = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PRODUCT_CODE = 'SENTI';
const EPOCH        = new Date(Date.UTC(2026, 0, 1));

const args = process.argv.slice(2);
const tier = optArg('--tier') ?? 'standalone';
const customerIdArg = optArg('--customer-id');

if (!(tier in TIER_BYTE)) {
    console.error(`Unknown tier '${tier}'. Sentinel only supports 'standalone'.`);
    process.exit(1);
}

const customerId = customerIdArg !== null
    ? Number(customerIdArg)
    : randomU32();
if (!Number.isFinite(customerId) || customerId < 0 || customerId > 0xffffffff) {
    console.error('--customer-id must be a non-negative u32.');
    process.exit(1);
}

const expiry = annualExpiry();
const months = dateToMonths(expiry);

const buf = new Uint8Array(15);
buf[0] = (1 << 4) | TIER_BYTE[tier];
buf[1] = (months >> 8) & 0xff;
buf[2] =  months       & 0xff;
buf[3] = (customerId >>> 24) & 0xff;
buf[4] = (customerId >>> 16) & 0xff;
buf[5] = (customerId >>>  8) & 0xff;
buf[6] =  customerId         & 0xff;

const hmac = await computeProductHmac(buf.slice(0, 7), SECRET);
buf.set(hmac.slice(0, 8), 7);

const e = encodeBase32(buf);
const key = `SENTI-${e.slice(0,6)}-${e.slice(6,12)}-${e.slice(12,18)}-${e.slice(18,24)}`;

console.error(`Tier:       ${tier}`);
console.error(`Customer:   ${customerId}`);
console.error(`Expiry:     ${expiry.toISOString().slice(0, 10)}`);
console.error(`Secret:     ${SECRET === DEV_SECRET ? 'DEV (dev binary only)' : 'PROD'}`);
console.log(key);

// ── helpers ──────────────────────────────────────────────────────────────────

function optArg(flag) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
}

function randomU32() {
    const b = new Uint8Array(4);
    crypto.getRandomValues(b);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

function annualExpiry() {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 13);
    return d;
}

function dateToMonths(d) {
    const months =
        (d.getUTCFullYear() - EPOCH.getUTCFullYear()) * 12 +
        (d.getUTCMonth()    - EPOCH.getUTCMonth());
    return Math.max(0, Math.min(0xfffe, months));
}

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

function encodeBase32(bytes) {
    let acc = 0n;
    for (const b of bytes) acc = (acc << 8n) | BigInt(b);
    let out = '';
    for (let i = 23; i >= 0; i--) {
        out += ALPHABET[Number((acc >> BigInt(i * 5)) & 0x1fn)];
    }
    return out;
}
