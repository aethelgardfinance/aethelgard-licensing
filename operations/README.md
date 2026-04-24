# Operations

Source-of-truth for how Aethelgard's licensing, activation, and integrity
systems work — and how to respond when something unusual happens.

This folder exists to answer three questions:

1. **How does the system work?** (architecture, not just code)
2. **What do I do when a customer asks X?** (support playbooks)
3. **What should customers understand about the product?** (user-facing source)

Everything here should be readable without opening the code. Where code and
docs disagree, the code is wrong — fix the code, update the doc.

---

## Contents

### Operator reference

| Document | Status | Purpose |
|---|---|---|
| [`licensing-architecture.md`](licensing-architecture.md) | Complete | End-to-end system overview — two repos, data flows, security model, common failures |
| [`activation-system.md`](activation-system.md) | Complete | Activation lifecycle, key format, device caps, fingerprint model, error paths |
| [`integrity-chain-email.md`](integrity-chain-email.md) | Complete (5a–5f) | How customer email is bound to the integrity chain; the reseal operation; delta between original spec and shipped implementation |
| [`admin-scripts.md`](admin-scripts.md) | Complete | `send-prep.mjs`, `deactivate.mjs`, `simulate-webhook.mjs`, env setup |
| [`support-playbooks.md`](support-playbooks.md) | Complete | Ten response templates for the tickets you'll actually receive |
| [`e2e-runbook.md`](e2e-runbook.md) | Complete | Pre-launch verification of the full licence lifecycle on each OS |

### User-facing (source)

Drafts live here so the language is stable before the client-side UI ships.
They are migrated to the app's help content and customer-facing channels
when the features they describe are in users' hands.

| Document | Status | Purpose |
|---|---|---|
| [`user-guides/key-sharing-and-you.md`](user-guides/key-sharing-and-you.md) | Draft | Plain-English explanation of what sharing means and why the licence email matters |
| [`user-guides/your-licence-email.md`](user-guides/your-licence-email.md) | Draft | Where users see their licensed email and what it signifies |
| [`user-guides/moving-to-a-new-device.md`](user-guides/moving-to-a-new-device.md) | Draft | The legitimate path — 3-device cap and deactivation |
| [`user-guides/changing-your-email.md`](user-guides/changing-your-email.md) | Draft | The reseal operation in plain terms |

---

## Conventions

- Operator docs: technical, comprehensive, honest about edge cases. Assume the
  reader is you (or a successor) six months from now, troubleshooting under
  pressure.
- User-facing docs: plain English, second person ("you"), confident about the
  why. Assume the reader is a finance professional — serious but not a
  developer.
- Every document leads with its purpose and its status. Nothing here is
  evergreen by default — flag what's design-only vs. implemented.
