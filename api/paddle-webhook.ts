/**
 * Vercel Serverless Function — Paddle webhook receiver.
 *
 * Endpoint: POST /api/paddle-webhook
 *
 * Handles:
 *   transaction.completed  — generate key(s), store in KV, email customer
 *   transaction.refunded   — mark key(s) revoked in KV
 *
 * Required environment variables:
 *   PADDLE_WEBHOOK_SECRET              — from Paddle dashboard > Notifications
 *   AETHELGARD_LICENSE_SECRET          — must match value baked into app binary
 *   RESEND_API_KEY                     — from resend.com dashboard
 *   PADDLE_API_KEY                     — for customer email lookup fallback
 *   PADDLE_SANDBOX                     — "true" for sandbox environment
 *   KV_REST_API_URL / KV_REST_API_TOKEN — auto-added by Vercel KV integration
 *
 *   Price ID env vars (legacy and current names both accepted):
 *   PADDLE_BASIC_PRICE_ID / PADDLE_PERSONAL_PRICE_ID
 *   PADDLE_STANDARD_PRICE_ID / PADDLE_SOVEREIGN_PRICE_ID
 *   PADDLE_ADVANCED_PRICE_ID / PADDLE_CORPORATE_PRICE_ID
 *   (+ LIFETIME and ADVISOR_BUNDLE variants)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';
import { generateKey, randomCustomerId, annualExpiry, lifetimeExpiry, hashKey } from '../lib/keygen.js';
import type { Tier } from '../lib/keygen.js';
import { sendLicenseEmail, sendAdvisorBundleEmail } from '../lib/email.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KeyRecord {
    key:            string;
    transaction_id: string;
    tier:           string;
    is_lifetime:    boolean;
    issued_at:      string;
    customer_email: string;
    revoked:        boolean;
}

interface PaddleEvent {
    event_type: string;
    data: PaddleTransaction;
}

interface PaddleTransaction {
    id: string;
    customer?: { email?: string; name?: string };
    billing_details?: { email?: string };
    items?: Array<{ price?: { id?: string } }>;
}

// ── Tier mapping ──────────────────────────────────────────────────────────────

function buildPriceMap(): Map<string, { tier: Tier; isLifetime: boolean }> {
    const map = new Map<string, { tier: Tier; isLifetime: boolean }>();

    const entries: Array<[string, Tier, boolean]> = [
        // Current names
        ['PADDLE_BASIC_PRICE_ID',             'basic',    false],
        ['PADDLE_STANDARD_PRICE_ID',          'standard', false],
        ['PADDLE_ADVANCED_PRICE_ID',          'advanced', false],
        ['PADDLE_BASIC_LIFETIME_PRICE_ID',    'basic',    true],
        ['PADDLE_STANDARD_LIFETIME_PRICE_ID', 'standard', true],
        ['PADDLE_ADVANCED_LIFETIME_PRICE_ID', 'advanced', true],
        // Legacy names (Vercel env vars set before the rename — both accepted)
        ['PADDLE_PERSONAL_PRICE_ID',          'basic',    false],
        ['PADDLE_SOVEREIGN_PRICE_ID',         'standard', false],
        ['PADDLE_CORPORATE_PRICE_ID',         'advanced', false],
        ['PADDLE_PERSONAL_LIFETIME_PRICE_ID', 'basic',    true],
        ['PADDLE_SOVEREIGN_LIFETIME_PRICE_ID','standard', true],
        ['PADDLE_CORPORATE_LIFETIME_PRICE_ID','advanced', true],
    ];

    for (const [envKey, tier, isLifetime] of entries) {
        const id = process.env[envKey];
        if (id) map.set(id, { tier, isLifetime });
    }

    return map;
}

// ── Paddle signature verification ─────────────────────────────────────────────

async function verifyPaddleSignature(
    rawBody: string,
    signatureHeader: string | undefined,
    secret: string,
): Promise<boolean> {
    if (!signatureHeader) return false;

    const parts = Object.fromEntries(
        signatureHeader.split(';').map(p => p.split('=') as [string, string])
    );
    const { ts, h1 } = parts;
    if (!ts || !h1) return false;

    const age = Math.floor(Date.now() / 1000) - parseInt(ts, 10);
    if (age > 300 || age < -60) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}:${rawBody}`));
    const computed = Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    if (computed.length !== h1.length) return false;
    let mismatch = 0;
    for (let i = 0; i < computed.length; i++) {
        mismatch |= computed.charCodeAt(i) ^ h1.charCodeAt(i);
    }
    return mismatch === 0;
}

// ── Paddle customer email lookup (fallback) ───────────────────────────────────

async function fetchTransactionEmail(transactionId: string): Promise<string | undefined> {
    const apiKey = process.env['PADDLE_API_KEY'];
    if (!apiKey) { console.error('PADDLE_API_KEY not configured'); return undefined; }

    const isSandbox = process.env['PADDLE_SANDBOX'] === 'true';
    const baseUrl   = isSandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';

    try {
        const resp = await fetch(`${baseUrl}/transactions/${transactionId}?include=customer`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!resp.ok) {
            console.error(`Paddle transaction lookup failed: ${resp.status} ${resp.statusText}`);
            return undefined;
        }
        const body = await resp.json() as { data?: { customer?: { email?: string } } };
        return body.data?.customer?.email;
    } catch (err) {
        console.error('Paddle transaction lookup error:', err);
        return undefined;
    }
}

// ── KV helpers ────────────────────────────────────────────────────────────────

async function storeKey(record: KeyRecord, txId: string): Promise<void> {
    const h = await hashKey(record.key);
    await kv.set(`key:${h}`, record);
    await kv.set(`tx:${txId}`, h);
}

async function storeBundleKeys(records: KeyRecord[], txId: string): Promise<void> {
    const hashes = await Promise.all(records.map(r => hashKey(r.key)));
    await Promise.all(records.map((r, i) => kv.set(`key:${hashes[i]}`, r)));
    await kv.set(`tx:${txId}`, hashes);
}

async function revokeByTransaction(txId: string): Promise<number> {
    const stored = await kv.get<string | string[]>(`tx:${txId}`);
    if (!stored) return 0;

    const hashes = Array.isArray(stored) ? stored : [stored];
    let count = 0;
    for (const h of hashes) {
        const record = await kv.get<KeyRecord>(`key:${h}`);
        if (record) {
            await kv.set(`key:${h}`, { ...record, revoked: true });
            count++;
        }
    }
    return count;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const rawBody: string = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });

    // ── 1. Verify signature ───────────────────────────────────────────────────
    const webhookSecret = process.env['PADDLE_WEBHOOK_SECRET'];
    if (!webhookSecret) {
        console.error('PADDLE_WEBHOOK_SECRET not configured');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const isValid = await verifyPaddleSignature(
        rawBody,
        req.headers['paddle-signature'] as string | undefined,
        webhookSecret,
    );
    if (!isValid) {
        console.warn('Invalid Paddle webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── 2. Parse event ────────────────────────────────────────────────────────
    let event: PaddleEvent;
    try {
        event = JSON.parse(rawBody) as PaddleEvent;
    } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    const tx = event.data;

    // ── 3. Handle refund — revoke key(s) in KV ────────────────────────────────
    if (event.event_type === 'transaction.refunded') {
        try {
            const count = await revokeByTransaction(tx.id);
            console.log(`Revoked ${count} key(s) for transaction ${tx.id}`);
        } catch (err) {
            console.error('KV revocation error:', err);
        }
        return res.status(200).json({ received: true });
    }

    // ── 4. Only process completed transactions from here ─────────────────────
    if (event.event_type !== 'transaction.completed') {
        return res.status(200).json({ received: true, skipped: true });
    }

    // ── 5. Idempotency — check if this transaction was already processed ──────
    try {
        const existing = await kv.get<string | string[]>(`tx:${tx.id}`);
        if (existing) {
            // Paddle webhook retry — re-send the email with the original key(s)
            const hashes = Array.isArray(existing) ? existing : [existing];
            const records = await Promise.all(
                hashes.map(h => kv.get<KeyRecord>(`key:${h}`))
            );
            const valid = records.filter((r): r is KeyRecord => r !== null);

            if (valid.length > 0 && valid[0].customer_email) {
                const email = valid[0].customer_email;
                if (valid.length === 3) {
                    await sendAdvisorBundleEmail({
                        to: email,
                        customerName: email,
                        licenseKeys: [valid[0].key, valid[1].key, valid[2].key],
                    });
                } else {
                    const r = valid[0];
                    await sendLicenseEmail({
                        to: email,
                        customerName: email,
                        tier: r.tier as Tier,
                        licenseKey: r.key,
                        isLifetime: r.is_lifetime,
                        expiryDate: r.is_lifetime ? null : new Date(r.issued_at),
                    });
                }
                console.log(`Re-delivered existing key(s) to ${email} (tx: ${tx.id})`);
                return res.status(200).json({ success: true, idempotent: true });
            }
        }
    } catch (err) {
        // KV unavailable — continue to generate a new key
        console.warn('KV idempotency check failed, proceeding with new key:', err);
    }

    // ── 6. Resolve customer email ─────────────────────────────────────────────
    const customerEmail = tx.customer?.email
        ?? tx.billing_details?.email
        ?? await fetchTransactionEmail(tx.id);
    const customerName = tx.customer?.name ?? 'Customer';

    if (!customerEmail) {
        console.error('No customer email in transaction', tx.id);
        return res.status(200).json({ received: true, error: 'No customer email' });
    }

    // ── 7. Resolve price ID ───────────────────────────────────────────────────
    const priceId       = tx.items?.[0]?.price?.id;
    const bundlePriceId = process.env['PADDLE_ADVISOR_BUNDLE_PRICE_ID'];
    const isAdvisorBundle = priceId && bundlePriceId && priceId === bundlePriceId;

    const masterSecret = process.env['AETHELGARD_LICENSE_SECRET'];
    if (!masterSecret) {
        console.error('AETHELGARD_LICENSE_SECRET not configured');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    // ── 8a. Advisor bundle — 3 × Advanced Lifetime keys ──────────────────────
    if (isAdvisorBundle) {
        let keys: [string, string, string];
        try {
            keys = [
                await generateKey('advanced', randomCustomerId(), lifetimeExpiry, masterSecret),
                await generateKey('advanced', randomCustomerId(), lifetimeExpiry, masterSecret),
                await generateKey('advanced', randomCustomerId(), lifetimeExpiry, masterSecret),
            ];
        } catch (err) {
            console.error('Bundle key generation failed:', err);
            return res.status(500).json({ error: 'Key generation failed' });
        }

        try {
            await storeBundleKeys(
                keys.map(k => ({
                    key: k, transaction_id: tx.id, tier: 'advanced',
                    is_lifetime: true, issued_at: new Date().toISOString(),
                    customer_email: customerEmail, revoked: false,
                })),
                tx.id,
            );
        } catch (err) {
            console.error('KV bundle store failed (key still delivered):', err);
        }

        try {
            await sendAdvisorBundleEmail({ to: customerEmail, customerName, licenseKeys: keys });
        } catch (err) {
            console.error('Bundle email delivery failed:', err);
            return res.status(500).json({ error: 'Email delivery failed' });
        }

        console.log(`Advisor bundle delivered to ${customerEmail} (tx: ${tx.id})`);
        return res.status(200).json({ success: true });
    }

    // ── 8b. Single license ────────────────────────────────────────────────────
    const priceMap = buildPriceMap();
    const mapping  = priceId ? priceMap.get(priceId) : undefined;

    if (!mapping) {
        console.warn(`Unknown price ID: ${priceId} — cannot generate license key`);
        return res.status(200).json({ received: true, error: `Unknown price ID: ${priceId}` });
    }

    const { tier, isLifetime } = mapping;
    const expiryDate = isLifetime ? lifetimeExpiry : annualExpiry();

    let licenseKey: string;
    try {
        licenseKey = await generateKey(tier, randomCustomerId(), expiryDate, masterSecret);
    } catch (err) {
        console.error('Key generation failed:', err);
        return res.status(500).json({ error: 'Key generation failed' });
    }

    try {
        await storeKey({
            key: licenseKey, transaction_id: tx.id, tier,
            is_lifetime: isLifetime, issued_at: new Date().toISOString(),
            customer_email: customerEmail, revoked: false,
        }, tx.id);
    } catch (err) {
        console.error('KV store failed (key still delivered):', err);
    }

    try {
        await sendLicenseEmail({ to: customerEmail, customerName, tier, licenseKey, isLifetime, expiryDate });
    } catch (err) {
        console.error('Email delivery failed:', err);
        return res.status(500).json({ error: 'Email delivery failed' });
    }

    console.log(`License delivered: ${tier} to ${customerEmail} (tx: ${tx.id})`);
    return res.status(200).json({ success: true });
}
