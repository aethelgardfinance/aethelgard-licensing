/**
 * Vercel Serverless Function — "Request a bank" import-adapter requests.
 *
 * POST /api/request-bank
 * Body: { type: "request-bank", bank, country?, format ("CSV"|"PDF"),
 *         email, tier?, appVersion?, sample?, notes? }
 *
 * A user asks for support for a bank/broker whose statement format Aethelgard
 * does not yet parse. Sends a notification to contact@aethelgard.finance via
 * Resend and bumps a per-bank demand counter in Upstash for prioritisation.
 *
 * PRIVACY: `sample` is expected to be a REDACTED / synthetic format sample
 * (headers + fake values) supplied by the user behind an explicit attestation
 * on the web form. No live financial data should ever reach this endpoint.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../lib/redis.js';

const ALLOWED_ORIGIN = 'https://aethelgard.finance';

// Fixed-window rate limit: 5 submissions per IP per minute (mirrors the
// waitlist endpoint). Cheap on Upstash with INCR + EXPIRE; soft-fails open
// because this is a marketing/contact form, not an auth boundary.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 5;

function clientIp(req: VercelRequest): string {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (raw) {
        const first = raw.split(',')[0]?.trim();
        if (first) return first;
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim();
    return 'unknown';
}

async function isRateLimited(ip: string): Promise<boolean> {
    try {
        const key = `request-bank-rate:${ip}`;
        const count = (await kv.incr(key)) as number;
        if (count === 1) {
            await kv.expire(key, RATE_LIMIT_WINDOW_SECONDS);
        }
        return count > RATE_LIMIT_MAX;
    } catch (err) {
        console.warn('Rate-limit KV check failed, allowing through:', err);
        return false;
    }
}

function setCorsHeaders(res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Normalise a bank name into a stable counter key: lowercase, alnum + dashes. */
function slug(bank: string): string {
    const s = bank
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return s || 'unknown';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = clientIp(req);
    if (await isRateLimited(ip)) {
        return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
    }

    const { email, type, bank, country, format, tier, appVersion, sample, notes } = req.body as {
        email?: string;
        type?: string;
        bank?: string;
        country?: string;
        format?: string;
        tier?: string;
        appVersion?: string;
        sample?: string;
        notes?: string;
    };

    // Length caps before any other validation — protects the email body, the
    // Resend payload size, and the KV record from oversize input.
    const MAX_EMAIL = 254;
    const MAX_BANK = 100;
    const MAX_COUNTRY = 100;
    const MAX_TIER = 50;
    const MAX_VERSION = 20;
    const MAX_SAMPLE = 5000;
    const MAX_NOTES = 2000;

    if (type !== 'request-bank') {
        return res.status(400).json({ error: 'Invalid type' });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > MAX_EMAIL) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    if (!bank || bank.length > MAX_BANK) {
        return res.status(400).json({ error: 'Bank name is required' });
    }

    if (format !== 'CSV' && format !== 'PDF') {
        return res.status(400).json({ error: 'Invalid format' });
    }

    if (
        (country && country.length > MAX_COUNTRY)
        || (tier && tier.length > MAX_TIER)
        || (appVersion && appVersion.length > MAX_VERSION)
        || (sample && sample.length > MAX_SAMPLE)
        || (notes && notes.length > MAX_NOTES)
    ) {
        return res.status(400).json({ error: 'One or more fields exceed the allowed length' });
    }

    const resendApiKey = process.env['RESEND_API_KEY'];
    if (!resendApiKey) {
        console.error('RESEND_API_KEY not configured');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    const subject = `[Aethelgard] Bank request: ${escapeHtml(bank)} (${format})`;
    const html = `<h2>New bank/broker adapter request</h2>
<table cellpadding="6" style="border-collapse:collapse">
  <tr><td><strong>Bank</strong></td><td>${escapeHtml(bank)}</td></tr>
  <tr><td><strong>Country</strong></td><td>${country ? escapeHtml(country) : '&mdash;'}</td></tr>
  <tr><td><strong>Format</strong></td><td>${format}</td></tr>
  <tr><td><strong>Email</strong></td><td>${escapeHtml(email)}</td></tr>
  <tr><td><strong>Tier</strong></td><td>${tier ? escapeHtml(tier) : '&mdash;'}</td></tr>
  <tr><td><strong>App version</strong></td><td>${appVersion ? escapeHtml(appVersion) : '&mdash;'}</td></tr>
  <tr><td valign="top"><strong>Notes</strong></td><td style="white-space:pre-wrap">${notes ? escapeHtml(notes) : '&mdash;'}</td></tr>
  <tr><td valign="top"><strong>Redacted sample</strong></td><td style="white-space:pre-wrap;font-family:monospace">${sample ? escapeHtml(sample) : '&mdash;'}</td></tr>
</table>`;

    const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 'Aethelgard <contact@aethelgard.finance>',
            to: 'contact@aethelgard.finance',
            subject,
            html,
        }),
    });

    if (!sendRes.ok) {
        const body = await sendRes.text();
        console.error(`Resend error ${sendRes.status}: ${body}`);
        return res.status(500).json({ error: 'Failed to send notification' });
    }

    // Best-effort demand counter for prioritisation — never block the response.
    try {
        await kv.incr(`bank-req:${slug(bank)}`);
    } catch (err) {
        console.warn('Demand-counter increment failed:', err);
    }

    return res.status(200).json({ ok: true });
}
