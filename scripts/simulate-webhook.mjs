#!/usr/bin/env node
/**
 * Paddle webhook simulator — signs and POSTs a fake event to the webhook.
 *
 * Purpose: pre-launch verification without triggering real Paddle transactions.
 * Use this to smoke-test the full webhook → key generation → Resend email →
 * KV record flow. Pairs with operations/e2e-runbook.md.
 *
 * Usage (from aethelgard-licensing/):
 *
 *   # 1. Purchase event — generates a key, sends a real email, writes KV
 *   node scripts/simulate-webhook.mjs purchase <tier>
 *
 *   # 2. Advisor bundle purchase — three Advanced Lifetime keys
 *   node scripts/simulate-webhook.mjs bundle
 *
 *   # 3. Refund adjustment — revokes the keys for a previous transaction
 *   node scripts/simulate-webhook.mjs refund <tx_id>
 *
 *   # DRY RUN (default): prints request body + signature, does not POST.
 *   # Add --send to actually hit the endpoint.
 *
 * Flags:
 *   --email=<addr>   Customer email in the event payload. Defaults to TEST_EMAIL
 *                    env var, or "test+aethelgard@2bc.com".
 *   --url=<webhook>  Webhook URL. Defaults to WEBHOOK_URL env var, else the
 *                    production deployment. Use http://localhost:3000/api/paddle-webhook
 *                    when running `vercel dev`.
 *   --tier=<basic|standard|advanced>  For `purchase`; overrides positional.
 *   --lifetime       Use the lifetime price ID for the chosen tier.
 *   --send           Required to actually POST — dry-run otherwise.
 *
 * Environment:
 *   PADDLE_WEBHOOK_SECRET   — required; used to sign outgoing events
 *   PADDLE_{TIER}_PRICE_ID  — read when simulating purchase so the event
 *                             mentions a price_id the real webhook recognises.
 *                             Accepts legacy aliases too.
 *   WEBHOOK_URL             — optional override for the target URL
 *   TEST_EMAIL              — optional default for --email
 *
 * Typical load:
 *   set -a; . ./.env.production; set +a; node scripts/simulate-webhook.mjs purchase advanced
 */

// ── CLI parsing (no deps — keep the script self-contained) ───────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
}

const [command, ...rest] = args;
const flags = parseFlags(rest);

function parseFlags(xs) {
    const out = { positional: [], flags: {}, boolean: new Set() };
    for (const x of xs) {
        if (x.startsWith('--')) {
            const [k, v] = x.slice(2).split('=');
            if (v === undefined) out.boolean.add(k);
            else out.flags[k] = v;
        } else {
            out.positional.push(x);
        }
    }
    return out;
}

function printUsage() {
    console.log(`
Usage:
  node scripts/simulate-webhook.mjs purchase <tier>             # tier: basic|standard|advanced
  node scripts/simulate-webhook.mjs bundle                      # advisor bundle (3 keys)
  node scripts/simulate-webhook.mjs refund <transaction_id>     # revoke keys issued for this tx

Flags:
  --email=<addr>        Customer email (default: TEST_EMAIL env or test+aethelgard@2bc.com)
  --url=<webhook>       Target URL (default: WEBHOOK_URL env or prod)
  --lifetime            For purchase: use the *_LIFETIME_PRICE_ID
  --send                Required to actually POST — dry-run otherwise

Examples:
  node scripts/simulate-webhook.mjs purchase advanced --lifetime
  node scripts/simulate-webhook.mjs purchase standard --email=you@example.com --send
  node scripts/simulate-webhook.mjs refund tx_simulated_abc --send
`);
}

// ── Env ──────────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env['PADDLE_WEBHOOK_SECRET'];
if (!WEBHOOK_SECRET) {
    console.error('ERROR: PADDLE_WEBHOOK_SECRET must be set. Load .env.production first:');
    console.error('  set -a; . ./.env.production; set +a; node scripts/simulate-webhook.mjs ...');
    process.exit(1);
}

const DEFAULT_EMAIL = process.env['TEST_EMAIL'] ?? 'test+aethelgard@2bc.com';
const DEFAULT_URL   = process.env['WEBHOOK_URL'] ?? 'https://aethelgard-licensing.vercel.app/api/paddle-webhook';

const customerEmail = flags.flags['email']  ?? DEFAULT_EMAIL;
const webhookUrl    = flags.flags['url']    ?? DEFAULT_URL;
const wantsSend     = flags.boolean.has('send');
const wantsLifetime = flags.boolean.has('lifetime');

// ── Payload builders ─────────────────────────────────────────────────────────

const TIER_TO_ENV = {
    basic:    ['PADDLE_BASIC_PRICE_ID',    'PADDLE_PERSONAL_PRICE_ID'],
    standard: ['PADDLE_STANDARD_PRICE_ID', 'PADDLE_SOVEREIGN_PRICE_ID'],
    advanced: ['PADDLE_ADVANCED_PRICE_ID', 'PADDLE_CORPORATE_PRICE_ID'],
};
const TIER_TO_ENV_LIFETIME = {
    basic:    ['PADDLE_BASIC_LIFETIME_PRICE_ID',    'PADDLE_PERSONAL_LIFETIME_PRICE_ID'],
    standard: ['PADDLE_STANDARD_LIFETIME_PRICE_ID', 'PADDLE_SOVEREIGN_LIFETIME_PRICE_ID'],
    advanced: ['PADDLE_ADVANCED_LIFETIME_PRICE_ID', 'PADDLE_CORPORATE_LIFETIME_PRICE_ID'],
};

function resolvePriceId(tier, lifetime) {
    const candidates = lifetime ? TIER_TO_ENV_LIFETIME[tier] : TIER_TO_ENV[tier];
    if (!candidates) {
        console.error(`ERROR: unknown tier "${tier}". Expected: basic | standard | advanced.`);
        process.exit(1);
    }
    for (const envKey of candidates) {
        const v = process.env[envKey];
        if (v) return { priceId: v, envKey };
    }
    console.error(`ERROR: none of ${candidates.join(' / ')} are set in the environment.`);
    console.error('Set them from .env.production (or Vercel dashboard for production).');
    process.exit(1);
}

function newTxId() {
    // Shape matches Paddle IDs loosely (not strictly validated by the webhook).
    return 'txn_sim_' + Math.random().toString(36).slice(2, 10);
}

function buildPurchaseEvent(priceId) {
    return {
        event_type: 'transaction.completed',
        data: {
            id: newTxId(),
            customer:        { email: customerEmail, name: customerEmail.split('@')[0] },
            billing_details: { email: customerEmail },
            items: [ { price: { id: priceId } } ],
        },
    };
}

function buildBundleEvent() {
    const bundleId = process.env['PADDLE_ADVISOR_BUNDLE_PRICE_ID'];
    if (!bundleId) {
        console.error('ERROR: PADDLE_ADVISOR_BUNDLE_PRICE_ID is not set.');
        process.exit(1);
    }
    return {
        event_type: 'transaction.completed',
        data: {
            id: newTxId(),
            customer:        { email: customerEmail, name: 'Advisor Bundle Test' },
            billing_details: { email: customerEmail },
            items: [ { price: { id: bundleId } } ],
        },
    };
}

function buildRefundEvent(transactionId) {
    return {
        event_type: 'adjustment.created',
        data: {
            id:             'adj_sim_' + Math.random().toString(36).slice(2, 10),
            action:         'refund',
            transaction_id: transactionId,
            status:         'approved',
        },
    };
}

// ── Signing ──────────────────────────────────────────────────────────────────

async function signBody(rawBody, secret) {
    const ts  = Math.floor(Date.now() / 1000).toString();
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}:${rawBody}`));
    const h1  = Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    return `ts=${ts};h1=${h1}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    let event;
    let summary;

    if (command === 'purchase') {
        const tier = flags.flags['tier'] ?? flags.positional[0];
        if (!tier) {
            console.error('ERROR: specify tier (basic | standard | advanced).');
            printUsage();
            process.exit(1);
        }
        const { priceId, envKey } = resolvePriceId(tier, wantsLifetime);
        event = buildPurchaseEvent(priceId);
        summary = `purchase · tier=${tier}${wantsLifetime ? ' (lifetime)' : ''} · ${envKey}=${priceId}`;
    } else if (command === 'bundle') {
        event = buildBundleEvent();
        summary = `advisor bundle · 3× Advanced Lifetime keys`;
    } else if (command === 'refund') {
        const txId = flags.positional[0];
        if (!txId) {
            console.error('ERROR: refund requires a transaction_id. Example:');
            console.error('  node scripts/simulate-webhook.mjs refund txn_sim_abc --send');
            process.exit(1);
        }
        event = buildRefundEvent(txId);
        summary = `refund adjustment · tx=${txId}`;
    } else {
        console.error(`ERROR: unknown command "${command}".`);
        printUsage();
        process.exit(1);
    }

    const body       = JSON.stringify(event);
    const signature  = await signBody(body, WEBHOOK_SECRET);

    console.log('');
    console.log(`Target:    ${webhookUrl}`);
    console.log(`Action:    ${summary}`);
    console.log(`Email:     ${customerEmail}`);
    console.log(`Signature: ${signature}`);
    console.log('');
    console.log('Body:');
    console.log(JSON.stringify(event, null, 2));
    console.log('');

    if (!wantsSend) {
        console.log('DRY RUN — nothing was sent.');
        console.log('Add --send to POST this to the webhook.');
        return;
    }

    if (webhookUrl.includes('aethelgard-licensing.vercel.app') && !webhookUrl.includes('-git-')) {
        console.log('⚠  Target is PRODUCTION. An email will be sent to', customerEmail);
        console.log('   and the key will be written to the live KV registry.');
        console.log('');
    }

    const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
            'content-type':     'application/json',
            'paddle-signature': signature,
        },
        body,
    });

    console.log(`Response: ${resp.status} ${resp.statusText}`);
    const text = await resp.text();
    console.log(text);

    if (!resp.ok) process.exit(2);
}

main().catch(err => {
    console.error('ERROR:', err.message || err);
    process.exit(1);
});
