#!/usr/bin/env node
/**
 * One-shot Sentinel key generator.
 *
 * Usage:
 *   AETHELGARD_LICENSE_SECRET=<secret> node scripts/generate-sentinel-key.mjs [--customer-id N] [--expiry annual]
 *
 * Prints a single SENTI-prefixed key to stdout. Default expiry is annual
 * (13 months from today, matching Aethelgard's annual policy).
 *
 * Sentinel does not have a lifetime tier — annual only.
 */

import { generateSentinelKey, randomCustomerId, annualExpiry } from '../lib/keygen-sentinel.ts';

const args = parseArgs(process.argv.slice(2));
const secret = process.env.AETHELGARD_LICENSE_SECRET;

if (!secret) {
    console.error('AETHELGARD_LICENSE_SECRET environment variable required.');
    process.exit(1);
}

const customerId = args.customerId !== undefined
    ? Number(args.customerId)
    : randomCustomerId();

if (!Number.isFinite(customerId) || customerId < 0 || customerId > 0xffffffff) {
    console.error('--customer-id must be a non-negative u32.');
    process.exit(1);
}

const expiry = annualExpiry();

const key = await generateSentinelKey('standalone', customerId, expiry, secret);

const expiryIso = expiry.toISOString().slice(0, 10);
console.error(`Customer: ${customerId}`);
console.error(`Expiry:   ${expiryIso}`);
console.log(key);

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--customer-id') out.customerId = argv[++i];
        else if (a === '--expiry') out.expiry = argv[++i];
        else {
            console.error(`Unknown argument: ${a}`);
            process.exit(1);
        }
    }
    return out;
}
