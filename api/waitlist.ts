/**
 * Vercel Serverless Function — waitlist / design partner form submissions.
 *
 * POST /api/waitlist
 * Body (design-partner): { email, name, role, background, type: "design-partner" }
 * Body (mac-waitlist):   { email, type: "mac-waitlist" }
 *
 * Sends a notification to contact@aethelgard.finance via Resend.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALLOWED_ORIGIN = 'https://aethelgard.finance';

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

    const { email, type, name, role, background } = req.body as {
        email?: string;
        type?: string;
        name?: string;
        role?: string;
        background?: string;
    };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    if (type !== 'design-partner' && type !== 'mac-waitlist') {
        return res.status(400).json({ error: 'Invalid type' });
    }

    if (type === 'design-partner' && (!name || !role || !background)) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const resendApiKey = process.env['RESEND_API_KEY'];
    if (!resendApiKey) {
        console.error('RESEND_API_KEY not configured');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    const label = type === 'design-partner' ? 'Design Partner Application' : 'Mac Waitlist';
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
