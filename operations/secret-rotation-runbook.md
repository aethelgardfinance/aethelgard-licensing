# Secret Rotation Runbook

Closes M-LIC-5 from the 2026-05-07 review. Documents how each licensing
secret can be rotated, the blast radius of a compromise, and the
multi-key acceptance design that's been queued (not implemented) so
the rotation surface can be evaluated without writing the code first.

| Secret | Lives in | Read by | Rotation impact |
|---|---|---|---|
| `AETHELGARD_LICENSE_SECRET` | Vercel env + each app binary at build time | webhook key generation; every app's local validation | **All-users force-upgrade.** See §3. |
| `PADDLE_WEBHOOK_SECRET` | Vercel env + Paddle dashboard | webhook signature verification | Five-minute window where webhooks may 401 during the swap. See §4. |
| `PADDLE_API_KEY` | Vercel env + Paddle dashboard | customer-email lookup fallback | Negligible. See §5. |
| `RESEND_API_KEY` | Vercel env + Resend dashboard | every license-delivery email + waitlist | Email delivery pause until the new key lands. See §6. |
| `SLACK_ALERT_WEBHOOK_URL` (optional) | Vercel env + Slack | dead-letter admin alerts | None — alerts go stderr-only when unset. See §7. |

The rest of this document walks through each secret in turn. The
`AETHELGARD_LICENSE_SECRET` section is the longest because it's the
secret with the largest blast radius and the most awkward rotation
shape — every other secret is a "swap two values in two dashboards"
exercise.

---

## 1. Pre-flight

Before rotating any secret:

1. Confirm you have `gh auth status` showing you are logged in.
2. Confirm you have `vc whoami` (Vercel CLI) showing you are logged in
   to the `aethelgard` team.
3. Open Paddle ▸ Developer Tools and Resend ▸ API keys in browser
   tabs — you'll need both.
4. Snapshot the current Upstash state to local JSON in case anything
   goes wrong: `npm run kv:export > kv-snapshot-$(date -u +%FT%TZ).json`.
   (If `kv:export` doesn't exist yet, fall back to the support-playbook
   procedure for a manual `kv.scan` walk.)
5. Note the current production deployment URL — you will compare
   against it after the rotation.

If anything in step 1-4 doesn't apply (for instance, you're rotating
because you've lost access to one of the dashboards), stop and read §8.

---

## 2. The "everything went fine" smoke test (run after every rotation)

After any rotation completes:

1. Hit `/api/latest` — should return the current download manifest
   without error.
2. Replay a fixture Paddle webhook from `lib/__tests__/fixtures/`
   against the production endpoint with a unique `tx.id`. The webhook
   should return 200 and a license email should arrive within a
   minute.
3. Check Vercel logs for the redacted `eml:…` identifier of the
   replay's recipient — confirm no errors above `[ADMIN-ALERT]` level.
4. Watch the Slack alert channel for one minute — there should be no
   new dead-letter notifications.

If any of these fail, see §9.

---

## 3. Rotating `AETHELGARD_LICENSE_SECRET` — the big one

This secret is the HMAC key used to sign every license. It is
**embedded in each app binary at compile time** (Aethelgard core,
Sentinel, PDF Studio) so that license validation works offline.
Validation is "decode the key bytes, recompute the HMAC, compare."

### 3.1 Blast radius if compromised

A leaked `AETHELGARD_LICENSE_SECRET` lets an attacker mint license
keys that any released binary will accept as valid. There is no
revocation list inside the app — it cannot phone home; the key is
self-validating.

This is the structural weakness the review flagged. Today's mitigation
is "the secret is on Cherie's local machine and in Vercel's encrypted
env-var store; it has never been committed to git." A compromise
beyond those two surfaces is the rotation trigger.

### 3.2 What rotation costs today

Naively rotating means:

1. Generate a new secret.
2. Set it as `AETHELGARD_LICENSE_SECRET` in Vercel.
3. Rebuild each app from main with the new secret baked in
   (Aethelgard core, Sentinel, PDF Studio — three release pipelines).
4. Tag and ship new versions of all three apps.
5. **Force every existing customer to upgrade**, because their old
   binaries cannot validate keys signed with the new secret. New
   keys minted by the webhook will look like garbage to anyone still
   on the previous build.

This is unacceptable for a paid product unless the original secret is
known-leaked, because it strands every customer who hasn't upgraded.

### 3.3 The multi-key acceptance design (deferred)

The implementation queue has a "multi-key acceptance window" item that
unblocks rotation:

- App binaries get an *array* of accepted secrets, not a single one.
  The latest secret is the *issuing* one; previous secrets are still
  *validating* until they age out.
- A new `AETHELGARD_LICENSE_SECRET_GEN` env var on the webhook side
  controls which secret is used for new keys; older secrets sit in
  `AETHELGARD_LICENSE_SECRET_PREVIOUS` and similar.
- During a rotation event you ship a new app build that knows about
  *both* the old and new secrets, then flip the webhook to issue with
  the new one. Existing customers can keep using their old keys (still
  validating against the old secret) while new customers get keys
  signed with the new one. After 12-18 months you sunset the old
  secret in a future app release.

That implementation is **not yet in code**. It is ~8-12h of careful
work and adds attack surface that we should only take on when there's
a concrete need. The design lives here so a future engineer (or
future-Claude) starts from a position rather than from scratch.

### 3.4 Until multi-key lands: the emergency rotation procedure

If `AETHELGARD_LICENSE_SECRET` is **known compromised** (e.g. a
backup leaked, a dev machine was stolen, a former contributor exposed
it):

1. **Immediate**: rotate the Vercel env var to a new value. From
   this moment forward all newly-issued keys will be valid only for
   future builds.
2. Email every paying customer (use the Resend dashboard to query
   recent recipients) explaining that an upgrade is required and
   providing the new build link. Do this before step 3.
3. Build and tag new versions of all three apps with the new secret
   baked in. Ship via the standard Release workflow.
4. After 7 days, replay any stale webhooks from Paddle's webhook
   delivery log (Paddle keeps 14 days of history) so customers who
   bought during the rotation window get their new-secret keys.
5. After 30 days, audit Vercel + Paddle + Resend logs for any signs
   of fraudulent issuance during the compromise window. The
   `dead_letter:*` queue and `tx:*` records together give you the
   issuance ground truth.

If the secret is **suspected** but not confirmed compromised, do not
emergency-rotate. Implement the multi-key acceptance design first
(8-12h work) and rotate during a planned window with no customer
impact.

---

## 4. Rotating `PADDLE_WEBHOOK_SECRET`

The HMAC secret Paddle uses to sign delivery notifications.
Compromise of this secret allows an attacker to forge webhooks (issue
fake licenses), but they would also need to know which transaction
shape to send and the price-id mappings — non-trivial but doable.

Rotation is straightforward:

1. Paddle ▸ Developer Tools ▸ Notifications ▸ select the destination
   ▸ "Reveal Secret" ▸ "Regenerate".
2. Copy the new secret.
3. Vercel ▸ aethelgard-licensing ▸ Settings ▸ Environment Variables
   ▸ edit `PADDLE_WEBHOOK_SECRET` ▸ paste new value ▸ Save.
4. Trigger a redeploy: `vc redeploy --prod` or push an empty commit.
5. There is a brief window (seconds-to-minutes) during the redeploy
   when Paddle webhooks may 401 because Paddle's send-side has the
   new secret but the Vercel runtime is still on the old one — Paddle
   retries failed webhooks for 3 days, so this is recoverable but
   means brief delivery delays.
6. Smoke test per §2.

---

## 5. Rotating `PADDLE_API_KEY`

Used only as a customer-email lookup fallback when a webhook payload
omits the email field. Negligible blast radius — it cannot generate
or refund transactions.

1. Paddle ▸ Developer Tools ▸ Authentication ▸ create a new API key
   with `transaction:read` and `customer:read` scopes.
2. Copy the new key.
3. Vercel ▸ env vars ▸ replace `PADDLE_API_KEY` ▸ Save ▸ redeploy.
4. After a few hours, revoke the old key in Paddle.
5. Smoke test per §2.

---

## 6. Rotating `RESEND_API_KEY`

A leaked Resend key lets an attacker send emails *from*
contact@aethelgard.finance. The damage is reputational
(impersonation / phishing) more than financial, but it is the most
likely-to-leak secret because it appears in every email-sending
function and any debug snippet that copy-pastes from logs.

1. Resend dashboard ▸ API Keys ▸ "Create API Key" with full sending
   permissions.
2. Copy the new key.
3. Vercel ▸ env vars ▸ replace `RESEND_API_KEY` ▸ Save ▸ redeploy.
4. Within 5 minutes, revoke the old key in Resend.
5. Watch the dead-letter queue for the next hour — any deliveries
   that landed during the swap may have hit the gap. Replay them
   per the email-retry runbook.
6. Smoke test per §2.

---

## 7. Rotating `SLACK_ALERT_WEBHOOK_URL`

Optional. Used only by the dead-letter alert path. Blast radius:
someone with the URL can post arbitrary messages to the alert channel.

1. Slack ▸ App Directory ▸ Incoming Webhooks ▸ remove the old hook
   ▸ create a new one to the same channel.
2. Vercel ▸ env vars ▸ replace `SLACK_ALERT_WEBHOOK_URL` ▸ Save ▸
   redeploy.
3. No smoke test needed — the next dead-letter event will exercise
   it. To force-test, manually post a fixture failure via the replay
   script (queued).

---

## 8. "I've lost access to a dashboard"

If you cannot get into Paddle, Resend, or Vercel because credentials
are gone:

- **Vercel**: account recovery via the email on the account. If that
  email is also gone, Vercel support can verify ownership via DNS
  TXT records on the connected domain (`aethelgard.finance`). Allow
  several business days.
- **Paddle**: Paddle support requires identity verification (passport
  or driving licence + a recent transaction reference). Allow 1-3
  business days. Until then the app generates no new keys.
- **Resend**: account recovery via email. If that fails, contact
  Resend support — they require domain ownership proof.

If any of these are inaccessible mid-incident, the priority is
restoring `AETHELGARD_LICENSE_SECRET` rotation capability (because of
its blast radius), then `PADDLE_WEBHOOK_SECRET`, then the rest.

---

## 9. "Smoke test failed after rotation — what now?"

Don't panic. None of the smoke-test failures here are silent: the
system is loud about every category of failure introduced in
v1.21.0+ (4a-4c).

| Failure | Likely cause | First check |
|---|---|---|
| `/api/latest` errors | Bad redeploy (env var typo) | Vercel deployment logs |
| Webhook 401 / signature error | `PADDLE_WEBHOOK_SECRET` mismatch | Compare Paddle and Vercel values |
| Webhook 500 from license gen | `AETHELGARD_LICENSE_SECRET` mismatch with app build | Last release tag vs current secret |
| Email never arrives, no dead-letter | `RESEND_API_KEY` not refreshed in runtime | Vercel env vars + redeploy timestamp |
| Email never arrives, dead-letter present | Resend key valid but recipient bounced | Replay from KV after fixing recipient |
| Slack alert fires for valid delivery | Bug, file an issue | Vercel logs, attach `tx.id` |

The honest test of any rotation is: an actual customer purchase
flowing all the way through. Until you've seen one of those after
the rotation, the rotation is not complete.

---

## 10. Audit trail

Each rotation event should be logged at the bottom of this file in
the format below. Append-only; never delete entries (they are the
"who rotated when" record for any future incident review).

```
### YYYY-MM-DD — what was rotated, why, by whom
- Secret(s) rotated:
- Reason (planned / suspected leak / confirmed leak):
- Customer-impact window:
- Smoke test outcome:
- Notes:
```

(No entries yet — the first rotation will be logged here.)
