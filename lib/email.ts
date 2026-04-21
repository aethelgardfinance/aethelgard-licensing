/**
 * License key delivery emails via Resend.
 * https://resend.com/docs/api-reference/emails/send-email
 */

import type { Tier } from './keygen.js';

const TIER_LABEL: Record<Tier, string> = {
    basic:    'Basic',
    standard: 'Standard',
    advanced: 'Advanced',
};

// ── Single license email ──────────────────────────────────────────────────────

interface SendLicenseEmailParams {
    to: string;
    customerName: string;
    tier: Tier;
    licenseKey: string;
    isLifetime: boolean;
    expiryDate: Date | null;
}

export async function sendLicenseEmail(params: SendLicenseEmailParams): Promise<void> {
    const { to, customerName, tier, licenseKey, isLifetime, expiryDate } = params;
    const tierLabel = TIER_LABEL[tier];

    const expiryLine = isLifetime
        ? '<p style="color:#6b7280;font-size:14px;margin:0">This is a <strong>lifetime license</strong> — it never expires.</p>'
        : `<p style="color:#6b7280;font-size:14px;margin:0">Your license is valid until <strong>${expiryDate!.toISOString().slice(0, 10)}</strong>.</p>`;

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:40px 20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">

    <div style="background:#1e1b4b;padding:32px 40px">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;letter-spacing:-0.5px">Aethelgard</h1>
      <p style="color:#a5b4fc;margin:8px 0 0;font-size:14px">Sovereign Wealth &amp; Family Ledger</p>
    </div>

    <div style="padding:40px">
      <p style="color:#111827;font-size:16px;margin:0 0 24px">Hi ${escapeHtml(customerName)},</p>
      <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 24px">
        Thank you for purchasing Aethelgard <strong>${tierLabel}</strong>. Your license key is below.
      </p>

      <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:20px;margin:0 0 24px;text-align:center">
        <p style="color:#6d28d9;font-family:monospace;font-size:18px;font-weight:700;letter-spacing:2px;margin:0;word-break:break-all">
          ${escapeHtml(licenseKey)}
        </p>
      </div>

      ${expiryLine}

      <hr style="border:none;border-top:1px solid #f3f4f6;margin:32px 0">

      <h2 style="color:#111827;font-size:15px;font-weight:600;margin:0 0 12px">How to activate</h2>
      <ol style="color:#374151;font-size:14px;line-height:1.8;margin:0 0 24px;padding-left:20px">
        <li>Open Aethelgard on your Windows computer.</li>
        <li>Go to <strong>Vault Settings</strong> (the gear icon).</li>
        <li>Scroll to the <strong>License</strong> section.</li>
        <li>Paste your key and click <strong>Activate</strong>.</li>
      </ol>

      <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0">
        Questions? Reply to this email — we're a small team and we read every message.
      </p>
    </div>

    <div style="background:#f9fafb;border-top:1px solid #f3f4f6;padding:20px 40px">
      <p style="color:#9ca3af;font-size:12px;margin:0">
        Aethelgard — your data stays on your device, always.
      </p>
    </div>

  </div>
</body>
</html>`;

    await sendEmail(to, `Your Aethelgard ${tierLabel} License Key`, html);
}

// ── Advisor bundle email (3 × Advanced Lifetime) ─────────────────────────────

interface SendAdvisorBundleEmailParams {
    to: string;
    customerName: string;
    licenseKeys: [string, string, string];
}

export async function sendAdvisorBundleEmail(params: SendAdvisorBundleEmailParams): Promise<void> {
    const { to, customerName, licenseKeys } = params;

    const keyBlocks = licenseKeys.map((key, i) => `
      <div style="margin-bottom:16px">
        <p style="color:#374151;font-size:13px;font-weight:600;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.05em">Key ${i + 1} of 3</p>
        <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:16px;text-align:center">
          <p style="color:#6d28d9;font-family:monospace;font-size:16px;font-weight:700;letter-spacing:2px;margin:0;word-break:break-all">
            ${escapeHtml(key)}
          </p>
        </div>
      </div>`).join('');

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;margin:0;padding:40px 20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">

    <div style="background:#1e1b4b;padding:32px 40px">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;letter-spacing:-0.5px">Aethelgard</h1>
      <p style="color:#a5b4fc;margin:8px 0 0;font-size:14px">Advisor Bundle — 3 × Advanced Lifetime</p>
    </div>

    <div style="padding:40px">
      <p style="color:#111827;font-size:16px;margin:0 0 24px">Hi ${escapeHtml(customerName)},</p>
      <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 32px">
        Thank you for purchasing the <strong>Aethelgard Advisor Bundle</strong>. You have three independent
        Advanced Lifetime license keys below — one per client vault.
      </p>

      ${keyBlocks}

      <p style="color:#6b7280;font-size:14px;margin:24px 0 0">
        Each key is a standalone Advanced Lifetime license. Each client activates their own key in
        their own installation — keys are not transferable between vaults once activated.
      </p>

      <hr style="border:none;border-top:1px solid #f3f4f6;margin:32px 0">

      <h2 style="color:#111827;font-size:15px;font-weight:600;margin:0 0 12px">How to activate each key</h2>
      <ol style="color:#374151;font-size:14px;line-height:1.8;margin:0 0 24px;padding-left:20px">
        <li>Open Aethelgard on the client's Windows computer.</li>
        <li>Go to <strong>Vault Settings</strong> (the gear icon).</li>
        <li>Scroll to the <strong>License</strong> section.</li>
        <li>Paste the key and click <strong>Activate</strong>.</li>
      </ol>

      <p style="color:#6b7280;font-size:13px;line-height:1.6;margin:0">
        Questions? Reply to this email — we're a small team and we read every message.
      </p>
    </div>

    <div style="background:#f9fafb;border-top:1px solid #f3f4f6;padding:20px 40px">
      <p style="color:#9ca3af;font-size:12px;margin:0">
        Aethelgard — your data stays on your device, always.
      </p>
    </div>

  </div>
</body>
</html>`;

    await sendEmail(to, 'Your Aethelgard Advisor Bundle — 3 License Keys', html);
}

// ── Shared sender ─────────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
    const resendApiKey = process.env['RESEND_API_KEY'];
    if (!resendApiKey) throw new Error('RESEND_API_KEY is not configured');

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 'Aethelgard <contact@aethelgard.finance>',
            to,
            subject,
            html,
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Resend API error ${res.status}: ${body}`);
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
