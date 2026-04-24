/**
 * Tests for lib/activation.ts — the pure activation logic.
 *
 * Run via:
 *   node --loader ts-node/esm --test lib/__tests__/activation.test.ts
 *
 * Uses an in-memory KvLike stub to avoid any network I/O. The intent is to
 * exercise every branch of activateDevice() and the input sanitisers in
 * isolation from the Vercel handler wrapper.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    activateDevice,
    isValidFingerprint,
    sanitiseDeviceName,
    type KvLike,
} from '../activation.js';
import type { KeyRecord } from '../keyrecord.js';

// ── In-memory KV stub ────────────────────────────────────────────────────────

class MemKv implements KvLike {
    store = new Map<string, unknown>();
    async get<T>(k: string): Promise<T | null> {
        return (this.store.get(k) as T) ?? null;
    }
    async set(k: string, v: unknown): Promise<'OK'> {
        this.store.set(k, v);
        return 'OK';
    }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const FP_C = 'c'.repeat(64);
const FP_D = 'd'.repeat(64);

const KEY_HASH = '1234567890abcdef'.repeat(4);

function makeRecord(overrides: Partial<KeyRecord> = {}): KeyRecord {
    return {
        key:            'AETHG-TEST01-TEST02-TEST03-TEST04',
        transaction_id: 'tx_test',
        tier:           'advanced',
        is_lifetime:    true,
        issued_at:      '2026-04-01T00:00:00.000Z',
        customer_email: 'test@example.com',
        revoked:        false,
        device_limit:   3,
        devices:        [],
        ...overrides,
    };
}

const FROZEN_NOW = () => new Date('2026-04-24T10:00:00.000Z');

// ── activateDevice: no record present ─────────────────────────────────────────

describe('activateDevice — unregistered keys', () => {
    test('returns "unregistered" when no record is in KV', async () => {
        const kv = new MemKv();
        const result = await activateDevice(kv, {
            keyHash:     KEY_HASH,
            fingerprint: FP_A,
            device_name: 'Laptop',
        }, FROZEN_NOW);
        assert.equal(result.status, 'unregistered');
    });

    test('does not write anything to KV for unregistered keys', async () => {
        const kv = new MemKv();
        await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_A, device_name: 'Laptop',
        }, FROZEN_NOW);
        assert.equal(kv.store.size, 0);
    });
});

// ── activateDevice: revoked ──────────────────────────────────────────────────

describe('activateDevice — revoked keys', () => {
    test('returns "revoked" and makes no changes', async () => {
        const kv = new MemKv();
        kv.store.set(`key:${KEY_HASH}`, makeRecord({ revoked: true }));
        const result = await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_A, device_name: 'Laptop',
        }, FROZEN_NOW);
        assert.equal(result.status, 'revoked');
        const after = kv.store.get(`key:${KEY_HASH}`) as KeyRecord;
        assert.equal(after.devices.length, 0);
    });
});

// ── activateDevice: new device under limit ───────────────────────────────────

describe('activateDevice — new activations', () => {
    let kv: MemKv;
    beforeEach(() => { kv = new MemKv(); });

    test('appends device and returns existing:false when under limit', async () => {
        kv.store.set(`key:${KEY_HASH}`, makeRecord());
        const result = await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_A, device_name: 'Cherie MBP',
        }, FROZEN_NOW);

        assert.equal(result.status, 'activated');
        if (result.status !== 'activated') return;
        assert.equal(result.existing, false);
        assert.equal(result.record.devices.length, 1);
        assert.deepEqual(result.record.devices[0], {
            fingerprint:  FP_A,
            device_name:  'Cherie MBP',
            activated_at: '2026-04-24T10:00:00.000Z',
            last_seen_at: '2026-04-24T10:00:00.000Z',
        });
    });

    test('persists the updated record to KV', async () => {
        kv.store.set(`key:${KEY_HASH}`, makeRecord());
        await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_A, device_name: 'MBP',
        }, FROZEN_NOW);
        const stored = kv.store.get(`key:${KEY_HASH}`) as KeyRecord;
        assert.equal(stored.devices.length, 1);
        assert.equal(stored.devices[0]!.fingerprint, FP_A);
    });

    test('second device goes through when under the limit of 3', async () => {
        kv.store.set(`key:${KEY_HASH}`, makeRecord({
            devices: [{
                fingerprint: FP_A, device_name: 'D1',
                activated_at: '2026-04-01T00:00:00.000Z',
                last_seen_at: '2026-04-01T00:00:00.000Z',
            }],
        }));
        const result = await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_B, device_name: 'D2',
        }, FROZEN_NOW);
        assert.equal(result.status, 'activated');
        if (result.status !== 'activated') return;
        assert.equal(result.record.devices.length, 2);
    });
});

// ── activateDevice: idempotent re-activation ─────────────────────────────────

describe('activateDevice — re-activation (same fingerprint)', () => {
    test('returns existing:true without appending a new device', async () => {
        const kv = new MemKv();
        kv.store.set(`key:${KEY_HASH}`, makeRecord({
            devices: [{
                fingerprint:  FP_A,
                device_name:  'Old Name',
                activated_at: '2026-04-01T00:00:00.000Z',
                last_seen_at: '2026-04-01T00:00:00.000Z',
            }],
        }));

        const result = await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_A, device_name: 'New Name',
        }, FROZEN_NOW);

        assert.equal(result.status, 'activated');
        if (result.status !== 'activated') return;
        assert.equal(result.existing, true);
        assert.equal(result.record.devices.length, 1);
    });

    test('updates device_name and last_seen_at on re-activation', async () => {
        const kv = new MemKv();
        kv.store.set(`key:${KEY_HASH}`, makeRecord({
            devices: [{
                fingerprint:  FP_A,
                device_name:  'Old Name',
                activated_at: '2026-04-01T00:00:00.000Z',
                last_seen_at: '2026-04-01T00:00:00.000Z',
            }],
        }));

        const result = await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_A, device_name: 'New Name',
        }, FROZEN_NOW);

        if (result.status !== 'activated') { assert.fail('expected activated'); return; }
        const device = result.record.devices[0]!;
        assert.equal(device.device_name, 'New Name');
        assert.equal(device.last_seen_at, '2026-04-24T10:00:00.000Z');
        // activated_at must NOT change on re-activation
        assert.equal(device.activated_at, '2026-04-01T00:00:00.000Z');
    });
});

// ── activateDevice: limit reached ────────────────────────────────────────────

describe('activateDevice — limit reached', () => {
    test('returns limit_reached for 4th different fingerprint when limit=3', async () => {
        const kv = new MemKv();
        kv.store.set(`key:${KEY_HASH}`, makeRecord({
            devices: [
                { fingerprint: FP_A, device_name: 'D1', activated_at: 'a', last_seen_at: 'a' },
                { fingerprint: FP_B, device_name: 'D2', activated_at: 'b', last_seen_at: 'b' },
                { fingerprint: FP_C, device_name: 'D3', activated_at: 'c', last_seen_at: 'c' },
            ],
        }));

        const result = await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_D, device_name: 'D4',
        }, FROZEN_NOW);

        assert.equal(result.status, 'limit_reached');
        if (result.status !== 'limit_reached') return;
        assert.equal(result.limit, 3);
        assert.equal(result.devices.length, 3);
    });

    test('sanitises devices list in limit_reached response (no fingerprints leaked)', async () => {
        const kv = new MemKv();
        kv.store.set(`key:${KEY_HASH}`, makeRecord({
            devices: [
                { fingerprint: FP_A, device_name: 'D1', activated_at: 'a', last_seen_at: 'a' },
                { fingerprint: FP_B, device_name: 'D2', activated_at: 'b', last_seen_at: 'b' },
                { fingerprint: FP_C, device_name: 'D3', activated_at: 'c', last_seen_at: 'c' },
            ],
        }));

        const result = await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_D, device_name: 'D4',
        }, FROZEN_NOW);

        if (result.status !== 'limit_reached') { assert.fail('expected limit_reached'); return; }
        for (const d of result.devices) {
            assert.equal(d.fingerprint, '', 'fingerprint must not leak to client');
        }
    });

    test('bundle-key limit of 1 blocks a second fingerprint', async () => {
        const kv = new MemKv();
        kv.store.set(`key:${KEY_HASH}`, makeRecord({
            device_limit: 1,
            devices: [
                { fingerprint: FP_A, device_name: 'Advisor MBP', activated_at: 'a', last_seen_at: 'a' },
            ],
        }));

        const result = await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_B, device_name: 'Other machine',
        }, FROZEN_NOW);

        assert.equal(result.status, 'limit_reached');
        if (result.status !== 'limit_reached') return;
        assert.equal(result.limit, 1);
    });
});

// ── activateDevice: backwards-compat with pre-activation records ──────────────

describe('activateDevice — backwards compatibility', () => {
    test('accepts records lacking device_limit/devices (treats as 3/empty)', async () => {
        const kv = new MemKv();
        // Simulate an old KeyRecord written before the activation system shipped.
        const legacyRecord = {
            key:            'AETHG-OLD01-OLD02-OLD03-OLD04',
            transaction_id: 'tx_legacy',
            tier:           'advanced',
            is_lifetime:    true,
            issued_at:      '2026-01-01T00:00:00.000Z',
            customer_email: 'legacy@example.com',
            revoked:        false,
        };
        kv.store.set(`key:${KEY_HASH}`, legacyRecord);

        const result = await activateDevice(kv, {
            keyHash: KEY_HASH, fingerprint: FP_A, device_name: 'Legacy',
        }, FROZEN_NOW);

        assert.equal(result.status, 'activated');
        if (result.status !== 'activated') return;
        assert.equal(result.existing, false);
        assert.equal(result.record.device_limit, 3);
        assert.equal(result.record.devices.length, 1);
    });
});

// ── sanitiseDeviceName ───────────────────────────────────────────────────────

describe('sanitiseDeviceName', () => {
    test('trims whitespace', () => {
        assert.equal(sanitiseDeviceName('  Cherie MBP  '), 'Cherie MBP');
    });

    test('strips ASCII control characters', () => {
        assert.equal(sanitiseDeviceName('Hello\x00World\x1b[31m'), 'HelloWorld[31m');
    });

    test('caps at 100 characters', () => {
        const long = 'x'.repeat(200);
        assert.equal(sanitiseDeviceName(long).length, 100);
    });

    test('returns "Unknown device" for non-strings', () => {
        assert.equal(sanitiseDeviceName(undefined), 'Unknown device');
        assert.equal(sanitiseDeviceName(null), 'Unknown device');
        assert.equal(sanitiseDeviceName(42), 'Unknown device');
        assert.equal(sanitiseDeviceName({}), 'Unknown device');
    });

    test('returns "Unknown device" for empty or whitespace-only strings', () => {
        assert.equal(sanitiseDeviceName(''), 'Unknown device');
        assert.equal(sanitiseDeviceName('   '), 'Unknown device');
        assert.equal(sanitiseDeviceName('\x00\x01\x02'), 'Unknown device');
    });

    test('preserves unicode (including non-ASCII characters)', () => {
        const name = "Cherie’s MacBook Pro — M3";
        assert.equal(sanitiseDeviceName(name), name);
    });
});

// ── isValidFingerprint ───────────────────────────────────────────────────────

describe('isValidFingerprint', () => {
    test('accepts 64 lowercase hex chars', () => {
        assert.equal(isValidFingerprint('a'.repeat(64)), true);
        assert.equal(isValidFingerprint('0123456789abcdef'.repeat(4)), true);
    });

    test('rejects wrong length', () => {
        assert.equal(isValidFingerprint('a'.repeat(63)), false);
        assert.equal(isValidFingerprint('a'.repeat(65)), false);
        assert.equal(isValidFingerprint(''), false);
    });

    test('rejects uppercase hex', () => {
        assert.equal(isValidFingerprint('A'.repeat(64)), false);
        assert.equal(isValidFingerprint('ABCDEF'.repeat(10) + 'abcd'), false);
    });

    test('rejects non-hex characters', () => {
        assert.equal(isValidFingerprint('g'.repeat(64)), false);
        assert.equal(isValidFingerprint('a'.repeat(63) + ' '), false);
        assert.equal(isValidFingerprint('a'.repeat(63) + '-'), false);
    });

    test('rejects non-strings', () => {
        assert.equal(isValidFingerprint(undefined), false);
        assert.equal(isValidFingerprint(null), false);
        assert.equal(isValidFingerprint(123), false);
        assert.equal(isValidFingerprint({}), false);
    });
});
