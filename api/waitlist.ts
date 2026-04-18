/**
 * Vercel Serverless Function — waitlist / design partner form submissions.
 *
 * POST /api/waitlist
 * Body: { email: string, type: "design-partner" | "mac-waitlist" }
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { email, type } = req.body as { email?: string; type?: string };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    if (type !== 'design-partner' && type !== 'mac-waitlist') {
        return res.status(400).json({ error: 'Invalid type' });
    }

    const resendApiKey = process.env['RESEND_API_KEY'];
    if (!resendApiKey) {
        console.error('RESEND_API_KEY not configured');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    const label = type === 'design-partner' ? 'Design Partner Application' : 'Mac Waitlist';
    const subject = `[Aethelgard] New ${label}: ${email}`;
    const html = `<p><strong>${label}</strong></p><p>Email: ${email}</p>`;

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
