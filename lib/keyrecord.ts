/**
 * Shared types and helpers for licence key records in KV.
 *
 * Lives in lib/ (not api/) so modules like activation.ts and tests can import
 * it without pulling in Vercel handler code or the Upstash client.
 */

import type { Tier } from './keygen.js';

export interface DeviceRecord {
    fingerprint:  string;   // SHA-256 hex, 64 lowercase chars
    device_name:  string;   // User-visible label, capped at 100 chars
    activated_at: string;   // ISO 8601 UTC
    last_seen_at: string;   // ISO 8601 UTC — refreshed on each verify call
}

export interface KeyRecord {
    key:            string;
    transaction_id: string;
    tier:           Tier;
    is_lifetime:    boolean;
    issued_at:      string;
    customer_email: string;
    revoked:        boolean;
    device_limit:   number;         // Max concurrent devices.
    devices:        DeviceRecord[];
}

/**
 * Tolerate records written before the activation system shipped (no
 * device_limit / devices fields). Returns a record with sane defaults without
 * mutating KV — the next write will persist the full shape.
 */
export function withActivationDefaults(record: KeyRecord): KeyRecord {
    return {
        ...record,
        device_limit: record.device_limit ?? 3,
        devices:      record.devices      ?? [],
    };
}
