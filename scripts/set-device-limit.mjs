#!/usr/bin/env node
/**
 * Aethelgard — admin tool to override device_limit on a licence key.
 *
 * Typical use: testing the 3-device activation cap with a smaller limit
 * (e.g. limit=1 means a 2nd device activation fires the limit_reached
 * codepath without needing 3 distinct fingerprints). Also useful when a
 * paying customer legitimately needs more than the default cap (e.g. a
 * family-office principal with 4 family members each on their own machine
 * — bump from 3 to 5 instead of refunding + reissuing).
 *
 * Usage (from aethelgard-licensing/):
 *
 *   # 1. Show current limit and device count
 *   node scripts/set-device-limit.mjs AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX
 *
 *   # 2. Preview limit change
 *   node scripts/set-device-limit.mjs AETHG-... 1
 *
 *   # 3. Actually apply (after confirming preview is correct)
 *   node scripts/set-device-limit.mjs AETHG-... 1 --confirm
 *
 * Server-side validation (lib/activation.ts) refuses activation when
 * device_limit is outside [1, 10], so this script enforces the same
 * range. If the new limit is lower than the current device count, the
 * script warns but still allows it — future activations will be blocked
 * until existing devices are deactivated via deactivate.mjs.
 *
 * Environment (same as deactivate.mjs):
 *   UPSTASH_REDIS_REST_URL   — from Vercel env, present in .env.production
 *   UPSTASH_REDIS_REST_TOKEN — same
 *
 * Usually invoked as:
 *   set -a; . ./.env.production; set +a; node scripts/set-device-limit.mjs <KEY>
 */

import { Redis } from '@upstash/redis';

const MIN_LIMIT = 1;
const MAX_LIMIT = 10;

function usage() {
    console.log(`
Usage:
  node scripts/set-device-limit.mjs <KEY>                  # show current limit
  node scripts/set-device-limit.mjs <KEY> <N>              # preview change
  node scripts/set-device-limit.mjs <KEY> <N> --confirm    # apply change

N must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}.
`);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
}

const [rawKey, rawLimit, confirmFlag] = args;
const confirmed = confirmFlag === '--confirm';

if (args.length > 3 || (args.length === 3 && !confirmed)) {
    console.error('ERROR: unknown trailing argument. Expected at most: <KEY> <N> --confirm');
    usage();
    process.exit(1);
}

// Vercel uses two naming conventions for the same Upstash KV connection
// depending on integration vintage. Accept either, matching lib/redis.ts.
const REDIS_URL   = process.env['UPSTASH_REDIS_REST_URL']   ?? process.env['KV_REST_API_URL'];
const REDIS_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'] ?? process.env['KV_REST_API_TOKEN'];

if (!REDIS_URL || !REDIS_TOKEN) {
    console.error('ERROR: Upstash KV credentials not found in environment.');
    console.error('  Expected one of:');
    console.error('    UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (older Marketplace flow)');
    console.error('    KV_REST_API_URL        + KV_REST_API_TOKEN         (newer Storage flow)');
    console.error('  Pull from Vercel:  npx vercel env pull .env.production --environment=production');
    console.error('  Then load:         set -a; . ./.env.production; set +a; node scripts/set-device-limit.mjs <KEY> [...]');
    process.exit(1);
}

const kv = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

// Key hashing mirrors lib/keygen.ts hashKey + scripts/deactivate.mjs.
function normaliseKey(raw) {
    return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/^AETHG/, '');
}

async function hashKey(raw) {
    const data = new TextEncoder().encode(normaliseKey(raw));
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
    const h   = await hashKey(rawKey);
    const key = `key:${h}`;
    const record = await kv.get(key);

    if (!record) {
        console.error(`No record found in KV for key hash ${h.slice(0, 12)}…`);
        console.error('Either the key was never paid for (beta / unregistered), or it was mistyped.');
        process.exit(2);
    }

    const devices    = Array.isArray(record.devices) ? record.devices : [];
    const currentLim = typeof record.device_limit === 'number' ? record.device_limit : 3;

    console.log('');
    console.log(`Licence:          ${record.key}`);
    console.log(`Customer email:   ${record.customer_email ?? '(unknown)'}`);
    console.log(`Tier:             ${record.tier}${record.is_lifetime ? ' (lifetime)' : ''}`);
    console.log(`Current limit:    ${currentLim}`);
    console.log(`Current devices:  ${devices.length}`);
    console.log('');

    // No new-limit supplied → just print current state and exit.
    if (!rawLimit) {
        console.log('Re-run with a new limit to preview the change:');
        console.log(`  node scripts/set-device-limit.mjs ${rawKey} 1`);
        process.exit(0);
    }

    const newLimit = parseInt(rawLimit, 10);
    if (!Number.isInteger(newLimit) || newLimit < MIN_LIMIT || newLimit > MAX_LIMIT) {
        console.error(`ERROR: N must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT} (server rejects activations outside this range).`);
        process.exit(1);
    }

    if (newLimit === currentLim) {
        console.log(`No change — device_limit is already ${currentLim}.`);
        process.exit(0);
    }

    console.log(`About to change device_limit:  ${currentLim} → ${newLimit}`);
    console.log('');

    if (newLimit < devices.length) {
        console.warn(`⚠ WARNING: new limit (${newLimit}) is LOWER than current device count (${devices.length}).`);
        console.warn(`  No existing devices will be removed — they remain activated.`);
        console.warn(`  But NO further activations will succeed until devices.length < ${newLimit}.`);
        console.warn(`  Use deactivate.mjs to free slots first if that's not what you want.`);
        console.log('');
    }

    if (!confirmed) {
        console.log('DRY RUN — no changes made. Re-run with --confirm to apply:');
        console.log(`  node scripts/set-device-limit.mjs ${rawKey} ${newLimit} --confirm`);
        process.exit(0);
    }

    await kv.set(key, { ...record, device_limit: newLimit });

    console.log(`✓ device_limit updated to ${newLimit}.`);
    console.log('');
    console.log('Next activation attempt will use the new limit immediately — no propagation delay.');
}

main().catch(err => {
    console.error('ERROR:', err.message || err);
    process.exit(1);
});
