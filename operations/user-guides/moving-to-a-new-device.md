# Moving Aethelgard to a New Device

Your Aethelgard licence activates on up to three devices — covering the
normal real-world setup of a desktop, a laptop, and one spare. This
guide walks you through replacing one of them.

---

## Normal case: you're still under the three-device limit

If you've only activated on one or two devices so far, there's nothing
to undo. Just install Aethelgard on your new machine, paste the same
licence key into **Vault Settings → Licence → Activate a licence key**,
and click **Activate**. The device count bumps up; your data stays
wherever it is (on the old machine, in a backup, or both).

No support email needed for this case.

---

## Replacement case: you're already at three devices

When you try to activate a fourth device, Aethelgard shows a modal:

> **Device limit reached**
>
> This licence is already active on 3 devices. To activate this
> machine, an existing device must be deactivated first.

The modal lists the three devices with their names and the dates they
were activated / last seen. Click **Email support** — this opens a
pre-filled email addressed to `contact@aethelgard.finance` with your
licence key already embedded.

**You need to tell us which device to retire.** The modal shows names
like "Cherie-MBP" or "Cherie-Desktop-2023". Pick the one you're
stepping away from and include that name in the email.

We'll reply within a few hours (usually much faster), and once we've
freed the slot you can activate your new machine.

---

## What happens on the old device after deactivation

- **Your data stays intact.** Aethelgard never deletes vault data during
  deactivation. The old machine still has your full vault.
- **The licence on that machine stops working.** Within 24 hours, the
  app on the old machine will detect that its slot has been freed and
  downgrade to trial tier. Tier-gated features become read-only until a
  licence is activated there again.
- **If you want to wipe the data**, go to **Vault Settings → Reset
  Vault** on the old machine. That's a factory-reset, not an automatic
  consequence of deactivation.

---

## Transferring your vault data to the new machine

Two common paths:

1. **Export + import.** On the old machine, **Vault Settings → Export
   encrypted backup**. Move the backup file to the new machine
   (email it to yourself, copy to a USB drive, or use your own
   cloud-storage tool — Aethelgard doesn't do any of this for you).
   On the new machine, **Vault Settings → Restore from encrypted
   backup**.

2. **Fresh start.** If you want a clean slate on the new machine, don't
   import anything — just activate the licence and start entering data
   from scratch.

Your integrity chain (if you had one) is preserved in the encrypted
backup, so option 1 gives you continuity of chain-of-custody. Option 2
starts a new chain.

---

## What happens to my chain of custody

Deactivating a device and moving to a new one does **not** affect your
integrity chain's bound email. The chain is bound to your licence
email, not your machine. As long as you keep using the same licence,
your chain-of-custody continues on the new machine once you restore
your vault data.

If you're changing email at the same time (e.g., moving to a new
Paddle account), see [`changing-your-email.md`](changing-your-email.md).

---

## If you've lost access to the old device

If the old device was stolen, dropped in a lake, or given away before
you deactivated it: email us. We can free the slot based on just your
licence key — we don't need to verify anything about the lost machine
itself. Your vault on that machine (if it still exists) is encrypted
at rest; without your PIN, no-one else can open it.

---

## Questions

- *"Can I activate on two machines I use at the same time?"* Yes — that's
  exactly what the three-device allowance is for.
- *"Can I deactivate via the app directly?"* Not yet. Today it's an
  email to us; we're watching how often it comes up before building a
  self-service path.
- *"What if I reinstall the OS on the same machine?"* Aethelgard may see
  it as a different device after reinstall (the underlying machine ID
  changes). Email us with your licence key and we'll clean up the old
  fingerprint from your activation list.

Questions or unusual situations: `contact@aethelgard.finance`.
