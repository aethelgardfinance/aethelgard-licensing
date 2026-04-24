# Integrity Chain & Customer Email — Design and Operator Guidance

**Status:** Design specification — not yet implemented. Authoritative reference
once the Phase 5 build lands.
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

On every journal entry, the integrity hash input includes
`SHA-256(customer_email)`, where `customer_email` is the email the licence was
issued to (captured at first activation and pinned into the vault). This has
three consequences:

1. The vault's integrity proof is cryptographically tied to the licensed party.
2. The licensed party is visible in the Integrity Dashboard — not as cosmetic
   text, but as part of the proof itself.
3. A vault created under licence A cannot be claimed as "originated by" a
   different party without a documented, visible re-sealing operation.

### What the user sees in the Integrity Dashboard

```
Integrity verified
Chain originated by: cherie@2bc.com
847 entries · 0 broken · last verified 2026-04-24
```

The email is canonical. It cannot be edited or hidden without breaking the
chain.

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
- The customer is authenticated with the new licence, bound to the new email,
  served by the activation endpoint.
- The integrity chain currently verifies cleanly under the old email — i.e.
  the vault is not already broken for some other reason.

If any of these fail, reseal is refused. This is deliberate: silent reseal of
a broken chain would let tampering hide behind a legitimate-looking operation.
The user must resolve the underlying issue first.

### What reseal does

1. Verifies the chain under the old email one final time. If this fails, abort.
2. Computes new hashes for every journal entry under the new email.
3. Writes a new **system journal entry** recording the reseal event:
   - Old email
   - New email
   - Timestamp (UTC)
   - A hash of the PIN that approved the reseal (for later non-repudiation)
4. This reseal entry is itself hashed into the chain under the new email.

### Visible markers after reseal

```
Chain originated by: new-email@example.com
Resealed 2027-03-12 from cherie@2bc.com
847 entries · 0 broken · last verified 2027-03-12
```

The reseal marker is permanent. It is part of the chain-of-custody, not
metadata — it cannot be removed without breaking the chain.

### User flow (proposed — finalise during Phase 5)

1. `Settings → Licence → Change licence email`
2. App detects the email change (by comparing current vault-bound email to the
   email returned by the activation endpoint for the current key), offers a
   reseal.
3. Warning dialog, verbatim copy:

   > Your integrity chain will be permanently resealed under the new email.
   > The old email and this operation's timestamp will remain visible in
   > your Integrity Dashboard as part of your chain-of-custody. Your PIN
   > is required to proceed.

4. User enters PIN.
5. Reseal runs. Progress indicator for large vaults (>5,000 entries).
6. Confirmation: "Vault resealed. Integrity Dashboard updated."

---

## Support scenarios

### "My Integrity Dashboard says the chain is broken after my licence changed"

Most likely cause: the customer's Paddle email changed, and their vault was
locked and reopened with a new key bound to the new email, without the reseal
flow having been triggered.

Steps:
1. Confirm the current licence's email via the KV registry (use the forthcoming
   `scripts/lookup-key.mjs` — or check KV directly on the Upstash console).
2. Direct them to `Settings → Licence → Change licence email` to trigger reseal.
3. If the app did not offer a reseal prompt automatically, gather details and
   open a bug — this is a bug in the detection logic, not a user error.

### "I want to change my Aethelgard licence email"

Standard flow:
1. Customer changes their email on Paddle (for customers on the advisor bundle
   or for edge cases, support changes it on our end).
2. Paddle issues a new key under the new email via the existing
   `transaction.completed` webhook path — no special handling needed on our side.
3. Customer opens Aethelgard, enters the new key when prompted. The app
   detects the email change and offers reseal.

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
- **Reseal audit trail export** — listing all reseals that have ever been
  performed on a vault, for auditability. Today this is available only by
  reading the journal chain entries directly.

---

## Cross-references

- Activation lifecycle, device limits, fingerprint model: `activation-system.md` (pending)
- Admin scripts: `admin-scripts.md` (pending)
- Support response templates: `support-playbooks.md` (pending)
- User-facing explainer for customers: `user-guides/key-sharing-and-you.md`
