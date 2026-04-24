# Changing the Email on Your Licence

If the email your Aethelgard licence is issued to needs to change —
because you've moved from personal to business email, or incorporated
and changed domains, or just want to consolidate addresses — this is
fully supported. This guide walks through what happens and what you
need to do.

If you haven't yet enabled integrity binding, changing your email is
almost trivial: update on Paddle, use the new key. Skip to
[Without integrity binding](#without-integrity-binding).

If you **have** enabled integrity binding, there's one extra step —
the **reseal** — which re-binds your vault's cryptographic chain of
custody to the new email. This is a deliberate, visible, permanently
recorded operation. Read on.

---

## With integrity binding: the reseal

### Step 1 — change your email on Paddle

Update your email in your Paddle customer settings, or ask us to do
it for you. Paddle will issue a new licence key under the new email.

### Step 2 — enter the new key in Aethelgard

Open the app, go to **Vault Settings → Licence → Activate a licence
key**. Paste the new key, click Activate.

(If Paddle re-issued the same key string to the new email — which
happens sometimes — you can skip this step. The 24-hour check will
pick up the new email automatically.)

### Step 3 — wait up to 24 hours, or relaunch

Aethelgard checks in with our server once per 24 hours to refresh
your licence status. Within that window, it picks up the new email
and stores it locally. You can force this by fully quitting and
relaunching the app.

### Step 4 — reseal when the app prompts you

When Aethelgard sees that your licensed email has changed but your
chain is still bound to the old one, it shows an amber callout in
**Vault Settings → Licence**:

> **Integrity chain needs resealing** — Chain currently originates
> from old@example.com. Your licence is issued to a different email —
> reseal to rebind under your current licence.

Click **Reseal chain under new email**. A dialog appears:

> Rebind your integrity chain from `old@example.com` to
> `new@example.com`. The old email and the timestamp of this reseal
> remain permanently visible in your Integrity Dashboard.
>
> Your vault must be intact — reseal will refuse if any existing
> entry has been tampered with.

Enter your vault PIN. Click **Reseal chain**.

### Step 5 — verification

For small vaults, this takes less than a second. For larger vaults
(tens of thousands of transactions) you'll see a progress bar
counting up. Once complete, Aethelgard confirms:

> Chain resealed: N transactions bound to new@example.com.

The Vault Settings callout disappears and the Dashboard's "Chain of
Custody" panel now shows the new email.

---

## What's preserved after reseal

Your chain-of-custody is **not** rewritten in a way that hides history.
Instead:

- Every existing transaction's cryptographic signature is updated so
  it now includes the new email.
- A permanent record of the reseal — old email, new email, timestamp —
  is written into an audit table that only grows. No-one (including
  us) can remove these entries.
- Future integrity exports will show both the current bound email
  *and* the full history of reseals.

So if an auditor ever asks "why does this vault show records before
your current email was issued?", you can point to the reseal audit
trail as the answer. The chain is continuous; the email history is
visible.

---

## Without integrity binding

If you never enabled integrity binding, changing your email is
straightforward:

1. Update email on Paddle (or ask us to).
2. Enter the new key in **Vault Settings → Licence** if Aethelgard
   prompts you.
3. Done. No reseal needed because your chain isn't bound to an email
   in the first place.

If you later decide to enable integrity binding, it will bind to
whatever licence email is active at that moment — not to any email
you used in the past.

---

## What could go wrong

- **The reseal refuses to run with a "chain is broken" error.** This
  means Aethelgard has detected that your existing chain fails
  verification — some transaction's stored hash doesn't match the
  recomputed value. We deliberately refuse to reseal a broken chain
  because it would paper over any tampering. Email support with a
  screenshot of your Integrity Dashboard and we'll help investigate.
- **"No licence email on record."** You're on a trial or unregistered
  key. Activate a paid licence first, then reseal once it's on record.
- **You forgot your vault PIN.** The reseal requires the PIN — we
  cannot override this, because the whole point of the integrity chain
  is that it can't be silently rewritten. If you have a recovery key
  set, use it to reset the PIN (**Vault Settings → Reset Access
  Code**). Otherwise the chain stays bound to the old email.

---

## How often can I reseal?

As often as needed. The reseal log is append-only — every reseal adds
one audit row — but there's no technical limit. In practice, most
customers will reseal exactly zero or one times over the life of their
vault.

---

## Questions

- *"Will my transaction data change in any way?"* No. Reseal only
  recomputes the integrity hashes — your actual journal entries,
  amounts, dates, and descriptions are untouched.
- *"Can I reseal without enabling integrity binding first?"* No —
  reseal *is* how you enable binding the first time, and how you
  update it subsequently.
- *"What if I just want to remove the email from my chain entirely?"*
  We don't support this. The chain always has an origin email — the
  whole point of the signature is that it's provably someone's. See
  [`your-licence-email.md`](your-licence-email.md) if you want to
  understand why we design it this way.

Questions or unusual situations: `contact@aethelgard.finance`.
