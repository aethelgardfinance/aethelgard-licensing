/**
 * Vercel Serverless Function — waitlist / design partner form submissions.
 *
 * POST /api/waitlist
 * Body (design-partner):       { email, name, role, background, type: "design-partner" }
 * Body (mac-waitlist):          { email, type: "mac-waitlist" }
 * Body (pdf-studio-waitlist):   { email, type: "pdf-studio-waitlist" }
 *
 * Sends a notification to contact@aethelgard.finance via Resend.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../lib/redis.js';

const ALLOWED_ORIGIN = 'https://aethelgard.finance';

// Fixed-window rate limit: 5 submissions per IP per minute. Cheap to
// implement on Upstash with INCR + EXPIRE, no extra dependency. The
// design-partner / waitlist forms see legitimate traffic of <1/min/IP
// in normal operation; 5 leaves headroom for honest retries while
// blocking the 1000-req-spam pattern.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX = 5;

/**
 * Best-effort client IP — Vercel populates `x-forwarded-for` with the
 * caller's IP as the leftmost entry. Fall back to a single-bucket key
 * if the header is missing so the limit still bites a misconfigured
 * deployment instead of failing open.
 */
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

/**
 * Allow-or-block decision. Soft-fails open on KV outages — this is a
 * marketing form, not an authentication boundary; degraded availability
 * of Upstash should not take down the contact path.
 */
async function isRateLimited(ip: string): Promise<boolean> {
    try {
        const key = `waitlist-rate:${ip}`;
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

    const { email, type, name, role, background } = req.body as {
        email?: string;
        type?: string;
        name?: string;
        role?: string;
        background?: string;
    };

    // Length caps before any other validation — protects the email body, the
    // Resend payload size limit, and any future KV record from oversize
    // input. RFC 5321 puts the email max at 254 chars; the rest are sized
    // for what a legitimate design-partner application looks like.
    const MAX_EMAIL = 254;
    const MAX_NAME = 100;
    const MAX_ROLE = 100;
    const MAX_BACKGROUND = 5000;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > MAX_EMAIL) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    if (type !== 'design-partner' && type !== 'mac-waitlist' && type !== 'pdf-studio-waitlist') {
        return res.status(400).json({ error: 'Invalid type' });
    }

    if (type === 'design-partner' && (!name || !role || !background)) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (
        (name && name.length > MAX_NAME)
        || (role && role.length > MAX_ROLE)
        || (background && background.length > MAX_BACKGROUND)
    ) {
        return res.status(400).json({ error: 'One or more fields exceed the allowed length' });
    }

    const resendApiKey = process.env['RESEND_API_KEY'];
    if (!resendApiKey) {
        console.error('RESEND_API_KEY not configured');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    const label =
        type === 'design-partner' ? 'Design Partner Application'
        : type === 'pdf-studio-waitlist' ? 'PDF Studio Waitlist'
        : 'Mac Waitlist';
    const subject = `[Aethelgard] New ${label}: ${name ? escapeHtml(name) + ' — ' : ''}${email}`;
    const html = type === 'design-partner'
        ? `<h2>New Design Partner Application</h2>
<table cellpadding="6" style="border-collapse:collapse">
  <tr><td><strong>Name</strong></td><td>${escapeHtml(name!)}</td></tr>
  <tr><td><strong>Email</strong></td><td>${escapeHtml(email)}</td></tr>
  <tr><td><strong>Role</strong></td><td>${escapeHtml(role!)}</td></tr>
  <tr><td><strong>Background</strong></td><td style="white-space:pre-wrap">${escapeHtml(background!)}</td></tr>
</table>`
        : `<p><strong>${label}</strong></p><p>Email: ${escapeHtml(email)}</p>`;

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

    return res.status(200).json({ ok: true });
}
