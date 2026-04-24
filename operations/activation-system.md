# Activation System — Reference

**Audience:** Cherie / future engineers / auditors
**Last updated:** 2026-04-24

Technical reference for how activation works: what a key contains, how
devices are registered, what fingerprinting does and doesn't do, and how
every error path is handled.

For the end-to-end system view, see [`licensing-architecture.md`](licensing-architecture.md).
For the integrity-chain / reseal side, see [`integrity-chain-email.md`](integrity-chain-email.md).

---

## Licence key format

```
AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX
```

24 characters of Crockford Base32 (no ambiguous `0/O`, `I/L/1`) after the
`AETHG-` prefix. That's 120 bits, packed into 15 bytes:

| Bytes | Field | Notes |
|---|---|---|
| 0 | `version` (4 bits) + `tier` (4 bits) | version is always 1; tier: 0=basic, 1=standard, 2=advanced |
| 1–2 | `expiry_months` (u16 BE) | months since 2026-01-01; `0xFFFF` = lifetime |
| 3–6 | `customer_id` (u32 BE) | random at generation time — no PII |
| 7–14 | HMAC | first 8 bytes of HMAC-SHA256(bytes[0..7], `AETHELGARD_LICENSE_SECRET`) |

The master secret is embedded into the Tauri binary at build time via the
`AETHELGARD_LICENSE_SECRET` environment variable. The same value must be
set in Vercel for key generation — they're the same constant.

No PII in the key. `customer_id` is random; the association to a real
customer is stored server-side in KV (`KeyRecord.customer_email`), not in
the key itself.

### Cross-language invariant

The TypeScript generator (`lib/keygen.ts`) and the Rust validator
(`aethelgard/src-tauri/src/license.rs`) must produce / accept identical
byte sequences. This is pinned by two tests:

- `aethelgard-licensing/lib/__tests__/keygen.test.mjs` → fixed test vector
  `AETHG-2BZZY0-0060WS-TGPEA5-PFRS3W` (tier=advanced, lifetime, customer_id=12345).
- `aethelgard/src-tauri/src/license.rs::tests::typescript_generated_key_validates_in_rust`
  → consumes that vector and asserts it validates in Rust.

If either test breaks, the TS and Rust implementations have diverged —
existing customer keys may stop validating. Fix both sides at once.

---

## KV schema — KeyRecord

Every licence issued since Phase 1 has a `key:<sha256_of_normalised_key>`
entry in Upstash:

```ts
interface KeyRecord {
    key:            string;          // original AETHG-... string, for idempotent re-delivery
    transaction_id: string;          // Paddle transaction ID
    tier:           'basic'|'standard'|'advanced';
    is_lifetime:    boolean;
    issued_at:      string;          // ISO 8601
    customer_email: string;          // binding target for integrity chain + support lookup
    revoked:        boolean;         // flipped by adjustment.created refund webhook or admin action
    device_limit:   number;          // 3 for single licences, 1 for each key in the advisor bundle
    devices:        DeviceRecord[];  // activated devices — see below
}

interface DeviceRecord {
    fingerprint:  string;   // 64 lowercase hex chars (SHA-256 of machine-uid)
    device_name:  string;   // user-visible label, capped at 100 chars
    activated_at: string;   // ISO 8601 UTC
    last_seen_at: string;   // refreshed by the 24h verify loop when the fingerprint matches
}
```

There's also a secondary index: `tx:<transaction_id>` → `<key_hash>` (or
array of hashes for advisor bundle). Used by the refund webhook to find
which keys to revoke, and by the idempotency check on webhook retries.

---

## Activation endpoint

`POST /api/activate`

Body:

```json
{
  "key": "AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX",
  "fingerprint": "<64 lowercase hex chars>",
  "device_name": "Cherie's MBP"
}
```

Responses:

| Code | Body | Meaning |
|---|---|---|
| 200 | `{activated: true, registered: false}` | Key not in KV (beta, pre-registry, or invalid). Client treats as valid with unlimited devices. |
| 200 | `{activated: true, existing: false, customer_email, limit, devices_used}` | New device registered; `devices_used` is now the count after insert. |
| 200 | `{activated: true, existing: true,  customer_email, limit, devices_used}` | Re-activation on a fingerprint that was already registered. Idempotent. `last_seen_at` refreshed. |
| 403 | `{activated: false, reason: "revoked"}` | `revoked:true` on the record. Client doesn't persist the key. |
| 409 | `{activated: false, reason: "limit_reached", limit, devices: [{device_name, activated_at, last_seen_at}]}` | Cap reached. Fingerprint in the devices list is scrubbed from the response (not sent to client). |
| 400 | `{error: "..."}` | Missing / malformed key or fingerprint. |
| 500 | `{error: "server_error"}` | KV unreachable or internal. |

Fails **closed** on server errors. First activation is the one place where
the client requires connectivity — see `licensing-architecture.md` for why.

---

## Fingerprint source per OS

The fingerprint is SHA-256 of the OS's stable machine ID, returned as 64
lowercase hex characters. The raw machine ID is **never transmitted** —
only the hash — so activation telemetry cannot be used to identify
specific hardware.

| OS | Source | Stable across | Changes on |
|---|---|---|---|
| Windows | `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` | App updates, disk reformat, user account changes | OS reinstall, registry hive corruption |
| macOS | `IOPlatformUUID` (`ioreg`) | App updates, account changes | OS reinstall, certain warranty-replacement hardware swaps |
| Linux | `/etc/machine-id` | App updates | Reimaging, VM cloning (each clone gets its own after first boot on most distros) |

Implementation: `aethelgard/src-tauri/src/fingerprint.rs`, which wraps the
`machine-uid` crate.

### What fingerprinting doesn't try to do

- It's not DRM. A determined user can spoof `MachineGuid` on Windows or
  `/etc/machine-id` on Linux. This is deliberate — the goal is casual
  sharing deterrence, not piracy prevention.
- It's not privacy-invasive. We store a SHA-256 digest, not the raw ID.
  Given a fingerprint, you cannot reverse to the machine ID.
- It's not used for anything other than activation — no cross-request
  tracking, no analytics.

---

## Device caps

| Product | `device_limit` | Rationale |
|---|---|---|
| Single licence (basic / standard / advanced, annual or lifetime) | 3 | Covers the typical "desktop + laptop + one spare" pattern without needing support. |
| Each key in the advisor bundle (3 × Advanced Lifetime) | 1 | The bundle is sold for three separate advisors; each key is intended for one dedicated machine. |

Set when the Paddle webhook writes the KeyRecord. Existing rows that
predate Phase 1 would have no `device_limit` field — the activation
endpoint defaults missing fields to `{device_limit: 3, devices: []}` on
read (`withActivationDefaults` in `lib/keyrecord.ts`), so no migration
is needed.

---

## Client-side activation states and UI

From `aethelgard/src/components/VaultSettings.tsx`:

| Tagged response | UI |
|---|---|
| `outcome: success` | Toast "License activated." Tier badge updates; "Licensed to: email" and "N of M devices active" appear. |
| `outcome: success, existing: true` | Toast "License re-activated on this device." No device-count change. |
| `outcome: limit_reached` | `LimitReachedModal` — lists the 3 current devices with name + activated / last-seen dates. Pre-filled mailto to `contact@aethelgard.finance`. |
| `outcome: revoked` | Inline red text: "This licence has been revoked. If you believe this is a mistake, email contact@aethelgard.finance." |
| `outcome: network_error` | Inline red text: "Could not reach the licensing server. An internet connection is required the first time a licence is activated. Once activated, Aethelgard works fully offline." |

The tagged response is a `#[serde(tag="outcome", rename_all="snake_case")]`
enum — the frontend pattern-matches on the `outcome` discriminator.

---

## What activation does NOT do

- **Doesn't verify payment independently.** The webhook is the only
  source of record that a purchase happened. If someone had a working
  licence key that was never in KV (e.g., a beta key), it activates
  as `registered: false` with no device tracking.
- **Doesn't enforce anything on vaults.** The activation response
  includes `customer_email` for the client's own use (integrity-chain
  binding, About-screen display). The vault's data is separate — the
  server never sees it.
- **Doesn't block licences without integrity binding.** Whether a user
  enables integrity binding is their choice. Their licence works
  either way.

---

## Interaction with the integrity chain

On successful activation, the client stores `customer_email` in
`app_settings` under the `license_customer_email` key. This is:

- Displayed in Vault Settings → Licence as "Licensed to: email"
- Displayed on the Dashboard (once integrity binding is enabled) as
  "Chain originated by: email"
- Used as the target email for the reseal operation

The 24-hour verify loop refreshes this value on every successful check,
so if the customer's licence email is re-issued under a new address,
`license_customer_email` updates automatically. The user still has to
explicitly reseal (Vault Settings → Licence → "Reseal chain under new
email") for the bound email to change; the two settings are deliberately
separate so the chain rebind is a visible, deliberate act.

See [`integrity-chain-email.md`](integrity-chain-email.md) for the full
binding design.

---

## Cross-references

- End-to-end architecture: [`licensing-architecture.md`](licensing-architecture.md)
- Integrity / reseal: [`integrity-chain-email.md`](integrity-chain-email.md)
- Admin operations: [`admin-scripts.md`](admin-scripts.md)
- Support scripts / playbooks: [`support-playbooks.md`](support-playbooks.md)
