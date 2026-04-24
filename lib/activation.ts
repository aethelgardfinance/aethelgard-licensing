/**
 * Pure activation logic — separated from the HTTP handler so it can be
 * exercised by unit tests with an in-memory KV stub.
 *
 * The handler at api/activate.ts performs HTTP parsing/validation and then
 * delegates to activateDevice() below. Any changes to activation semantics
 * belong here, with tests alongside in lib/__tests__/activation.test.mjs.
 *
 * On concurrent activations from the same key:
 *   Upstash's REST API does not provide a transactional compare-and-swap for
 *   arbitrary JSON values. Two activations landing within the same millisecond
 *   could both read devices.length < limit and both write — briefly exceeding
 *   the cap by one. Accepted: the cap is soft, audit-recoverable via
 *   scripts/deactivate.mjs, and the scenario (one customer activating on two
 *   machines in the same tick) is vanishingly rare. Do not silently block a
 *   legitimate second activation to defend against this.
 */

import { withActivationDefaults, type DeviceRecord, type KeyRecord } from './keyrecord.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal KV surface — lets tests pass an in-memory map instead of Upstash. */
export interface KvLike {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<unknown>;
}

export interface ActivateInput {
    /** SHA-256 hex of the normalised licence key body — caller hashes. */
    keyHash:     string;
    /** SHA-256 hex of the machine fingerprint, lowercase, 64 chars. */
    fingerprint: string;
    /** User-visible device label — already trimmed/capped by the caller. */
    device_name: string;
}

export type ActivateResult =
    | { status: 'unregistered' }
    | { status: 'activated';     existing: boolean; record: KeyRecord }
    | { status: 'revoked' }
    | { status: 'limit_reached'; limit: number; devices: DeviceRecord[] };

// ── Core logic ────────────────────────────────────────────────────────────────

export async function activateDevice(
    kv: KvLike,
    input: ActivateInput,
    now: () => Date = () => new Date(),
): Promise<ActivateResult> {
    const kvKey = `key:${input.keyHash}`;
    const raw   = await kv.get<KeyRecord>(kvKey);

    // Not in registry — beta / pre-registry / manually issued. Permit unlimited.
    if (!raw) return { status: 'unregistered' };

    if (raw.revoked) return { status: 'revoked' };

    const record = withActivationDefaults(raw);

    // Idempotent re-activation: same fingerprint on an already-registered device.
    const existingIdx = record.devices.findIndex(d => d.fingerprint === input.fingerprint);
    if (existingIdx >= 0) {
        const updatedDevices = record.devices.map((d, i) =>
            i === existingIdx
                ? { ...d, device_name: input.device_name, last_seen_at: now().toISOString() }
                : d,
        );
        const updated: KeyRecord = { ...record, devices: updatedDevices };
        await kv.set(kvKey, updated);
        return { status: 'activated', existing: true, record: updated };
    }

    // New device — only if under the cap.
    if (record.devices.length >= record.device_limit) {
        return {
            status:  'limit_reached',
            limit:   record.device_limit,
            // Return a sanitised view — fingerprint is internal, don't leak it to clients.
            devices: record.devices.map(d => ({
                fingerprint:  '',
                device_name:  d.device_name,
                activated_at: d.activated_at,
                last_seen_at: d.last_seen_at,
            })),
        };
    }

    const nowIso: string = now().toISOString();
    const newDevice: DeviceRecord = {
        fingerprint:  input.fingerprint,
        device_name:  input.device_name,
        activated_at: nowIso,
        last_seen_at: nowIso,
    };
    const updated: KeyRecord = { ...record, devices: [...record.devices, newDevice] };
    await kv.set(kvKey, updated);
    return { status: 'activated', existing: false, record: updated };
}

// ── Input sanitisation (shared by handler and any future callers) ────────────

/** Normalise a user-supplied device name: trim, cap length, strip control chars. */
export function sanitiseDeviceName(raw: unknown): string {
    if (typeof raw !== 'string') return 'Unknown device';
    // Strip ASCII control characters (keep printable + extended unicode).
    const stripped = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (stripped.length === 0) return 'Unknown device';
    return stripped.length > 100 ? stripped.slice(0, 100) : stripped;
}

/** Validate a fingerprint string — must be 64 lowercase hex chars (SHA-256 output). */
export function isValidFingerprint(raw: unknown): raw is string {
    return typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw);
}
