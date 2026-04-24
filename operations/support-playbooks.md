# Support Playbooks

**Audience:** Cherie / future support
**Last updated:** 2026-04-24

Response templates and diagnostic flows for every customer ticket that
has shown up (or is likely to) against the licence / integrity system.

Each playbook has three parts:
- **Diagnose** — how to confirm what's actually happening
- **Act** — the operator steps (scripts, KV reads, etc.)
- **Reply** — an email template you can tweak and send

All scripts run from `aethelgard-licensing/` with `.env.production` loaded:

```bash
set -a; . ./.env.production; set +a
```

---

## 1. "My licence key doesn't work"

Symptom: customer pasted their key into Vault Settings and activation
failed. Could be several root causes.

### Diagnose

Ask for:
- The exact key string (mention they can copy it from the original email).
- The error message shown in the app (screenshot preferred).
- Their OS and Aethelgard version (Help → About).

Common root causes:

| Error shown | Root cause |
|---|---|
| "Invalid license key" (local, before any network call) | Key mistyped, or key is for a different Aethelgard build (dev vs prod secret). |
| "Could not reach the licensing server..." | First activation requires internet. |
| "This licence has been revoked..." | Refund processed, or key was manually revoked. |
| "Device limit reached" modal | Key is already on 3 machines. See playbook #2. |

### Act

If it looks like the key itself is wrong, check KV:

```bash
# We don't have a lookup-by-email script yet (flagged as future work);
# for now, manually:
#   - Log into the Upstash console for aethelgard-licensing.
#   - Browse keys starting with `key:`.
#   - Find the customer's entry by scanning `customer_email`.
```

If the key is in KV but shows `revoked: true` and the customer hasn't
refunded, reissue — see playbook #6.

### Reply template

> Thanks for flagging. I can see your licence on our end under the
> email `<email>` — the issue is that `<specific cause>`. To fix:
>
> `<specific action — reinstall, reactivate once online, etc.>`
>
> If the issue persists after that, please send a screenshot of Help →
> About and the error message and I'll dig deeper.

---

## 2. "I've got a new laptop — can you free up a slot?"

Symptom: customer hits the three-device cap on their fourth install.
The in-app modal lists the three registered devices and offers a
`mailto:` link pre-filled with the licence key.

### Diagnose

The mailto body will include the licence key and a placeholder asking
them to identify which device to retire. Make sure they actually tell
you (often they forget).

### Act

```bash
# List the devices — 1-based indexes matching the in-app display
node scripts/deactivate.mjs <THEIR_KEY>

# Preview removal
node scripts/deactivate.mjs <THEIR_KEY> <INDEX>

# Apply
node scripts/deactivate.mjs <THEIR_KEY> <INDEX> --confirm
```

Don't apply without confirming — a wrong index means freeing the
*wrong* device, which strands the customer on their active machine.

### Reply template

> Done — I've deactivated the `<device-name>` slot. You can now activate
> Aethelgard on your new machine. Just paste the same licence key into
> Vault Settings → Licence.
>
> Your data on the old machine stays exactly as it was — nothing is
> deleted. If you want to wipe it, factory-reset the vault from Vault
> Settings → Reset Vault before handing the machine on.

See also: [`admin-scripts.md`](admin-scripts.md) for the full
`deactivate.mjs` reference.

---

## 3. "I refunded, but the app is still working"

Symptom: customer refunded through Paddle, expected Aethelgard to
immediately downgrade to trial, but the app still shows Advanced.

### Diagnose

Check KV — the record should have `revoked: true` (the refund webhook
flipped it). If yes, this is a timing thing, not a bug:

- The app checks `/api/verify` **at most once per 24 hours**
  (`license_verify.rs`). Until the next check fires, the client keeps
  running under its cached valid state.
- If the machine was offline when the check was due, it waits until
  next online + next launch.

If KV shows `revoked: false`, the webhook didn't fire — check Vercel
function logs and the Paddle webhook configuration.

### Reply template

> Revocation is applied centrally, but Aethelgard only checks in with
> our server once every 24 hours (so the app keeps working offline).
> Within the next day the app will detect the refund and downgrade to
> the trial tier. Your data stays on your machine exactly as it was —
> the app just re-locks tier-gated features until a new licence is
> activated.

---

## 4. "I changed my Paddle email. Will my vault break?"

Symptom: customer about to (or just did) change the email on their
Paddle account, and they're worried about their integrity chain.

### Diagnose

- Is the customer using integrity binding today? Check their vault:
  if `integrity_chain_bound_email` is set, yes.
- If binding is not active, no reseal is needed — nothing will break.

### Act

Direct them to the reseal flow. No operator action required.

### Reply template (binding active)

> Your vault won't break. Here's what happens:
>
> 1. Paddle re-issues your licence under the new email — same Aethelgard
>    key format, valid immediately.
> 2. Open Aethelgard, go to Vault Settings → Licence, paste the new
>    key if it prompts you (it might not — the existing key may just
>    keep working on new activations).
> 3. On the next 24-hour check, the app picks up the new email.
> 4. Vault Settings → Licence then shows an amber callout *"Integrity
>    chain needs resealing"*. Click **"Reseal chain under new email"**
>    and enter your vault PIN.
> 5. The chain is rebound. Your old email and the reseal timestamp stay
>    permanently visible in your chain-of-custody — auditors can trace
>    the history.
>
> No data is lost. The reseal is the deliberate, permanent, visible
> event recorded in your Integrity Dashboard.

See also: [`integrity-chain-email.md`](integrity-chain-email.md) for the
full reseal design.

### Reply template (binding not active)

> Your vault won't be affected at all — you haven't enabled integrity
> binding yet, so your chain is not tied to any email. The new licence
> will activate as a standard key swap.
>
> If you want to enable binding after the email change lands (so your
> chain-of-custody is tied to your current email going forward), you'll
> see a prompt in Vault Settings → Licence once the new email is in the
> app. Follow that when you're ready.

---

## 5. "It says internet required to activate"

Symptom: `NetworkError` state during activation. The app refused to
activate the licence without a server connection.

### Diagnose

This is by design — first-time activation is the one enforcement point
where the server must be reachable. Once activated, Aethelgard is fully
offline.

Check:
- Is the customer actually online? (corporate firewalls can block
  `aethelgard-licensing.vercel.app`)
- Is our server up? `curl https://aethelgard-licensing.vercel.app/api/latest`
  should return 200.
- Are they behind a proxy that inspects TLS? Rare but possible.

### Reply template

> First-time activation is the one step that requires internet — after
> that, Aethelgard runs fully offline. If you're on a corporate network,
> your firewall may be blocking `aethelgard-licensing.vercel.app`; try
> activating from a home or mobile connection if so, then the app will
> work offline from any network after that.

---

## 6. "I think my licence key was leaked online"

Symptom: customer found their key posted on a forum, or someone else's
dashboard clearly shows their email.

### Diagnose

Confirm the customer is genuine (match licence email to the one they're
emailing from). Ask where the leak appeared — a URL if possible, for
records.

### Act

The leaked key has to be invalidated and a new one issued:

1. **Revoke in KV** — flip `revoked: true` on the current `key:<hash>` row.
   (Will be automated by `scripts/revoke.mjs` — currently manual through
   the Upstash console.)
2. **Reissue** — through Paddle support tools, issue a replacement key
   to the same email. The Paddle webhook will generate + email a new key,
   and insert a fresh KV record.
3. All other active installs of the old key downgrade within 24 hours.
4. Because the bound email is unchanged, **no reseal is needed** — the
   chain continues uninterrupted on the customer's own install.

### Reply template

> I've revoked the compromised key and arranged a replacement under the
> same email. Check your inbox in the next few minutes — you'll get a
> new licence email. Paste that key into Vault Settings → Licence.
>
> Anyone else using the leaked key will see the app downgrade to trial
> within 24 hours. Your integrity chain is unaffected — your vault stays
> bound to your email, and your data and chain-of-custody continue as-is.
>
> Out of curiosity, can you tell me where you spotted the leak? It helps
> us track whether this is an isolated incident or a pattern.

---

## 7. "My Integrity Dashboard says the chain is broken"

Symptom: customer reports that Aethelgard is flagging their vault as
tampered, or the Dashboard shows "At Risk".

### Diagnose

There are two integrity checks:

- **Balance check** (`is_balanced`) — trial-balance debits = credits.
  Fails when a transaction has a net non-zero entry. Usually a CSV
  import problem, not tampering.
- **Cryptographic check** (`integrity_valid`) — every transaction's
  stored `chain_hash` still matches the recomputed hash.

Ask the customer:
- Which of the two is flagged? Dashboard should say.
- Did they recently restore from a backup? (If yes, the restore may
  have landed mid-chain or from a different binding.)
- Did they recently have a crash or power loss during a transaction
  write? (Partial write = broken chain.)

### Act

Investigate; do **not** recalculate the chain as a fix until you
understand the root cause. Recalculation writes fresh hashes under the
current state — if the state is the result of tampering, you'd erase
the evidence.

For legitimate recovery (e.g. confirmed restore from an older backup):

```sql
-- From the Upstash console, or via a forthcoming admin script,
-- you can trigger recalculate_all_chains via the Rust side through a
-- developer console. Right now this is a support engineer task, not
-- a customer self-service path.
```

### Reply template

> Thanks for the screenshot. Before I touch anything, a few questions:
>
> - Did you restore from a backup recently?
> - Did Aethelgard crash, or did the machine lose power, during a save?
> - Have you made any changes to the database file directly?
>
> I don't want to recalculate the chain until we know the cause — if the
> data genuinely has been tampered with, recalculation would erase the
> evidence. Once you reply, I'll walk you through the right next step.

---

## 8. "I forgot my PIN"

Symptom: customer can't unlock their vault, blocking activation, reseal,
or general use.

### Diagnose

Aethelgard stores the PIN hash in the OS keyring (Credential Manager /
Keychain / SecretService) — not on our server. Without the PIN or a
recovery key, support cannot recover the vault.

### Reply template

> Aethelgard stores your PIN hash only on your own machine — we don't
> have it on our server and there's no back door. If you set up a
> recovery key when you first created the vault, use that to reset the
> PIN (Vault Settings → Reset Access Code).
>
> If you didn't set one up, the vault cannot be unlocked. Your data is
> encrypted at rest and nobody — including us — can open it without the
> PIN. The best path is to start a fresh vault and restore from a backup
> if you have one.
>
> I realise this is a rough outcome; it's the direct consequence of the
> "your data never leaves your machine" promise. Happy to talk through
> data recovery options if you have backups.

---

## 9. "Can I transfer my licence to someone else?"

Symptom: customer wants to give their Aethelgard licence to a colleague,
family member, or new business entity.

### Diagnose

Currently **not supported as a self-service path**. The customer email
on the licence is tied to the Paddle customer record and to the vault's
integrity chain.

### Act / Reply template

> We don't currently support transferring a licence between people — the
> customer email is baked into your vault's cryptographic
> chain-of-custody, and moving it would either break that chain or
> hide the transfer.
>
> What I can do:
>
> - If this is a business change (you've incorporated, or changed email
>   domain), we can update the email on your existing licence and you
>   can reseal your chain. The reseal records the old → new transition
>   permanently in your history, so your chain-of-custody is preserved.
>
> - If you're giving Aethelgard to a different person entirely, the
>   cleaner path is for them to buy their own licence. They can start a
>   fresh vault — there's no technical way to move your chain-of-custody
>   onto someone else's record without defeating its point.
>
> Let me know which situation applies and I'll follow up with the right
> next step.

---

## 10. "Windows blocked the installer — 'Protected your PC'"

Symptom: SmartScreen prompt on Windows first launch.

### Diagnose

Expected for new builds. SmartScreen's reputation system warms up with
downloads over roughly a month after release. This is cosmetic — the
installer itself is signed and intact.

### Reply template

> That's Windows SmartScreen — our installer is signed, but SmartScreen's
> reputation system takes a few weeks to catch up with each new release.
> To install:
>
> 1. Click **More info** on the prompt.
> 2. Click **Run anyway**.
>
> You'll only see this once on first install. Follow-up updates auto-
> apply in the background without the prompt.

---

## Cross-references

- Admin scripts: [`admin-scripts.md`](admin-scripts.md) —
  `deactivate.mjs`, `simulate-webhook.mjs`, future `revoke.mjs`.
- Integrity chain + reseal internals: [`integrity-chain-email.md`](integrity-chain-email.md).
- End-to-end verification runbook: [`e2e-runbook.md`](e2e-runbook.md).
- Customer-facing user guides: [`user-guides/`](user-guides/) —
  sometimes easier to link a customer to the guide than to paraphrase
  a whole playbook in the reply.
