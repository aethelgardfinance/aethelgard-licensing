# Admin Scripts

**Audience:** Cherie / future support
**Last updated:** 2026-04-24

The scripts in `scripts/` are the operator-side tools for managing licences
outside the normal Paddle flow. They are intentionally small, read-your-
confirmation, and never mutate production state without an explicit flag.

---

## Environment setup (one-time)

Most scripts need the Upstash Redis REST credentials. Vercel auto-injects them
into the deployed functions, but for local admin use you need to add them to
`.env.production` yourself:

1. Go to Vercel dashboard → `aethelgard-licensing` project → Settings →
   Environment Variables.
2. Copy the values of `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. Paste them into the bottom of `.env.production`:

   ```
   UPSTASH_REDIS_REST_URL=https://...upstash.io
   UPSTASH_REDIS_REST_TOKEN=AYABAS...
   ```

4. `.env.production` is gitignored — these never get committed. If you lose
   the file, refetch from the Vercel dashboard.

Then load them before running any script that touches KV:

```bash
set -a; . ./.env.production; set +a
```

---

## `send-prep.mjs` — beta / outreach draft generator

Generates personalised email drafts for beta testers (with live licence keys)
and design-partner outreach (no keys — initial contact only). Writes one `.txt`
file per tester to `scripts/drafts/` for you to review and send manually.

### Usage

```bash
set -a; . ./.env.production; set +a
node scripts/send-prep.mjs
```

Input: `scripts/testers.json` (gitignored — see `testers.json.example`).

Output: one file per tester under `scripts/drafts/`, named
`<TEMPLATE>_<name>.txt` (e.g. `A_cherie.txt`, `DP_HNW_marcus_webb.txt`).

### Templates

- **Beta (key generated):** `A`, `B1`, `B2`, `C`, `D`, `E`
- **Design partner (no key):** `DP_HNW`, `DP_ADVISOR`

### Things to check before running

- `FOUNDING_SLOTS_REMAINING` constant at the top of the script — update before
  each outreach batch so the copy reflects real scarcity.
- The feedback form URLs under `FORM` — should match your live Google Forms.

### After running

Each draft shows the generated key and flags whether SmartScreen copy was
omitted (for tech-savvy testers). Review the summary table, personalise any
`[BRACKETED]` placeholders in each draft, then send manually.

---

## `deactivate.mjs` — free a device slot on a customer's licence

Removes a fingerprint from the `devices[]` list on a `KeyRecord` in KV.
Typical use: customer emails `contact@aethelgard.finance` saying they've got
a new laptop and are at the three-device limit.

### Usage

Three modes:

```bash
# 1. List the devices currently registered against a key (read-only, always safe)
node scripts/deactivate.mjs AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX

# 2. Preview removal of device #N (1-based, matches the list output) — still read-only
node scripts/deactivate.mjs AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX 2

# 3. Actually perform the removal
node scripts/deactivate.mjs AETHG-XXXXXX-XXXXXX-XXXXXX-XXXXXX 2 --confirm
```

The script **never mutates KV without `--confirm`**. You can always dry-run.

### Typical support flow

1. Customer emails with their licence key and the name of the machine they're
   retiring (e.g. "please deactivate my old MBP").
2. Run `node scripts/deactivate.mjs <KEY>` — the list shows device names and
   last-seen timestamps. Pick the matching index.
3. Preview: `node scripts/deactivate.mjs <KEY> <N>`. Confirm the "About to
   remove" block matches what the customer asked for.
4. Apply: `node scripts/deactivate.mjs <KEY> <N> --confirm`.
5. Reply to the customer: "Slot freed — you can activate your new machine now."

### Edge cases

- **Key not in registry** → script exits with an error. This is either a
  beta key (no server-side tracking), or the key was mistyped. Double-check.
- **No devices registered** → nothing to deactivate. The customer hasn't
  used the key yet; they can activate directly.
- **Revoked key** → the script still lists and deactivates. Revocation is
  a separate concern (refunds, leaks); deactivation just frees a device slot.

### What this script does NOT do

- Revoke a leaked key. That's a different action — flip `revoked: true` on
  the record. Today this is a manual KV-console edit; a future `revoke.mjs`
  would automate it.
- Deactivate a device by name substring (would be convenient but risks
  partial-match mistakes). Index-based is deliberate.
- Send anything to the customer — reply to them by email yourself.

---

## Future admin scripts (not yet written)

- `revoke.mjs` — manually flip `revoked: true` on a key (for leaked keys
  where no Paddle refund exists).
- `lookup-key.mjs` — search KV by email or transaction ID when a customer
  has lost their key. Read-only.
- `reseal-assist.mjs` — if the reseal operation ever needs operator help
  (currently in-app only — this may not be needed at all).

Add them when support volume justifies the tooling cost. The operations
directory index (`README.md`) should be updated at the same time.
