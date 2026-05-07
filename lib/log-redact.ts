/**
 * Log redaction helpers — keep PII out of Vercel function logs.
 *
 * Customer email addresses, license keys, and similar identifiers must not
 * appear in plaintext in serverless logs. Logs are retained for 30+ days,
 * potentially visible to anyone with project access, and are not encrypted
 * at rest. GDPR Art. 5(1)(c) calls for data minimisation; a hash is
 * sufficient to correlate two log entries about the same customer without
 * leaking who they are.
 *
 * The hash is non-cryptographic — it's a short stable identifier, not a
 * privacy primitive. Use it for log correlation only, never for security
 * decisions.
 */

import { createHash } from 'node:crypto';

/**
 * Redact an email address to a stable 12-char identifier prefixed `eml:`.
 *
 * Same input always produces the same output (so logs about the same
 * customer can be correlated), different inputs almost always produce
 * different outputs (8 hex chars = 32-bit space; collisions exist but are
 * not load-bearing for log correlation).
 */
export function redactEmail(email: string): string {
    const h = createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
    return `eml:${h.slice(0, 12)}`;
}
