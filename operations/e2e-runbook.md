# End-to-End Verification Runbook

**Audience:** Cherie (pre-launch) and any future tester verifying the licence
lifecycle before a release.
**Last updated:** 2026-04-24
**Status:** Usable today. Execute against a Paddle sandbox environment
before every public release; the full run takes ~45 minutes once set up.

This runbook proves that the licence lifecycle works end-to-end from a
real Paddle transaction through to the Aethelgard app's integrity chain.
Some steps use `scripts/simulate-webhook.mjs` to avoid needing a sandbox
purchase for every rerun; others require a real sandbox transaction
because only that exercises the Paddle → webhook signature path with
authentic signing.

---

## Prerequisites

- A Paddle sandbox account with the same product catalogue as production.
- Sandbox API key and webhook secret set in a `.env.sandbox` file in the
  licensing repo.
- A test email address you control (for the purchase email).
- Upstash REST credentials in `.env.production` (or `.env.sandbox` if you
  keep sandbox KV separate) — needed for `scripts/deactivate.mjs`.
- A fresh Aethelgard install on the target OS (or a throwaway profile,
  so device-cap tests don't collide with your real vault).

For each run, note the **run sheet** header at the bottom of this file
as a checklist.

---

## Flow overview

```
(1) Sandbox purchase ──► webhook ──► Resend email ──► KV record (v1)
                                                          │
(2) Activate in Aethelgard ──► /api/activate ──► KV devices[] grows ──► app persists licence
                                                          │
(3) Second device ──► devices[] = 2
                                                          │
(4) Third device ──► devices[] = 3 (cap)
                                                          │
(5) Fourth device ──► 409 limit_reached ──► LimitReachedModal in app
                                                          │
(6) scripts/deactivate.mjs ──► devices[] = 2 ──► fourth device activates
                                                          │
(7) Enable integrity binding in app ──► reseal ──► chain bound to licence email
                                                          │
(8) Sandbox refund ──► adjustment.created webhook ──► KV revoked = true
                                                          │
(9) App's 24h verify fires ──► valid: false ──► app downgrades to trial
```

Steps 1 and 8 must be done via real sandbox actions. Steps 2–7 use real
app installs; deactivation uses the admin script; webhooks in steps 1
and 8 can be substituted with `simulate-webhook.mjs` when retrying a
specific scenario without a fresh Paddle transaction.

---

## Step 1: Sandbox purchase

**Goal:** confirm the webhook fires, signature verifies, key is
generated, email is delivered, KV record is written.

1. In the Paddle sandbox dashboard, use the inline checkout to buy one
   Advanced Lifetime licence at your test email.
2. Within ~30 seconds, check:
   - **Resend dashboard:** a new successful delivery to the test email,
     subject contains "Aethelgard".
   - **Test email inbox:** the licence email arrived, contains a key
     shaped `AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX`.
   - **Upstash console:** `key:<sha256_hex>` exists with
     `revoked:false`, `device_limit:3`, `devices:[]`.
3. Note the transaction ID (shown in the Paddle dashboard) — you need it
   for the refund step.

**If the webhook fails:** check Vercel function logs. Common causes:
clock skew (signature age validation), missing `PADDLE_WEBHOOK_SECRET`,
or Resend rate-limit.

**Shortcut for re-runs** (when you've already proved signature works):

```bash
set -a; . ./.env.sandbox; set +a
node scripts/simulate-webhook.mjs purchase advanced --lifetime \
    --email=<your test email> --send
```

The simulator uses the same signing logic Paddle uses, so it exercises
the full endpoint path. Keep at least **one real sandbox purchase per
release** — simulator-only runs don't prove Paddle's own signature
format hasn't drifted.

---

## Step 2: First-device activation

**Goal:** prove the app accepts the key, fingerprint registers in KV,
licensed email is picked up.

1. On your first test machine, open Aethelgard.
2. Navigate to **Vault Settings → Licence**. Paste the key from the
   email, click **Activate**.
3. Expect:
   - Toast: *"License activated successfully."*
   - Tier badge changes to **Advanced**.
   - Inline: *"Licensed to: `<email>`"* and *"1 of 3 devices active"*.
4. Back in Upstash: `key:<hash>` now has one entry in `devices[]` with
   the machine's fingerprint (hex), `device_name` (usually your
   hostname), `activated_at`, `last_seen_at`.

**If activation fails:**
- `NetworkError`: Aethelgard cannot reach `/api/activate`. Check the
  machine's internet. For offline-first testing, the app should allow
  re-entering the key later (the key isn't persisted on failure).
- `LimitReached`: the key already has 3 devices from a previous run.
  Use `scripts/deactivate.mjs` to clean up first (see Step 6).

---

## Step 3: Second-device activation

**Goal:** confirm the cap accumulates, licensed email displays correctly
on a different machine.

1. On a **different** machine (or a throwaway user account on the same
   machine — different machine-uid), repeat Step 2 with the same key.
2. Expect: *"2 of 3 devices active"*, the new machine in `devices[]`.
3. On the **first** machine, close and reopen Aethelgard. Navigate back
   to Vault Settings. The count should update to *"2 of 3"* on the next
   24-hour verify — but it does *not* refresh in real time on the
   first machine until then. (That's a known design trade-off: verify
   is rate-limited to once per 24 hours; only the activation call
   updates the count immediately.)

---

## Step 4: Third-device activation

Repeat Step 3 from yet another machine. `devices[]` = 3.

---

## Step 5: Fourth-device attempt — the cap

**Goal:** verify the limit-reached UX renders correctly.

1. On a fourth machine, attempt activation.
2. Expect the **LimitReachedModal**:
   - Heading: *"Device limit reached"*.
   - List of the three currently-active devices with names + activated
     / last-seen dates. **No fingerprints shown** to the user — the
     server scrubs them.
   - *"Email support"* button that opens a pre-filled mailto to
     `contact@aethelgard.finance` with the licence key embedded.
3. Cancel the modal, relaunch the app. The licence key was **not**
   persisted on the fourth machine (confirm: Vault Settings shows the
   trial tier, no "Licensed to" line).

---

## Step 6: Admin deactivation

**Goal:** prove the operator path for freeing a slot works.

```bash
set -a; . ./.env.production; set +a   # or .env.sandbox — wherever the key lives
node scripts/deactivate.mjs AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX
```

Lists the three devices. Pick one to retire (usually index 1 — the
oldest). Preview:

```bash
node scripts/deactivate.mjs AETHG-... 1
```

Apply:

```bash
node scripts/deactivate.mjs AETHG-... 1 --confirm
```

Then retry Step 5's activation on the fourth machine — now succeeds.

---

## Step 7: Integrity binding + reseal

**Goal:** prove the Phase 5 integrity chain lights up end-to-end.

1. On any of the activated machines, create at least two transactions
   in a ledger (any amounts; the content is irrelevant).
2. Navigate to the dashboard. **Do not expect** "Chain of Custody" to
   appear yet — the chain hasn't been bound.
3. Go to **Vault Settings → Licence**. Expect the amber callout:
   *"Integrity chain not yet bound"*.
4. Click **Enable integrity binding**. Modal opens. Enter vault PIN.
5. Expect:
   - Busy state briefly, then close.
   - Toast: *"Chain resealed: 2 transactions bound to `<email>`."*
   - Licence section now shows green *"Chain originated by: `<email>` ✓"*.
6. Return to dashboard. Now the **"Chain of Custody"** panel should
   appear above the Integrity Status, reading *"Chain originated by:
   `<email>`"*.
7. Verify in SQLite directly (optional but proves the database state):
   - `transactions.hash_version` = 2 on every row.
   - `integrity_reseal_log` has one row with `old_version=1`,
     `new_version=2`, `new_email=<your email>`, `tx_count=2`.

**If the chain fails to reseal:**
- Preflight refuses a broken chain. If this happens unexpectedly, the
  vault may already have integrity issues — investigate before
  proceeding.

---

## Step 8: Refund / revocation

**Goal:** prove refunds from Paddle propagate to KV and downgrade the app
within 24 hours.

### Via a real sandbox refund (preferred for releases)

1. In the Paddle sandbox dashboard, issue a refund on the transaction
   from Step 1.
2. Within ~30 seconds, check Upstash: the `key:<hash>` record should
   have `revoked: true`.

### Via the simulator (faster for re-runs)

```bash
set -a; . ./.env.sandbox; set +a
node scripts/simulate-webhook.mjs refund <transaction_id_from_step_1> --send
```

Same result — KV `revoked: true`.

### App-side verification

1. On any of the activated machines, wait for the next 24-hour verify
   check (or force it: delete `last_license_verify` from the app's
   `app_settings` row to force a fresh call on the next relaunch).
2. Relaunch Aethelgard.
3. Expect: the licence is cleared, the app falls back to the trial
   tier (if trial has not expired) or Basic. No data is deleted.
4. The Integrity chain binding is **unaffected** — revocation downgrades
   the app, but the chain stays bound to the (now-revoked) customer
   email. This is deliberate: revoking a leaked key shouldn't destroy
   the customer's historical chain-of-custody.

---

## Per-OS notes

### Windows

- **First launch:** the signed binary is still new — a SmartScreen prompt
  may appear ("Windows protected your PC"). Expected for the first
  ~month after release; SmartScreen's reputation system warms up with
  downloads.
- **Machine-uid source:** `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`.
  Stable across reformats; changes on OS reinstall.
- **Keyring:** SQLCipher key stored in Windows Credential Manager.

### macOS

- **Gatekeeper:** signed and notarised builds pass without warnings.
  Unsigned dev builds require right-click → Open on first launch.
- **Machine-uid source:** `IOPlatformUUID` via `ioreg`. Changes on OS
  reinstall or certain warranty-replacement hardware swaps.
- **Keyring:** Keychain.

### Linux

- **Machine-uid source:** `/etc/machine-id`. Changes on reimage; each
  VM clone gets its own after first boot on most distros.
- **Keyring:** SecretService (gnome-keyring / kwallet) — prompts the
  user for keyring access on first launch in a new session.

---

## What this runbook does *not* cover

- **Load / stress** on the webhook or verify endpoints. Test with
  artificial traffic separately if you expect bursts.
- **Fuzz testing on reseal** (Phase 5f) — odd vault shapes, very large
  vaults, mid-operation cancellation. Currently covered by integration
  tests at small scale only.
- **Cross-version upgrade** — v1.7.6 → v1.7.7 with existing data.
  Should be covered by a separate upgrade runbook once that path
  becomes interesting.
- **Email deliverability** across mailbox providers. Resend's dashboard
  shows per-recipient outcomes; if a tester doesn't receive the key
  email, check Resend logs before assuming the app is broken.

---

## Run sheet — release verification checklist

Copy this block for each release run. Replace values, tick each line.

```
Release:        v1.7.7
Date:           2026-MM-DD
Tester:         Cherie
Environment:    sandbox | production
OS tested:      [ ] Windows  [ ] macOS  [ ] Linux

Step 1  Sandbox purchase → webhook → email → KV      [ ] tx_id: _______________
Step 2  Device 1 activation (primary OS)             [ ]
Step 3  Device 2 activation                           [ ]
Step 4  Device 3 activation                           [ ]
Step 5  Device 4 — limit_reached modal                [ ]
Step 6  deactivate.mjs frees a slot                   [ ]
Step 7  Integrity binding + reseal                    [ ]
Step 8  Refund → KV revoked → app downgrades          [ ]

Notes (regressions, UI oddities, timing issues):
```

Store completed run sheets somewhere durable — they're useful when a
future release ships and the previous run is a year old.

---

## Cross-references

- Admin scripts: [`admin-scripts.md`](admin-scripts.md) — including the
  `simulate-webhook.mjs` and `deactivate.mjs` details referenced above.
- Integrity chain + reseal design: [`integrity-chain-email.md`](integrity-chain-email.md).
- Customer-facing explainer: [`user-guides/key-sharing-and-you.md`](user-guides/key-sharing-and-you.md).
