#!/usr/bin/env node
/**
 * Aethelgard — admin deactivation tool.
 *
 * Removes a device from the activation list of a licence key in KV. Used
 * when a customer emails saying "my new laptop is my 4th device, please
 * deactivate my old MacBook" — frees up a slot so they can activate the
 * new machine.
 *
 * Usage (from aethelgard-licensing/):
 *
 *   # 1. List devices currently registered against a key
 *   node scripts/deactivate.mjs AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX
 *
 *   # 2. Preview removal of device #N (1-based, matches the list output)
 *   node scripts/deactivate.mjs AETHG-... 2
 *
 *   # 3. Actually perform the removal (after confirming preview is correct)
 *   node scripts/deactivate.mjs AETHG-... 2 --confirm
 *
 * The script never mutates KV without --confirm. Dry-run is always safe.
 *
 * Environment (same pattern as send-prep.mjs):
 *   UPSTASH_REDIS_REST_URL   — from Vercel env, present in .env.production
 *   UPSTASH_REDIS_REST_TOKEN — same
 *
 * Usually invoked as:
 *   set -a; . ./.env.production; set +a; node scripts/deactivate.mjs AETHG-...
 *
 * Idempotent by design — re-running a --confirm removal on an already-removed
 * index is a no-op with a clear message.
 */

import { Redis } from '@upstash/redis';

// ── Args (parsed before env check so --help works without env) ──────────────

function usage() {
    console.log(`
Usage:
  node scripts/deactivate.mjs <KEY>                       # list devices
  node scripts/deactivate.mjs <KEY> <INDEX>               # preview removal
  node scripts/deactivate.mjs <KEY> <INDEX> --confirm     # actually remove

INDEX is 1-based and matches the "list" output.
`);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
}

const [rawKey, rawIndex, confirmFlag] = args;
const confirmed = confirmFlag === '--confirm';

if (args.length > 3 || (args.length === 3 && !confirmed)) {
    console.error('ERROR: unknown trailing argument. Expected at most: <KEY> <INDEX> --confirm');
    usage();
    process.exit(1);
}

// ── Env ──────────────────────────────────────────────────────────────────────

const REDIS_URL   = process.env['UPSTASH_REDIS_REST_URL'];
const REDIS_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];

if (!REDIS_URL || !REDIS_TOKEN) {
    console.error('ERROR: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set.');
    console.error('Grab them from Vercel dashboard > Project Settings > Environment Variables,');
    console.error('add to .env.production locally, then:');
    console.error('  set -a; . ./.env.production; set +a; node scripts/deactivate.mjs <KEY> [...]');
    process.exit(1);
}

const kv = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

// ── Key hashing (mirrors lib/keygen.ts hashKey) ──────────────────────────────

function normaliseKey(raw) {
    return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/^AETHG/, '');
}

async function hashKey(raw) {
    const data = new TextEncoder().encode(normaliseKey(raw));
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const h   = await hashKey(rawKey);
    const key = `key:${h}`;
    const record = await kv.get(key);

    if (!record) {
        console.error(`No record found in KV for key hash ${h.slice(0, 12)}…`);
        console.error('Either the key was never paid for (beta / unregistered), or it was mistyped.');
        process.exit(2);
    }

    const devices = Array.isArray(record.devices) ? record.devices : [];
    const limit   = typeof record.device_limit === 'number' ? record.device_limit : 3;

    console.log('');
    console.log(`Licence:        ${record.key}`);
    console.log(`Customer email: ${record.customer_email ?? '(unknown)'}`);
    console.log(`Tier:           ${record.tier}${record.is_lifetime ? ' (lifetime)' : ''}`);
    console.log(`Issued:         ${record.issued_at}`);
    console.log(`Revoked:        ${record.revoked ? 'YES' : 'no'}`);
    console.log(`Devices:        ${devices.length} of ${limit}`);
    console.log('');

    if (devices.length === 0) {
        console.log('No devices currently registered — nothing to deactivate.');
        process.exit(0);
    }

    // List mode
    for (const [i, d] of devices.entries()) {
        const idx = (i + 1).toString().padStart(2, ' ');
        console.log(`  ${idx}. ${d.device_name || '(unnamed)'}`);
        console.log(`      fingerprint:  ${d.fingerprint.slice(0, 16)}…`);
        console.log(`      activated_at: ${d.activated_at}`);
        console.log(`      last_seen_at: ${d.last_seen_at}`);
        console.log('');
    }

    // No index supplied — just list and exit
    if (!rawIndex) {
        console.log('Re-run with an INDEX to preview a removal:');
        console.log(`  node scripts/deactivate.mjs ${rawKey} 1`);
        process.exit(0);
    }

    const index = parseInt(rawIndex, 10);
    if (!Number.isInteger(index) || index < 1 || index > devices.length) {
        console.error(`ERROR: INDEX must be an integer between 1 and ${devices.length}.`);
        process.exit(1);
    }

    const target = devices[index - 1];
    const newDevices = devices.filter((_, i) => i !== index - 1);

    console.log(`About to remove device #${index}:`);
    console.log(`  name:        ${target.device_name || '(unnamed)'}`);
    console.log(`  fingerprint: ${target.fingerprint.slice(0, 16)}…`);
    console.log(`  activated:   ${target.activated_at}`);
    console.log('');
    console.log(`After removal, ${newDevices.length} of ${limit} devices will remain active.`);
    console.log('');

    if (!confirmed) {
        console.log('DRY RUN — no changes made. Re-run with --confirm to apply:');
        console.log(`  node scripts/deactivate.mjs ${rawKey} ${index} --confirm`);
        process.exit(0);
    }

    await kv.set(key, { ...record, devices: newDevices });

    console.log('✓ Device removed. Customer can now activate a new machine.');
    console.log('');
    console.log(`Slot freed for: ${record.customer_email ?? '(unknown email)'}`);
}

main().catch(err => {
    console.error('ERROR:', err.message || err);
    process.exit(1);
});
