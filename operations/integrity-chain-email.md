# Integrity Chain & Customer Email — Design and Operator Guidance

**Status:** Implemented across Phase 5a (versioned hash), 5b (reseal
operation + Tauri commands), and 5c (UI trigger in Vault Settings). Phase 5d
(Integrity Dashboard display) and 5f (hardening) remain outstanding — see
"Implementation notes" at the bottom.
**Last updated:** 2026-04-24
**Audience:** Cherie / future support / maintainers

---

## Purpose of this document

This is the authoritative reference for how customer email is bound to the
cryptographic integrity chain in Aethelgard, and how to handle the operational
edge cases that arise from that binding — most importantly, what happens when
a customer legitimately needs to change their email.

Everything about the reseal operation, the reasoning behind it, and the
boundaries of what we will and will not do operationally is here. If a support
question is not answered by this document, the first fix is to update the
document, not to invent an answer.

---

## Background: the integrity chain

Aethelgard's Integrity Dashboard is a cryptographic tamper-detection feature
built on a journal-entry hash chain. Each journal entry's integrity hash is
computed from the previous entry's hash plus the entry's own contents. Alter
any entry in history and every subsequent hash changes — the dashboard surfaces
it immediately.

This is one of the product's defining features. It is what lets a user (or
their auditor) prove, cryptographically, that the vault has not been
retroactively altered.

---

## The binding: customer email in the hash input

For every transaction, the chain-hash input for v2 rows includes
`"EMAIL:" + SHA-256(customer_email)`, where `customer_email` is the email the
licence was issued to (captured at first activation, refreshed on every
24-hour verify, and pinned into the vault when the user resealed). The
`"EMAIL:"` prefix is a domain separator — it prevents collision with the
trailing bytes of a prior journal entry's `credit` field.

This has three consequences:

1. The vault's integrity proof is cryptographically tied to the licensed party.
2. The licensed party is visible to any auditor or support operator who reads
   the chain state or the `integrity_reseal_log` table.
3. A vault created under licence A cannot be claimed as "originated by" a
   different party without a documented, visible re-sealing operation.

### Algorithm versioning

Every row of the `transactions` table carries a `hash_version` column. v1 is
the pre-Phase-5a algorithm (no email binding — byte-identical to the original
implementation); v2 is the email-bound algorithm. A row is only tagged v2
after a successful reseal. All existing rows stay on v1 until the user runs
reseal, so upgrading to the new binary causes no silent chain rewrites.

### What the user sees

Today (Phase 5c): the bound email is shown in the Licence section of
**Vault Settings** as "Chain originated by: `cherie@2bc.com` ✓" under the
licence status. When the licence email diverges from the bound email, an
amber callout prompts the user to reseal.

Phase 5d (outstanding) will surface the same line in the **Integrity
Dashboard** itself so auditors reading the dashboard see the chain origin
alongside the tamper-check result.

The email is canonical — the string is part of the cryptographic record,
not a display label. It cannot be edited or hidden without breaking the chain.

### Why email and not the licence key itself

The licence key changes on legitimate upgrades (renewal, tier change, Paddle
reissue after a support request). If the licence key were part of the hash
input, every such upgrade would silently break integrity — the exact
reliability failure we are trying to avoid. The customer email, by contrast,
is stable across the lifetime of a Paddle customer record. It is the right
binding.

---

## The reseal operation

When the bound email needs to change legitimately — the customer has moved
from a personal email to a company email on their Paddle account, or some
similar reason — the vault must be **resealed**: the entire hash chain is
re-computed under the new email, and a visible record of the reseal is
written into the vault's integrity history.

### When reseal is needed

- Customer's Paddle account email has changed and they have re-activated with
  a newly issued key under that new email.
- Customer voluntarily wants to migrate their vault to a new email (e.g.
  after incorporating a business).

It is **not** needed when the customer renews at the same email, changes tier,
or replaces a device — none of those change the bound email.

### Prerequisites

- The vault is currently unlocked (the user knows their PIN).
- A licence email is on record — the customer has activated a registered
  paid licence via `/api/activate`. Trial / beta / unregistered licences
  cannot reseal because there is no canonical email to bind to.
- The integrity chain currently verifies cleanly under the email it is
  already bound to (or under v1 for a never-resealed vault). The chain is
  not already broken for some other reason.

If any of these fail, reseal is refused. This is deliberate: silent reseal of
a broken chain would let tampering hide behind a legitimate-looking operation.
The user must resolve the underlying issue first.

### What reseal does

1. Preflight: verifies every entity's chain under its current binding. Any
   verification failure aborts the operation — no state is mutated.
2. For each entity (in one DB transaction per entity):
   a. Recomputes the chain_hash of every transaction under v2 with the
      target `customer_email`.
   b. Writes each row's new `chain_hash` and sets `hash_version = 2`.
   c. Inserts one row into `integrity_reseal_log`:
      - `id`, `entity_id`, `performed_at` (ISO 8601 UTC)
      - `old_version`, `new_version`
      - `old_email` (NULL for first-time reseal from v1), `new_email`
      - `tx_count`, `final_chain_hash`
3. After all entities succeed, updates the `integrity_chain_bound_email`
   app setting so subsequent `verify_ledger_integrity` calls use the new
   email. If any entity fails, the setting is left untouched and no reseal
   log rows from that call persist (per-entity transactions either commit
   or roll back atomically).

The reseal log is append-only by convention — there is no DELETE path in
application code. Every reseal event leaves a permanent audit row.

**What is not recorded:** the PIN used to authorise the reseal. PIN
verification happens on the frontend (see `src/utils/hashPin.ts`); the
Rust side trusts that an in-app request implies an unlocked vault. The
chain-of-custody guarantee comes from the hash binding and the audit log
row, not from storing a PIN digest.

### Visible markers after reseal

Today (Phase 5c): the Licence section of Vault Settings shows the new
binding inline:

```
Chain originated by: new-email@example.com   ✓
```

Phase 5d will extend the Integrity Dashboard to show the same information
plus the reseal history read from `integrity_reseal_log`:

```
Chain originated by: new-email@example.com
Resealed 2027-03-12 from cherie@2bc.com
847 entries · 0 broken · last verified 2027-03-12
```

The reseal log itself is permanent regardless of whether the dashboard
surfaces it — readable via SQL or a future `scripts/lookup-reseal.mjs`
admin tool.

### Actual user flow (as shipped in Phase 5c)

1. In Vault Settings → Licence section, when `license_email` is present
   AND differs from `integrity_chain_bound_email` (or the chain has never
   been bound), an amber callout appears.
2. Callout copy:
   - First-time binding: *"Integrity chain not yet bound — Bind your
     integrity chain cryptographically to `<email>`. This makes your
     vault's tamper-proof record provably yours."*
   - Email change: *"Integrity chain needs resealing — Chain currently
     originates from `<old>`. Your licence is issued to a different email
     — reseal to rebind under your current licence."*
3. User clicks the action link ("Enable integrity binding" or "Reseal
   chain under new email").
4. Modal opens. Warning copy (verbatim for email-change case):

   > Rebind your integrity chain from `<old email>` to `<new email>`.
   > The old email and the timestamp of this reseal remain permanently
   > visible in your Integrity Dashboard.
   >
   > Your vault must be intact — reseal will refuse if any existing
   > entry has been tampered with.

5. User enters their vault PIN. The frontend verifies it locally against
   the stored PIN hash via `verifyPin` from `utils/hashPin.ts`.
6. On success, the frontend calls the `reseal_integrity_chain` Tauri
   command. The backend runs the preflight + rehash + log insert.
7. Confirmation toast: *"Chain resealed: N transactions bound to
   `<email>`."* The callout disappears and the green "Chain originated
   by: `<email>` ✓" state takes over.

No progress indicator is shown today — reseal of a typical vault is
sub-second, and large-vault progress reporting is tracked as Phase 5f
hardening work. Users of vaults with tens of thousands of transactions
may see a longer spinner; the modal blocks backdrop-dismissal while
resealing so users can't accidentally navigate away.

---

## Support scenarios

### "My integrity chain says it's bound to the wrong email after my licence changed"

Most likely cause: the customer's Paddle email changed (either on renewal,
through Paddle support, or via a key re-issue), the app's 24-hour verify
loop has picked up the new email and stored it as `license_customer_email`,
but the customer has not yet triggered a reseal.

What the app shows in this state: an amber callout in the Vault Settings
Licence section reading *"Integrity chain needs resealing — Chain
currently originates from `<old email>`. Your licence is issued to a
different email — reseal to rebind under your current licence."*

Steps:
1. Confirm the current licence's email via the KV registry (use the
   forthcoming `scripts/lookup-key.mjs` — or check KV directly on the
   Upstash console).
2. Direct them to open the app, go to **Vault Settings → Licence
   section**, and click **"Reseal chain under new email"**. They'll need
   their vault PIN.
3. If no callout appears despite the licence email having changed,
   gather details (output of `get_integrity_binding_status`, stored
   `license_customer_email` vs `integrity_chain_bound_email` settings)
   and open a bug — this is a bug in the detection logic, not a user
   error.

### "I want to change my Aethelgard licence email"

Standard flow:
1. Customer changes their email on Paddle (for customers on the advisor bundle
   or for edge cases, support changes it on our end).
2. Paddle issues a new key under the new email via the existing
   `transaction.completed` webhook path — no special handling needed on our side.
3. Customer enters the new key in Aethelgard (Vault Settings → Licence →
   Activate a license key). The app activates the new key, the next
   24-hour verify updates `license_customer_email`, and the reseal
   callout appears.
4. Customer clicks **"Reseal chain under new email"** and enters their
   vault PIN. The chain is rebound; the old email is preserved in the
   `integrity_reseal_log` audit table for chain-of-custody.

### "I don't want to reseal — can I keep the old email in my chain?"

Yes. Reseal is optional. The vault continues to work normally. The Integrity
Dashboard will show the old email as the chain origin, which may confuse an
auditor or look inconsistent to the customer themselves. If they understand
that and prefer it, leave it alone.

### "I forgot my PIN and need to reseal"

Reseal requires the PIN. Without it, the vault cannot be resealed. The
customer must recover their PIN via the app's existing PIN recovery flow (if
they have a recovery key) before reseal becomes possible. There is no support
override — introducing one would defeat the integrity guarantee.

### "Can I remove my email from the chain entirely?"

No. The chain always has an origin email. Resealing under a placeholder
("Anonymous User") would strip the integrity claim of its meaning — the whole
point is that the signature is provably someone's.

### "Someone leaked my licence key online — what can I do?"

1. Revoke the old key via the admin process — flip `revoked: true` in the KV
   record for that key. (Will be automated by `scripts/revoke.mjs` — currently
   manual through the KV console.)
2. Issue a replacement key under the same email via Paddle support tools.
3. The customer re-activates with the new key. Because the bound email is
   unchanged, no reseal is needed — the chain continues uninterrupted.
4. All other active installs of the old key see `valid: false` on their next
   24-hour verify check and downgrade.

---

## Things not to do

- **Never silently migrate hashes when the email changes.** The reseal must
  always be an explicit, PIN-gated, visibly recorded operation. Silent
  migration would hide tampering behind a plausible-looking event.
- **Never allow reseal without a currently valid integrity check.** Resealing
  a broken chain is how fraud would be covered up.
- **Never store the bound email in more than one canonical place.** There is
  one source — the value captured at activation and written into the vault's
  integrity-chain seed. Display copies elsewhere (About screen, etc.) read
  from that source; they do not maintain their own.
- **Never expose reseal as a casual settings toggle.** It is deliberate and
  infrequent. UX must reflect that.
- **Never accept a reseal request over email / phone / chat** without the
  user performing it themselves in the app. Support does not reseal vaults
  on customers' behalf under any circumstances — that would make support a
  trusted party in the integrity chain, which they are not.

---

## Future considerations

Items noted here for later — not part of v1.

- **Export of integrity proof as a standalone PDF** — an auditor's report
  showing chain origin, reseal history, total entry count, and verification
  status. Would make the feature more useful in professional settings.
- **Delegated integrity verification** — a mechanism for an accountant to
  verify a client's chain without opening the vault (possibly via a signed
  proof export). Needs careful privacy design.
- **Multi-party chains** (a firm with shared vault access, multiple licensed
  parties) — entirely out of scope for current product. Likely a future
  "Firm" tier.
- **Reseal audit trail export** — a built-in or admin tool that reads
  `integrity_reseal_log` and produces a human-readable PDF of every
  reseal event on a vault, for compliance purposes.

---

## Implementation notes (as of 2026-04-24)

### What has shipped
- **Phase 5a** (`feat: phase 5a`) — versioned hash-chain algorithm, v1 output
  byte-identical to the pre-refactor implementation, `hash_version` column on
  `transactions`, unit-tested against a pinned reference vector.
- **Phase 5b** (`feat: phase 5b`) — reseal backend. `reseal_all_entities`,
  `reseal_entity`, `get_binding_status` in `db/integrity.rs`. `integrity_reseal_log`
  table (migration v12). Tauri commands `reseal_integrity_chain` and
  `get_integrity_binding_status`. Five integration tests covering happy path,
  email change, broken-chain refusal, empty-email rejection, and status
  progression.
- **Phase 5c** (`feat: phase 5c`) — UI trigger. `ResealModal` component in
  `VaultSettings.tsx`, inline callout with three states (bound+matches,
  bound+diverged, unbound+licensed). PIN verification via existing
  `verifyPin`/localStorage pattern.

### What is outstanding
- **Phase 5d** — Integrity Dashboard surfacing of "Chain originated by:
  email" plus a reseal-history view reading from `integrity_reseal_log`.
  Today the bound email is only visible in Vault Settings.
- **Phase 5f** — hardening: large-vault progress reporting, mid-reseal
  cancellation handling, fuzz testing on odd vault shapes (empty, single
  entity, thousands of entities, deleted-then-re-added transactions).

### What was specified here but not built
- **PIN hash recorded in the reseal log.** The original design proposed
  storing a hash of the PIN alongside each reseal event for later
  non-repudiation. This was dropped during implementation — PIN
  verification happens frontend-side via `verifyPin` (existing pattern
  throughout the app) and no digest reaches the Rust side. The
  chain-of-custody guarantee comes from the hash binding and the audit
  log row, not from a stored PIN digest. If non-repudiation ever becomes
  a hard requirement (e.g. for regulated advisory use), add a
  `pin_hash` column to `integrity_reseal_log` and capture it through an
  explicit Tauri argument.
- **Reseal as a dedicated "Change licence email" menu item.** The design
  proposed this as a separate settings entry; the shipped UX integrates
  the trigger into the existing Licence section as an inline callout,
  which matches the natural point of attention when the user sees their
  licence details.

---

## Cross-references

- Activation lifecycle, device limits, fingerprint model: `activation-system.md` (pending)
- Admin scripts: [`admin-scripts.md`](admin-scripts.md)
- Support response templates: `support-playbooks.md` (pending)
- User-facing explainer for customers: [`user-guides/key-sharing-and-you.md`](user-guides/key-sharing-and-you.md)
