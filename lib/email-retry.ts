/**
 * Resend retry + dead-letter for license-delivery emails.
 *
 * The webhook is the entire money path: Paddle pays the customer,
 * the webhook generates and persists a key, the email tells the
 * customer the key. If the email step fails (Resend rate limit,
 * recipient bounce, transient 5xx) we have a charged customer with
 * no key in their inbox. Returning HTTP 500 from the webhook so
 * Paddle retries does not help — webhook idempotency at tx_id will
 * re-issue the same key, but if Resend itself is the failure mode
 * every retry compounds the same loss.
 *
 * Strategy:
 *   1. Retry with exponential backoff on transient failures (5xx,
 *      429, network). 4 attempts total: 1s, 2s, 4s.
 *   2. On terminal failure, persist a `dead_letter:<tx_id>` record
 *      in Upstash containing the rendered email body so it can be
 *      re-sent manually after the underlying issue is resolved.
 *   3. Fire an admin notification (Slack webhook if
 *      `SLACK_ALERT_WEBHOOK_URL` is set, otherwise stderr-only) so
 *      Cherie sees the failure within minutes rather than reading
 *      KV by hand.
 *   4. Resolve successfully so the webhook returns HTTP 200 to
 *      Paddle. The dead-letter record is now the source of truth
 *      for the customer's outstanding email — we don't want Paddle
 *      to keep retrying the webhook (it can't help) and we don't
 *      want a chargeback because the customer-visible state at
 *      Paddle says the transaction failed.
 */

import { kv } from './redis.js';
import { redactEmail } from './log-redact.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1_000, 2_000, 4_000]; // pause AFTER attempts 1, 2, 3

export interface SendEmailResult {
    /** True when the message was accepted by Resend; false when dead-lettered. */
    delivered: boolean;
    /** Number of Resend POSTs made (1..MAX_ATTEMPTS). */
    attempts: number;
}

/**
 * Send an email through Resend with retry + dead-letter on terminal failure.
 *
 * Always resolves — never throws — so callers can return HTTP 200 to the
 * payment processor regardless of email-side outcome. Inspect `delivered`
 * to decide what to log.
 *
 * @param txId Idempotency key for the dead-letter record. For waitlist /
 *             non-revenue paths, pass `waitlist-${timestamp}-${ipHash}`
 *             or similar — the dead-letter is keyed off this string.
 */
export async function sendEmailWithDeadLetter(
    to: string,
    subject: string,
    html: string,
    txId: string,
): Promise<SendEmailResult> {
    const apiKey = process.env['RESEND_API_KEY'];
    if (!apiKey) {
        // Programming/configuration error — fall through to dead-letter so the
        // customer email is captured even if we can't deliver right now.
        await persistDeadLetter(txId, to, subject, html, 'RESEND_API_KEY not configured');
        await fireAdminAlert(`Email delivery failed (no RESEND_API_KEY) for tx ${txId} to ${redactEmail(to)}`);
        return { delivered: false, attempts: 0 };
    }

    let lastError = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(RESEND_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: 'Aethelgard <contact@aethelgard.finance>',
                    to,
                    subject,
                    html,
                }),
            });

            if (res.ok) {
                return { delivered: true, attempts: attempt };
            }

            const body = await res.text().catch(() => '<no body>');
            lastError = `Resend ${res.status}: ${body}`;

            // 4xx (except 429) is a permanent rejection — no retry will help.
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                break;
            }
        } catch (err) {
            // Network / DNS / timeout — treat as transient.
            lastError = `network: ${err instanceof Error ? err.message : String(err)}`;
        }

        if (attempt < MAX_ATTEMPTS) {
            await sleep(BACKOFF_MS[attempt - 1] ?? 4_000);
        }
    }

    // Terminal — the customer never got the email.
    await persistDeadLetter(txId, to, subject, html, lastError);
    await fireAdminAlert(
        `Email delivery failed after ${MAX_ATTEMPTS} attempts for tx ${txId} to ${redactEmail(to)}: ${lastError}`,
    );
    return { delivered: false, attempts: MAX_ATTEMPTS };
}

/**
 * Store the rendered email so a human (or a future replay job) can re-send
 * it once the underlying issue is fixed. 90-day TTL keeps the queue from
 * growing without bound while leaving plenty of time for manual recovery.
 */
async function persistDeadLetter(
    txId: string,
    to: string,
    subject: string,
    html: string,
    lastError: string,
): Promise<void> {
    try {
        const key = `dead_letter:${txId}`;
        const record = {
            tx_id:        txId,
            to,
            subject,
            html,
            last_error:   lastError,
            recorded_at:  new Date().toISOString(),
            attempts:     MAX_ATTEMPTS,
        };
        await kv.set(key, record, { ex: 90 * 24 * 60 * 60 });
    } catch (err) {
        // Last-resort: nothing we can do beyond log. The admin alert below
        // is the customer's recovery path even if KV is also down.
        console.error('Dead-letter persistence failed:', err);
    }
}

/**
 * Slack webhook if configured; otherwise stderr only. Never throws —
 * an alert that itself fails must not turn a recoverable email failure
 * into a webhook 500.
 */
async function fireAdminAlert(message: string): Promise<void> {
    console.error(`[ADMIN-ALERT] ${message}`);
    const webhookUrl = process.env['SLACK_ALERT_WEBHOOK_URL'];
    if (!webhookUrl) return;

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: `:rotating_light: ${message}` }),
        });
    } catch (err) {
        console.error('Slack admin-alert post failed:', err);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
