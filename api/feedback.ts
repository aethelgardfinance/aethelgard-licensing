/**
 * Vercel Serverless Function — beta tester issue reports.
 *
 * POST /api/feedback
 * Body: { type: "feedback", title, severity ("Critical"|"High"|"Medium"|"Low"),
 *         area, email, actual, steps?, expected?, frequency?,
 *         appVersion?, os?, notes? }
 *
 * The web-based counterpart to the in-app "Report an Issue" form. It exists
 * mainly for testers who cannot get into the app (install failure, crash on
 * launch) and so cannot use the in-app reporter. Sends a notification to
 * contact@aethelgard.finance via Resend and queues the report in Upstash.
 *
 * PRIVACY: This endpoint must never receive real financial data. The web form
 * carries an explicit attestation and asks testers to scrub real account
 * numbers, balances and names, keeping only the structure (columns, dates,
 * +/- signs). No vault file, PIN or licence key should ever reach here.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '../lib/redis.js';

const ALLOWED_ORIGIN = 'https://aethelgard.finance';

// Fixed-window rate limit: 5 submissions per IP per minute (mirrors the
// waitlist / request-bank endpoints). Soft-fails open — this is a contact
// form, not an auth boundary.
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
        const key = `feedback-rate:${ip}`;
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

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];

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

    const {
        type, title, severity, area, email, actual, steps, expected,
        frequency, appVersion, os, notes,
    } = req.body as {
        type?: string;
        title?: string;
        severity?: string;
        area?: string;
        email?: string;
        actual?: string;
        steps?: string;
        expected?: string;
        frequency?: string;
        appVersion?: string;
        os?: string;
        notes?: string;
    };

    // Length caps before any other validation — protects the email body, the
    // Resend payload size, and the KV record from oversize input.
    const MAX_EMAIL = 254;
    const MAX_TITLE = 140;
    const MAX_AREA = 120;
    const MAX_FREQUENCY = 40;
    const MAX_VERSION = 20;
    const MAX_OS = 80;
    const MAX_TEXT = 4000;

    if (type !== 'feedback') {
        return res.status(400).json({ error: 'Invalid type' });
    }

    if (!title || title.length > MAX_TITLE) {
        return res.status(400).json({ error: 'A short title is required' });
    }

    if (!severity || !SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: 'Invalid severity' });
    }

    if (!area || area.length > MAX_AREA) {
        return res.status(400).json({ error: 'Area is required' });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > MAX_EMAIL) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    if (!actual || actual.length > MAX_TEXT) {
        return res.status(400).json({ error: 'Please describe what happened' });
    }

    if (
        (steps && steps.length > MAX_TEXT)
        || (expected && expected.length > MAX_TEXT)
        || (notes && notes.length > MAX_TEXT)
        || (frequency && frequency.length > MAX_FREQUENCY)
        || (appVersion && appVersion.length > MAX_VERSION)
        || (os && os.length > MAX_OS)
    ) {
        return res.status(400).json({ error: 'One or more fields exceed the allowed length' });
    }

    const resendApiKey = process.env['RESEND_API_KEY'];
    if (!resendApiKey) {
        console.error('RESEND_API_KEY not configured');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    const subject = `[${severity}] ${escapeHtml(area)} — ${escapeHtml(title)}`;
    const html = `<h2>New tester issue report</h2>
<table cellpadding="6" style="border-collapse:collapse">
  <tr><td><strong>Title</strong></td><td>${escapeHtml(title)}</td></tr>
  <tr><td><strong>Severity</strong></td><td>${escapeHtml(severity)}</td></tr>
  <tr><td><strong>Area</strong></td><td>${escapeHtml(area)}</td></tr>
  <tr><td><strong>Frequency</strong></td><td>${frequency ? escapeHtml(frequency) : '&mdash;'}</td></tr>
  <tr><td><strong>Reporter email</strong></td><td>${escapeHtml(email)}</td></tr>
  <tr><td><strong>App version</strong></td><td>${appVersion ? escapeHtml(appVersion) : '&mdash;'}</td></tr>
  <tr><td><strong>OS / browser</strong></td><td>${os ? escapeHtml(os) : '&mdash;'}</td></tr>
  <tr><td valign="top"><strong>Steps to reproduce</strong></td><td style="white-space:pre-wrap">${steps ? escapeHtml(steps) : '&mdash;'}</td></tr>
  <tr><td valign="top"><strong>Expected</strong></td><td style="white-space:pre-wrap">${expected ? escapeHtml(expected) : '&mdash;'}</td></tr>
  <tr><td valign="top"><strong>What happened</strong></td><td style="white-space:pre-wrap">${escapeHtml(actual)}</td></tr>
  <tr><td valign="top"><strong>Anything else</strong></td><td style="white-space:pre-wrap">${notes ? escapeHtml(notes) : '&mdash;'}</td></tr>
</table>
<p style="color:#888;font-size:12px">Submitted via the website report-an-issue form. Reply to the reporter at ${escapeHtml(email)}.</p>`;

    const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 'Aethelgard <contact@aethelgard.finance>',
            to: 'contact@aethelgard.finance',
            reply_to: email,
            subject,
            html,
        }),
    });

    if (!sendRes.ok) {
        const body = await sendRes.text();
        console.error(`Resend error ${sendRes.status}: ${body}`);
        return res.status(500).json({ error: 'Failed to send report' });
    }

    // Best-effort triage queue — never block the response. Capped to bound growth.
    try {
        await kv.lpush('feedback', JSON.stringify({
            title,
            severity,
            area,
            frequency: frequency ?? null,
            email,
            appVersion: appVersion ?? null,
            os: os ?? null,
            steps: steps ?? null,
            expected: expected ?? null,
            actual,
            notes: notes ?? null,
            ts: Date.now(),
        }));
        await kv.ltrim('feedback', 0, 499);
    } catch (err) {
        console.warn('Feedback persist failed:', err);
    }

    return res.status(200).json({ ok: true });
}
