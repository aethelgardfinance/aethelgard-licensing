# Your Licence, Your Vault, and Sharing

Aethelgard is built for people who take the privacy and integrity of their
financial records seriously. Part of what makes that work is the way your
licence is tied to your vault. This guide explains how — and what it means
for you in practice.

---

## Three devices, one licence

Every Aethelgard licence activates on up to three devices. That's designed to
cover the normal real-world setup — a desktop, a laptop, and one spare —
without needing to ask for help.

If you replace a machine and find yourself at the three-device limit, email
`contact@aethelgard.finance` with your licence key and tell us which device you're
retiring. We'll free up the slot, and you can activate your new machine
straight away.

---

## Your licence is tied to you, not just a device

When you first activate Aethelgard, the email your licence was issued to
becomes part of your vault's **integrity signature** — the cryptographic proof
that your data hasn't been tampered with. You'll see it in the Integrity
Dashboard:

```
Chain originated by: your.email@example.com
```

This isn't a display label that we store separately. It's part of the
cryptographic record itself. It can't be quietly edited or removed.

### Why we do this

Aethelgard's selling point is that your records are tamper-proof *and*
provably yours. Tying the integrity signature to your licensed email is what
makes that statement real. If your accounts are ever questioned — by a tax
authority, an auditor, a counterparty — being able to point to a
cryptographic chain-of-custody in your own name is genuinely useful.

This isn't about stopping piracy. It's about making the integrity claim
mean something.

---

## What happens if you share your licence

The three-device cap means a fourth install would simply fail to activate.
That's the technical limit.

But the more important consequence — and the one most people don't think about
until it matters — is this:

> **The person you share with will end up with *your* email cryptographically
> embedded in their vault, permanently.** Every integrity proof they ever run,
> every audit export they ever produce, every backup of their accounts will
> show `Chain originated by: your.email@example.com` as a fact of the record.

For finance professionals — accountants, advisors, anyone whose records may
one day be inspected — this matters. If your colleague's data is scrutinised,
your name is in the chain. They, in turn, have no credible chain-of-custody
for their own accounts.

If you ever discover your licence has been shared or leaked, contact
`contact@aethelgard.finance`. We can revoke the old key and issue you a
replacement under the same email. Your chain continues uninterrupted; their
copy stops working.

---

## Changing the email on your licence

If your email needs to change legitimately — moving from a personal to a
business email, changing domains after a rebrand, or any other reason — that
is fully supported. It's a deliberate operation called a **reseal**. It:

1. Confirms your vault is currently intact and untampered.
2. Re-computes your integrity chain under your new email.
3. Records the change — old email, new email, timestamp — as a permanent
   entry in your vault's history.

After a reseal, your Integrity Dashboard shows both the current chain origin
and the reseal record. Your chain-of-custody stays complete and, crucially,
transparent — anyone reviewing your vault can see when the email was changed
and from what.

The reseal requires your current vault PIN. It cannot be performed without
it, and it cannot be performed on your behalf by support. This is
deliberate: the whole point of an integrity chain is that it cannot be
silently rewritten by anyone, including us.

---

## What happens if your licence is revoked

Your licence can be revoked in two circumstances:

1. You refunded your purchase through Paddle.
2. You contacted us to revoke it — for example, after a leak, or to transfer.

When a licence is revoked, Aethelgard will continue running on your machine
for up to 24 hours, after which it downgrades to trial mode. Your data is
never deleted, encrypted against you, or held hostage — it stays on your
machine, and you can re-enable full access at any time with a valid licence.

If you re-activate under the same email with a newly issued key, your
integrity chain continues without needing a reseal.

---

## In summary

- Up to three devices per licence. Need to rotate one? Email us.
- Your licence email is cryptographically part of your integrity signature —
  visible to you, to your auditor, and to anyone else you choose to show.
- Sharing your licence doesn't just risk a technical block — it puts your
  name on someone else's audit trail.
- Changing your email legitimately is fully supported through a deliberate,
  PIN-protected reseal.
- Revocation downgrades the app. It never touches your data.

Questions or unusual situations: `contact@aethelgard.finance`.
