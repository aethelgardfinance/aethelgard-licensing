#!/usr/bin/env node
/**
 * Snapshot every Upstash KV record to a JSON object on stdout.
 *
 * Used as a recovery insurance step before deploying any change that adds
 * a new key prefix (notably `dead_letter:*` from Wave 4c). Restoring is
 * the inverse: read the JSON, kv.set(key, value) for each entry.
 *
 * Output contains real customer license-key records and rate-limit
 * counters. Treat the output file like a customer database export —
 * never commit, never email, store only on encrypted disk. Naming
 * convention: `kv-snapshot-YYYY-MM-DDTHH-MM-SSZ.json`.
 *
 * Usage:
 *   node scripts/kv-export.mjs > kv-snapshot-$(date -u +%FT%TZ | tr ':' '-').json
 *
 * Or via npm:
 *   npm run kv:export > kv-snapshot.json
 *
 * Reads UPSTASH_REDIS_REST_URL / _TOKEN or KV_REST_API_URL / _TOKEN.
 * Same env-var precedence as lib/redis.ts.
 */

import { Redis } from '@upstash/redis';

const url   = process.env.UPSTASH_REDIS_REST_URL   ?? process.env.KV_REST_API_URL   ?? '';
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? '';

if (!url || !token) {
    console.error(
        'Missing Upstash credentials. Set UPSTASH_REDIS_REST_URL / _TOKEN ' +
        '(or KV_REST_API_URL / _TOKEN) in the environment before running.',
    );
    process.exit(1);
}

const kv = new Redis({ url, token });

async function exportAll() {
    const all = {};
    let cursor = '0';
    let totalKeys = 0;

    do {
        const result = await kv.scan(cursor, { count: 1000 });
        const next = String(result[0]);
        const keys = result[1];

        // Fetch values in parallel batches — single-key gets are cheap on
        // Upstash but the network round-trip dominates if serialised.
        const values = await Promise.all(keys.map(k => kv.get(k)));
        for (let i = 0; i < keys.length; i++) {
            all[keys[i]] = values[i];
            totalKeys += 1;
        }

        cursor = next;
    } while (cursor !== '0');

    process.stdout.write(JSON.stringify(all, null, 2) + '\n');
    console.error(`kv-export: wrote ${totalKeys} keys`);
}

exportAll().catch(err => {
    console.error('kv-export failed:', err);
    process.exit(1);
});
