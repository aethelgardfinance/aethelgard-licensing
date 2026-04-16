/**
 * CLI tool to generate a single Aethelgard license key.
 *
 * Usage (from aethelgard-licensing/):
 *   node scripts/generate-key.mjs --tier corporate --expiry annual
 *   node scripts/generate-key.mjs --tier sovereign --expiry lifetime
 *   node scripts/generate-key.mjs --tier personal  --expiry annual
 *
 * Options:
 *   --tier     personal | sovereign | corporate   (required)
 *   --expiry   annual | lifetime                  (required)
 *
 * Reads AETHELGARD_LICENSE_SECRET from environment.
 * Falls back to the dev secret if not set.
 */

const DEV_SECRET = 'aethelgard-dev-only-secret-do-not-use-in-production-builds-2026';
const SECRET     = process.env.AETHELGARD_LICENSE_SECRET ?? DEV_SECRET;

const TIER_BYTE  = { personal: 0, sovereign: 1, corporate: 2 };
const ALPHABET   = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LIFETIME   = 0xFFFF;
const EPOCH      = new Date(Date.UTC(2026, 0, 1));

// ── Parse args ────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
    process.argv.slice(2)
        .map((v, i, a) => i % 2 === 0 ? [v.replace('--', ''), a[i + 1]] : null)
        .filter(Boolean)
);

const tier   = args.tier;
const expiry = args.expiry;

if (!tier || !TIER_BYTE.hasOwnProperty(tier)) {
    console.error('Error: --tier must be one of: personal, sovereign, corporate');
    process.exit(1);
}
if (!expiry || !['annual', 'lifetime'].includes(expiry)) {
    console.error('Error: --expiry must be one of: annual, lifetime');
    process.exit(1);
}

if (SECRET === DEV_SECRET) {
    console.warn('⚠️  WARNING: Using dev secret. Set AETHELGARD_LICENSE_SECRET for production keys.\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateToMonths(d) {
    const months =
        (d.getUTCFullYear() - EPOCH.getUTCFullYear()) * 12 +
        (d.getUTCMonth()    - EPOCH.getUTCMonth());
    return Math.max(0, Math.min(0xfffe, months));
}

function annualExpiry() {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 13); // 13 months = 1 year + 1 month grace
    return d;
}

function randomCustomerId() {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    return ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
}

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
    for (let i = 23; i >= 0; i--) out += ALPHABET[Number((acc >> BigInt(i * 5)) & 0x1fn)];
    return out;
}

// ── Generate ──────────────────────────────────────────────────────────────────

async function generate() {
    const customerId  = randomCustomerId();
    const expiryDate  = expiry === 'lifetime' ? null : annualExpiry();
    const months      = expiryDate === null ? LIFETIME : dateToMonths(expiryDate);

    const buf = new Uint8Array(15);
    buf[0] = (1 << 4) | TIER_BYTE[tier];
    buf[1] = (months >> 8) & 0xff;
    buf[2] =  months       & 0xff;
    buf[3] = (customerId >>> 24) & 0xff;
    buf[4] = (customerId >>> 16) & 0xff;
    buf[5] = (customerId >>>  8) & 0xff;
    buf[6] =  customerId         & 0xff;

    const hmac = await computeHmac(buf.buffer.slice(0, 7), SECRET);
    buf.set(hmac.slice(0, 8), 7);

    const e   = encodeBase32(buf);
    const key = `AETHG-${e.slice(0,6)}-${e.slice(6,12)}-${e.slice(12,18)}-${e.slice(18,24)}`;

    console.log('\nLicense key generated:');
    console.log('─────────────────────────────────────');
    console.log(key);
    console.log('─────────────────────────────────────');
    console.log(`Tier:        ${tier}`);
    console.log(`Expiry:      ${expiryDate ? expiryDate.toISOString().slice(0, 10) : 'Lifetime (never expires)'}`);
    console.log(`Customer ID: ${customerId}`);
    console.log('');
}

generate();
