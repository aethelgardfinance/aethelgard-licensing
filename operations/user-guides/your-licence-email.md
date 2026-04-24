# Your Licence Email

Your Aethelgard licence is issued to an email address — the one you used
when you purchased it. That email shows up in a few places inside
Aethelgard, and understanding what each of them means makes it much
easier to follow what's happening in your vault.

---

## Where you see it

### Vault Settings → Licence

Open **Vault Settings**, scroll to the **Licence** section. Beneath the
tier badge (Basic / Standard / Advanced) you'll see:

```
Licensed to: your.email@example.com
3 of 3 devices active
```

This tells you who this licence is registered to, and how many of your
three-device allowance are currently in use.

### The Dashboard — "Chain of Custody"

If you've enabled integrity binding (see below), the Dashboard shows a
small panel above the Integrity Status:

```
Chain of Custody
Chain originated by: your.email@example.com
```

This is more than cosmetic. The email is **cryptographically part of
your vault's tamper-proof signature** — it's in the hash chain that
proves your records haven't been altered.

---

## Why it matters

Aethelgard's core promise is that your records are tamper-proof. The
licensed email takes that one step further: your records are tamper-proof
**and provably yours**. If an auditor, a tax authority, or a counterparty
ever questions the integrity of your accounts, you can point to a
cryptographic record that originates from your own email — not a generic
"this was made in Aethelgard" stamp that anyone could produce.

This is especially valuable for:

- **Finance professionals** (accountants, advisors, family-office staff)
  whose records may be scrutinised by third parties.
- **Anyone whose counterparties** (banks, tax authorities, investors)
  might one day ask for integrity proofs.
- **Anyone who wants a durable chain of custody** over their own
  historical financial records.

---

## Licensed-to vs chain-bound

Two things in Aethelgard track your email, and they're deliberately
separate:

| | What it is | When it updates |
|---|---|---|
| **Licensed to** | The email your current active licence was issued to. | Automatically — within 24 hours of any licence re-issue. |
| **Chain originated by** | The email your vault's cryptographic record is permanently bound to. | Only when you explicitly reseal. Never silently. |

Normally these are the same. They only diverge when you change the email
on your licence (for example after incorporating a business, or moving
from personal to work email). When that happens, Aethelgard shows an
amber callout in Vault Settings inviting you to reseal — at which point
you deliberately re-bind your chain to the new email.

See [`changing-your-email.md`](changing-your-email.md) for what the
reseal operation does.

---

## Is my email exposed?

Inside the app, yes — in the places described above. Outside the app,
only where you deliberately share it:

- **Exported PDF reports** do **not** include your licensed email.
- **Integrity proofs** (when/if we ship a standalone export feature) will
  include it — the whole point is that an auditor can see it.
- **Backups** contain the email as part of the encrypted vault. Anyone
  who has both the backup and your PIN can see it; anyone with just the
  backup file cannot.

Your email is not sent to Aethelgard on every launch. It travels over
the network twice: once when you activate a new device, and once per 24
hours as part of the revocation check. Both calls are authenticated
with your licence key.

---

## Questions

- *"Can I use Aethelgard anonymously?"* Technically yes — your integrity
  binding is optional; you can skip it and run the app without the
  chain showing any email. You'll lose the chain-of-custody claim.
- *"What if someone else has the same email?"* The association is to
  your Paddle customer record, not to the string itself. Two
  unrelated customers with the same typed email would not collide
  (different Paddle IDs, different licence keys).
- *"What if my email provider is offline?"* Doesn't matter. Aethelgard
  doesn't talk to your email provider — it only knows the string, not
  the mailbox.

Questions or unusual situations: `contact@aethelgard.finance`.
