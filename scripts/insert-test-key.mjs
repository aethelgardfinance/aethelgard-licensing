#!/usr/bin/env node
/**
 * Aethelgard — insert a pre-generated key into KV for activation testing.
 *
 * Use case: you have a key (e.g. from `generate-key.mjs` run locally with the
 * dev secret) that needs to be registered in KV so the activation API treats
 * it as a real customer key instead of returning "unregistered". This is the
 * shortcut Paddle would normally take when a real purchase happens.
 *
 * Mirrors the shape `paddle-webhook.ts` writes — every field that `activation.ts`
 * expects is present, so the new key behaves identically to a Paddle-issued one
 * (subject to whichever device_limit you choose).
 *
 * Usage (from aethelgard-licensing/):
 *
 *   # Insert with explicit fields (recommended for clarity)
 *   node scripts/insert-test-key.mjs \
 *       --key AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX \
 *       --email test@local.test \
 *       --tier advanced \
 *       --limit 1 \
 *       --confirm
 *
 *   # Defaults: email=test@local.test, tier=advanced, limit=1
 *   node scripts/insert-test-key.mjs --key AETHG-... --confirm
 *
 *   # Dry-run (no --confirm) prints the payload + KV hash without writing
 *   node scripts/insert-test-key.mjs --key AETHG-...
 *
 *   # Delete (cleanup)
 *   node scripts/insert-test-key.mjs --key AETHG-... --delete --confirm
 *
 * Tier values: basic | standard | advanced  (matches lib/keygen.ts Tier).
 *
 * Environment:
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (older naming) OR
 *   KV_REST_API_URL        + KV_REST_API_TOKEN          (newer Vercel KV)
 */

import { Redis } from '@upstash/redis';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(`
Usage:
  node scripts/insert-test-key.mjs --key AETHG-... [--email <addr>] [--tier <t>] [--limit <N>] [--confirm]
  node scripts/insert-test-key.mjs --key AETHG-... --delete --confirm

Flags:
  --key      Required. Aethelgard key string (AETHG-…).
  --email    Customer email. Default: test@local.test
  --tier     basic | standard | advanced. Default: advanced
  --limit    device_limit (1–10). Default: 1
  --delete   Remove the record from KV instead of inserting.
  --confirm  Required to actually mutate KV. Without it, dry-run.
`);
    process.exit(args[0] === '-h' || args[0] === '--help' ? 0 : 1);
}

// Tiny flag parser (no deps).
function parseFlags(xs) {
    const out = { key: null, email: 'test@local.test', tier: 'advanced', limit: '1', delete: false, confirm: false };
    for (let i = 0; i < xs.length; i++) {
        const a = xs[i];
        switch (a) {
            case '--key':      out.key      = xs[++i]; break;
            case '--email':    out.email    = xs[++i]; break;
            case '--tier':     out.tier     = xs[++i]; break;
            case '--limit':    out.limit    = xs[++i]; break;
            case '--delete':   out.delete   = true;    break;
            case '--confirm':  out.confirm  = true;    break;
            default:
                console.error(`Unknown argument: ${a}`);
                process.exit(1);
        }
    }
    return out;
}

const flags = parseFlags(args);

if (!flags.key || typeof flags.key !== 'string') {
    console.error('ERROR: --key is required.');
    process.exit(1);
}
if (!['basic', 'standard', 'advanced'].includes(flags.tier)) {
    console.error(`ERROR: --tier must be basic | standard | advanced (got "${flags.tier}").`);
    process.exit(1);
}
const limit = parseInt(flags.limit, 10);
if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    console.error(`ERROR: --limit must be an integer between 1 and 10 (got "${flags.limit}").`);
    process.exit(1);
}

const REDIS_URL   = process.env['UPSTASH_REDIS_REST_URL']   ?? process.env['KV_REST_API_URL'];
const REDIS_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'] ?? process.env['KV_REST_API_TOKEN'];

if (!REDIS_URL || !REDIS_TOKEN) {
    console.error('ERROR: Upstash KV credentials not found.');
    console.error('  npx vercel env pull .env.production --environment=production');
    console.error('  set -a; . ./.env.production; set +a; node scripts/insert-test-key.mjs ...');
    process.exit(1);
}

const kv = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

// Mirror lib/keygen.ts hashKey.
function normaliseKey(raw) {
    return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/^AETHG/, '');
}

async function hashKey(raw) {
    const data = new TextEncoder().encode(normaliseKey(raw));
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
    const h   = await hashKey(flags.key);
    const kvKey = `key:${h}`;
    const existing = await kv.get(kvKey);

    if (flags.delete) {
        if (!existing) {
            console.log(`No record at ${kvKey.slice(0, 18)}… — nothing to delete.`);
            process.exit(0);
        }
        console.log(`Found existing record:`);
        console.log(`  key:            ${existing.key}`);
        console.log(`  customer_email: ${existing.customer_email ?? '(unknown)'}`);
        console.log(`  devices:        ${existing.devices?.length ?? 0} / ${existing.device_limit ?? 3}`);
        if (!flags.confirm) {
            console.log('');
            console.log('DRY RUN — no changes. Re-run with --confirm to delete:');
            console.log(`  node scripts/insert-test-key.mjs --key ${flags.key} --delete --confirm`);
            process.exit(0);
        }
        await kv.del(kvKey);
        console.log(`✓ Deleted ${kvKey.slice(0, 18)}…`);
        process.exit(0);
    }

    // Insert mode.
    const now = new Date().toISOString();
    const oneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const record = {
        key:            flags.key,
        transaction_id: `txn_local_${Date.now()}`,
        tier:           flags.tier,
        is_lifetime:    false,
        issued_at:      now,
        expires_at:     oneYear,  // Webhook stores annual keys with explicit expiry
        customer_email: flags.email,
        revoked:        false,
        device_limit:   limit,
        devices:        [],
    };

    if (existing) {
        console.log(`⚠ Record already exists at ${kvKey.slice(0, 18)}…`);
        console.log(`  Existing: tier=${existing.tier}, devices=${existing.devices?.length ?? 0}/${existing.device_limit ?? 3}, revoked=${existing.revoked}`);
        console.log(`  Inserting will OVERWRITE the existing record (losing device activations).`);
    } else {
        console.log(`New record to be inserted at ${kvKey.slice(0, 18)}…`);
    }

    console.log('');
    console.log('Record payload:');
    console.log(JSON.stringify(record, null, 2));
    console.log('');

    if (!flags.confirm) {
        console.log('DRY RUN — no changes. Re-run with --confirm to apply:');
        console.log(`  node scripts/insert-test-key.mjs --key ${flags.key} --email ${flags.email} --tier ${flags.tier} --limit ${limit} --confirm`);
        process.exit(0);
    }

    await kv.set(kvKey, record);
    console.log(`✓ Inserted into KV with device_limit=${limit}.`);
    console.log('');
    console.log('Next: activate this key from your Tauri dev build. The local HMAC validation');
    console.log('will accept it as long as the binary was built with the same AETHELGARD_LICENSE_SECRET');
    console.log('that signed the key.');
}

main().catch(err => {
    console.error('ERROR:', err.message || err);
    process.exit(1);
});
