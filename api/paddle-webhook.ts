/**
 * Vercel Serverless Function — Paddle webhook receiver.
 *
 * Endpoint: POST /api/paddle-webhook
 *
 * Flow:
 *   1. Verify Paddle webhook signature (HMAC-SHA256 over ts:body)
 *   2. On `transaction.completed`, read price ID → tier
 *   3. Generate Aethelgard license key
 *   4. Send key to customer email via Resend
 *
 * Required environment variables (set in Vercel project settings):
 *   PADDLE_WEBHOOK_SECRET         — from Paddle dashboard > Notifications
 *   AETHELGARD_LICENSE_SECRET     — must match the value baked into app binary
 *   RESEND_API_KEY                — from resend.com dashboard
 *   PADDLE_PERSONAL_PRICE_ID      — Paddle price ID for Basic/Personal tier
 *   PADDLE_SOVEREIGN_PRICE_ID     — Paddle price ID for Standard/Sovereign tier
 *   PADDLE_CORPORATE_PRICE_ID     — Paddle price ID for Advanced/Corporate tier
 *   PADDLE_PERSONAL_LIFETIME_PRICE_ID   — Paddle price ID for Basic lifetime
 *   PADDLE_SOVEREIGN_LIFETIME_PRICE_ID  — Paddle price ID for Standard lifetime
 *   PADDLE_CORPORATE_LIFETIME_PRICE_ID  — Paddle price ID for Advanced lifetime
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { generateKey, randomCustomerId, annualExpiry, lifetimeExpiry } from '../lib/keygen.js';
import type { Tier } from '../lib/keygen.js';
import { sendLicenseEmail } from '../lib/email.js';

// ── Tier mapping ──────────────────────────────────────────────────────────────

function buildPriceMap(): Map<string, { tier: Tier; isLifetime: boolean }> {
    const map = new Map<string, { tier: Tier; isLifetime: boolean }>();

    const entries: Array<[string, Tier, boolean]> = [
        ['PADDLE_PERSONAL_PRICE_ID',          'personal',  false],
        ['PADDLE_SOVEREIGN_PRICE_ID',         'sovereign', false],
        ['PADDLE_CORPORATE_PRICE_ID',         'corporate', false],
        ['PADDLE_PERSONAL_LIFETIME_PRICE_ID', 'personal',  true],
        ['PADDLE_SOVEREIGN_LIFETIME_PRICE_ID','sovereign', true],
        ['PADDLE_CORPORATE_LIFETIME_PRICE_ID','corporate', true],
    ];

    for (const [envKey, tier, isLifetime] of entries) {
        const id = process.env[envKey];
        if (id) map.set(id, { tier, isLifetime });
    }

    return map;
}

// ── Paddle signature verification ─────────────────────────────────────────────

/**
 * Paddle Billing webhook signature:
 *   Header: Paddle-Signature: ts=<unix_timestamp>;h1=<hex_hmac>
 *   Signed string: "<ts>:<raw_body>"
 *   Algorithm: HMAC-SHA256 with the webhook secret from Paddle dashboard.
 *
 * We also reject webhooks older than 5 minutes to prevent replay attacks.
 */
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

    // Reject stale webhooks (replay protection, 5-minute window).
    const age = Math.floor(Date.now() / 1000) - parseInt(ts, 10);
    if (age > 300 || age < -60) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}:${rawBody}`));
    const computed = Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    // Constant-time comparison to prevent timing attacks.
    if (computed.length !== h1.length) return false;
    let mismatch = 0;
    for (let i = 0; i < computed.length; i++) {
        mismatch |= computed.charCodeAt(i) ^ h1.charCodeAt(i);
    }
    return mismatch === 0;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Read raw body — needed for signature verification before JSON parse.
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

    // Only process completed transactions.
    if (event.event_type !== 'transaction.completed') {
        return res.status(200).json({ received: true, skipped: true });
    }

    const tx = event.data;
    const customerEmail = tx.customer?.email;
    const customerName  = tx.customer?.name ?? tx.customer?.email ?? 'Customer';

    if (!customerEmail) {
        console.error('No customer email in transaction', tx.id);
        return res.status(200).json({ received: true, error: 'No customer email' });
    }

    // ── 3. Resolve tier from price ID ─────────────────────────────────────────
    const priceMap = buildPriceMap();
    const priceId  = tx.items?.[0]?.price?.id;
    const mapping  = priceId ? priceMap.get(priceId) : undefined;

    if (!mapping) {
        console.warn(`Unknown price ID: ${priceId} — cannot generate license key`);
        // Return 200 so Paddle doesn't retry; but log for manual follow-up.
        return res.status(200).json({ received: true, error: `Unknown price ID: ${priceId}` });
    }

    const { tier, isLifetime } = mapping;

    // ── 4. Generate license key ───────────────────────────────────────────────
    const masterSecret = process.env['AETHELGARD_LICENSE_SECRET'];
    if (!masterSecret) {
        console.error('AETHELGARD_LICENSE_SECRET not configured');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const customerId = randomCustomerId();
    const expiryDate = isLifetime ? lifetimeExpiry : annualExpiry();

    let licenseKey: string;
    try {
        licenseKey = await generateKey(tier, customerId, expiryDate, masterSecret);
    } catch (err) {
        console.error('Key generation failed:', err);
        return res.status(500).json({ error: 'Key generation failed' });
    }

    // ── 5. Send email ─────────────────────────────────────────────────────────
    try {
        await sendLicenseEmail({
            to: customerEmail,
            customerName,
            tier,
            licenseKey,
            isLifetime,
            expiryDate,
        });
    } catch (err) {
        console.error('Email delivery failed:', err);
        // Still return 500 so Paddle retries the webhook (email not sent yet).
        return res.status(500).json({ error: 'Email delivery failed' });
    }

    console.log(`License delivered: ${tier} to ${customerEmail} (tx: ${tx.id})`);
    return res.status(200).json({ success: true });
}

// ── Paddle event types (minimal — only what we need) ─────────────────────────

interface PaddleEvent {
    event_type: string;
    data: PaddleTransaction;
}

interface PaddleTransaction {
    id: string;
    customer?: {
        email?: string;
        name?: string;
    };
    items?: Array<{
        price?: {
            id?: string;
        };
    }>;
}
