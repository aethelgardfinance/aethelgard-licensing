# Licensing System — Architecture

**Audience:** Cherie / future engineers onboarding to this codebase
**Last updated:** 2026-04-24

End-to-end view of how purchases become working licences, how the client
enforces them, and how revocation / reseal propagate. Read this when
you need to trace "where does X actually live" across the stack.

---

## Two repositories, one system

```
aethelgard-licensing/  ← you are here (server)
├─ api/                ← Vercel serverless functions
│  ├─ paddle-webhook.ts  → receives Paddle events, generates keys, emails them
│  ├─ activate.ts        → POST; registers a device's fingerprint against a key
│  ├─ verify.ts          → GET; returns revocation status; refreshes last_seen
│  ├─ waitlist.ts        → (unrelated to licensing — pre-launch signups)
│  └─ latest.ts          → (health / version check)
├─ lib/
│  ├─ keygen.ts          → HMAC key format, hashing, tier mapping
│  ├─ activation.ts      → pure activation logic (KV-testable)
│  ├─ keyrecord.ts       → KeyRecord + DeviceRecord types
│  ├─ email.ts           → Resend integration
│  └─ redis.ts           → Upstash KV client
├─ scripts/              ← admin tools (Node)
│  ├─ send-prep.mjs      → beta / outreach email drafts
│  ├─ deactivate.mjs     → free a device slot
│  └─ simulate-webhook.mjs → sign & POST fake Paddle events
└─ operations/           ← this folder

aethelgard/              ← client (Tauri app)
└─ src-tauri/src/
   ├─ license.rs          → HMAC validation (offline), trial fallback, tier state
   ├─ license_activate.rs → POST to /api/activate, parse response
   ├─ license_verify.rs   → GET /api/verify once per 24h
   ├─ fingerprint.rs      → SHA-256(machine-uid) — stable per-OS fingerprint
   ├─ cmd/license.rs      → Tauri commands: activate_license, get_license_email, …
   ├─ cmd/maintenance.rs  → reseal_integrity_chain, get_integrity_binding_status
   └─ db/integrity.rs     → hash chain over transactions, reseal operation
   src/components/
   ├─ VaultSettings.tsx   → licence activation UI, ResealModal, LimitReachedModal
   └─ DashboardHome.tsx   → "Chain originated by: email" panel (Phase 5d)
```

The two repos communicate only via HTTPS. The client never has
direct access to KV or Paddle; the server never has access to the
client's vault.

---

## External services

| Service | Role | Credentials source |
|---|---|---|
| **Paddle** | Billing, customer records, refund processing | `PADDLE_WEBHOOK_SECRET`, `PADDLE_API_KEY`, price IDs per tier |
| **Vercel** | Hosts the serverless functions, auto-deploys on push | Vercel project link + GitHub |
| **Upstash (Redis)** | KV registry — source of truth for "which keys are valid, on which devices, revoked or not" | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| **Resend** | Delivers licence emails | `RESEND_API_KEY` |

All secrets live in Vercel's environment variables for deploy; `.env.production`
locally for admin-script use. `.env.production` is gitignored.

---

## Data flow — purchase

```
Customer                  Paddle              Vercel / aethelgard-licensing                Resend
    │                        │                            │                                  │
    │ checkout               │                            │                                  │
    ├───────────────────────▶│                            │                                  │
    │                        │ transaction.completed      │                                  │
    │                        ├───────────────────────────▶│                                  │
    │                        │   (HMAC-signed webhook)    │                                  │
    │                        │                            │ verify signature                 │
    │                        │                            │ resolve tier from price_id       │
    │                        │                            │ generate key (keygen.ts)         │
    │                        │                            │ KV: SET key:<hash> KeyRecord     │
    │                        │                            │ KV: SET tx:<tx_id> <hash>        │
    │                        │                            │ send email ──────────────────────▶
    │                        │                            │                                  │ deliver
    │ licence key in inbox ◀─────────────────────────────────────────────────────────────────┤
```

Key format: `AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX` (24 Crockford Base32 chars,
15 bytes: tier + expiry + customer_id + HMAC-SHA256 with the master secret).
See [`activation-system.md`](activation-system.md) for the byte-level detail.

---

## Data flow — activation

```
Aethelgard client                                                aethelgard-licensing
       │                                                                  │
       │ user enters key                                                  │
       │                                                                  │
       │ license::validate(key)  ← HMAC check locally, offline            │
       │                                                                  │
       │ fingerprint::compute()  ← SHA-256(MachineGuid / IOPlatformUUID)  │
       │                                                                  │
       │ POST /api/activate { key, fingerprint, device_name }             │
       ├─────────────────────────────────────────────────────────────────▶│
       │                                                                  │ hash key
       │                                                                  │ KV: GET key:<hash>
       │                                                                  │ if revoked → 403
       │                                                                  │ if fingerprint already in devices[] → existing:true
       │                                                                  │ if devices.length == limit → 409 limit_reached
       │                                                                  │ else append + KV: SET → 200 activated
       │ ◀────────────────────────────────────────────────────────────────┤
       │ on success: license::store(profile_dir, key)                     │
       │             set_setting("license_customer_email", email)         │
       │             tier_state.update(key, is_trial=false)               │
       │                                                                  │
       │ on limit_reached: LimitReachedModal (device list, mailto)        │
       │ on revoked:       red error + support address                    │
       │ on network_error: red error, key NOT persisted                   │
```

Failure mode: **first activation requires internet**. This is the one place
in the system where the client fails closed — not open. Rationale:
reliably enforcing the device cap requires a registration write.

---

## Data flow — revocation (24h loop)

```
Aethelgard (at startup, once per 24h)                     aethelgard-licensing
       │                                                           │
       │ skip if last_license_verify was < 24h ago ─┐              │
       │                                             │              │
       │ GET /api/verify?key=<key>&fingerprint=<fp>◀─┘              │
       ├──────────────────────────────────────────────────────────▶│
       │                                                           │ KV: GET key:<hash>
       │                                                           │ if !record → { valid: true, registered: false }
       │                                                           │ if revoked → { valid: false, reason: "refunded" }
       │                                                           │ else: update devices[].last_seen_at for matching fingerprint
       │                                                           │       return { valid: true, customer_email: "..." }
       │ ◀─────────────────────────────────────────────────────────┤
       │ Revoked   → license::clear(), tier downgrades to trial/basic
       │ Valid     → set_setting("license_customer_email", email)
       │ Network error / non-2xx → "Unreachable" → proceed normally
```

Verify fails **open** on any network error — offline or server-down never
blocks legitimate users. Revocation takes up to 24 hours to propagate to
any given install; on a machine that stays offline, revocation effectively
never applies. This is an accepted trade-off: this system is designed for
casual sharing deterrence, not for DRM-grade piracy prevention.

---

## Data flow — refund

```
Customer         Paddle                       Vercel                             KV
    │               │                           │                                 │
    │ refund        │                           │                                 │
    ├──────────────▶│                           │                                 │
    │               │ adjustment.created        │                                 │
    │               │   (action=refund,         │                                 │
    │               │    status=approved)       │                                 │
    │               ├─────────────────────────▶ │                                 │
    │               │                           │ verify sig                      │
    │               │                           │ GET tx:<tx_id> → <key_hash[]>   │
    │               │                           │                                 │
    │               │                           │ for each hash:                  │
    │               │                           │   GET key:<hash>                │
    │               │                           │   SET key:<hash> {..., revoked:true}
    │               │                           │ ◀──────────────────────────────▶│
```

Within 24 hours of this write, every active install of the key sees
`valid:false` on their next verify check and downgrades.

---

## Data flow — integrity chain reseal

```
Aethelgard client                                        (local SQLite only)
       │
       │ user enters PIN in ResealModal
       │ verifyPin(pin, localStorage[pin_hash])
       │
       │ invoke("reseal_integrity_chain") → Rust side
       │   get_binding_status() → license_email, bound_email
       │   reseal_all_entities_with_progress(pool, new_email, emit_progress):
       │     ── preflight: verify current chain per entity; refuse if broken
       │     ── COUNT(*) transactions for accurate progress total
       │     ── per entity, in one DB txn:
       │        ── SELECT rows ordered by journal_number
       │        ── compute v2 hash including SHA-256(new_email)
       │        ── UPDATE transactions SET chain_hash=?, hash_version=2
       │        ── INSERT integrity_reseal_log row
       │     ── set_setting("integrity_chain_bound_email", new_email)
       │
       │ progress events flow back to ResealModal
       │ on success: close modal, toast, refresh binding status
```

Strictly local — no server involvement. The reseal proves chain-of-custody
under a specific email but does not require network.

---

## Security model — summary

| Layer | What it proves / prevents | Failure mode |
|---|---|---|
| HMAC key validation | Key was issued by us (binds tier + expiry + customer_id) | Fails closed — bad keys rejected offline |
| Machine fingerprint | This machine is uniquely identified (no raw ID transmitted — only SHA-256) | Gracefully degrades if `machine-uid` read fails |
| Activation device cap | Same licence can't be freely shared beyond 3 devices (1 per bundle key) | Fails closed on 4th device; fails closed on first activation without network |
| 24-hour revocation check | Refunds and manual revocations take effect within a day | **Fails open** — offline or server-down never blocks legitimate users |
| Integrity hash chain (v1) | Vault data has not been tampered with since write | Surfaced in Dashboard and `get_ledger_health` |
| Integrity chain email binding (v2, reseal) | Vault's chain-of-custody cryptographically names the licensee | Fully local; no network dependency once enabled |

---

## Common failure modes and handling

| What breaks | User-visible effect | Operator action |
|---|---|---|
| Paddle webhook can't reach us | Customer pays, doesn't get key | Paddle retries for 24h with exponential backoff. If still failing, manually re-fire from the Paddle dashboard, or use `simulate-webhook.mjs` with the correct tx_id + price_id. |
| Resend delivery fails | KV record written, no email sent | Idempotent webhook: on retry, the handler detects existing `tx:<id>` and re-sends the email with the original key. |
| Upstash is down | Activation fails (fails closed); verify fails open | Wait it out. Upstash SLA is high; manual customer support can re-activate once service restores. |
| App hits `/api/activate` during Vercel deploy | Rare race — function returns 500 briefly | Client treats as `NetworkError`; retry works. |
| Customer OS reinstall changes fingerprint | Their existing activation becomes "orphan" in KV until rotated out | They email support, we run `deactivate.mjs` on the old fingerprint; they re-activate on the reinstalled OS. |

---

## Where to look first when something's wrong

| Symptom | First place to look |
|---|---|
| Customer paid, no email | Vercel function logs (paddle-webhook), Resend dashboard |
| Customer paid, got email, activation fails | Vercel function logs (activate), KV key record state |
| App reports revoked but customer says they didn't refund | KV key record's `revoked` field + `tx:<id>` to find the transaction |
| Integrity dashboard says chain broken | SQLite vault on customer's machine — support them through playbook #7 |
| `npm audit` failing CI | Licensing repo `npm audit` or app repo `npm audit`; see `package.json` overrides |

---

## Cross-references

- Admin scripts: [`admin-scripts.md`](admin-scripts.md)
- Activation details (key format, fingerprint, error paths): [`activation-system.md`](activation-system.md)
- Integrity chain + reseal: [`integrity-chain-email.md`](integrity-chain-email.md)
- Support playbooks: [`support-playbooks.md`](support-playbooks.md)
- Pre-launch runbook: [`e2e-runbook.md`](e2e-runbook.md)
