/**
 * Email draft generator — beta testers and design partner outreach.
 *
 * Usage (from aethelgard-licensing/):
 *   AETHELGARD_LICENSE_SECRET=<prod-secret> node scripts/send-prep.mjs
 *
 * Reads scripts/testers.json, generates a license key per tester (beta only),
 * fills the relevant email template, and writes one draft .txt file per person
 * to scripts/drafts/. Review each draft and send manually.
 *
 * Templates:
 *   Beta testers (key generated):  A, B1, B2, C, D, E
 *   Design partner outreach (no key): DP_HNW, DP_ADVISOR
 *
 * testers.json is gitignored — see testers.json.example for the format.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname }                                       from 'node:path';
import { fileURLToPath }                                       from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const DEV_SECRET  = 'aethelgard-dev-only-secret-do-not-use-in-production-builds-2026';
const SECRET      = process.env.AETHELGARD_LICENSE_SECRET ?? DEV_SECRET;
const VERSION     = '1.6.2';
const DOWNLOAD    = `https://github.com/aethelgardfinance/aethelgard-releases/releases/tag/v${VERSION}`;

// Beta tester feedback forms — fill in once Google Forms are created
const FORM = {
    A: '[FORM LINK A]',
    B: '[FORM LINK B]',
    C: '[FORM LINK C]',
    D: '[FORM LINK D]',
    E: '[FORM LINK E]',
};

// Design partner application form — fill in once created
const DP_FORM = 'https://docs.google.com/spreadsheets/d/13intVFWY_Y_IGVgKRKIu44-zM7EIlaK-KvExy0oxX-Y/edit?usp=sharing';

// Update before each outreach batch — shown in the email to create real urgency
const FOUNDING_SLOTS_REMAINING = 20;

// ── Key generation (mirrors lib/keygen.ts — keep in sync) ────────────────────

const TIER_BYTE = { personal: 0, sovereign: 1, corporate: 2 };
const ALPHABET  = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LIFETIME  = 0xFFFF;
const EPOCH     = new Date(Date.UTC(2026, 0, 1));

function dateToMonths(d) {
    const m = (d.getUTCFullYear() - EPOCH.getUTCFullYear()) * 12
            + (d.getUTCMonth()    - EPOCH.getUTCMonth());
    return Math.max(0, Math.min(0xfffe, m));
}

function annualExpiry() {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 13);
    return d;
}

function randomCustomerId() {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    return ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
}

async function computeHmac(data, secret) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

function encodeBase32(bytes) {
    let acc = 0n;
    for (const b of bytes) acc = (acc << 8n) | BigInt(b);
    let out = '';
    for (let i = 23; i >= 0; i--) out += ALPHABET[Number((acc >> BigInt(i * 5)) & 0x1fn)];
    return out;
}

async function makeKey(tier, expiry) {
    const customerId = randomCustomerId();
    const expiryDate = expiry === 'lifetime' ? null : annualExpiry();
    const months     = expiryDate === null ? LIFETIME : dateToMonths(expiryDate);

    const buf = new Uint8Array(15);
    buf[0] = (1 << 4) | TIER_BYTE[tier];
    buf[1] = (months >> 8) & 0xff;
    buf[2] =  months       & 0xff;
    buf[3] = (customerId >>> 24) & 0xff;
    buf[4] = (customerId >>> 16) & 0xff;
    buf[5] = (customerId >>>  8) & 0xff;
    buf[6] =  customerId         & 0xff;

    const hmac = await computeHmac(buf.buffer.slice(0, 7), SECRET);
    buf.set(hmac.slice(0, 8), 7);

    const e   = encodeBase32(buf);
    const key = `AETHG-${e.slice(0,6)}-${e.slice(6,12)}-${e.slice(12,18)}-${e.slice(18,24)}`;
    return { key, expiryDate, customerId };
}

// ── Email templates ───────────────────────────────────────────────────────────

const SMARTSCREEN = `**One quick note on installation:** Windows may show a "Windows protected your PC" message on first launch. Click **More info** → **Run anyway** — this appears because the app is new; it will not show again.

`;

const KEY_BLOCK = (key, expiryStr) =>
`**Your license key** — enter this when the app prompts you (unlocks full Corporate access, valid ${expiryStr}):

    ${key}

`;

function emailA(t) {
    const open = t.personal_note
        ? `Hi ${t.name},\n\n${t.personal_note}\n\nI wanted to share what I've been building:`
        : `Hi ${t.name},\n\nI came across your [post / comment / work on hledger] and thought you'd be an ideal tester for something I've been building.`;

    return `Subject: You're invited to beta test Aethelgard — a private, local-first finance app

${open}

Aethelgard (pronounced *ay-thel-gard*) is a double-entry accounting desktop app for people who take their personal finances seriously and don't want their data in the cloud.

**What it does:**
- Full double-entry bookkeeping that runs entirely on your machine
- Portfolio analytics: Sharpe ratio, rolling volatility, stress tests
- Investment reports: Portfolio Snapshot, Realized Gains, Rebalancing
- Tax estimates for UK (income, NI, corp tax) and US (federal brackets, FICA)
- CSV import, period locks, bank reconciliation, cryptographic integrity dashboard

**What I'm asking:**
About 60–75 minutes of your time over the next two weeks, filling in the feedback form as you go. No calls required.

**Download:** ${DOWNLOAD}
**Feedback form:** ${FORM.A}

${t.tech_savvy ? '' : SMARTSCREEN}${KEY_BLOCK(t.key, t.expiryStr)}**What you get:**
Lifetime access when it launches, and direct input into the roadmap.

Any questions, just reply.

Cherie`;
}

function emailB1(t) {
    const open = t.personal_note
        ? `Hallo ${t.name},\n\n${t.personal_note}\n\nDaarom wilde ik je uitnodigen om iets te testen wat ik bouw:`
        : `Hallo ${t.name},\n\nIk begrepen dat je [een BV runt / als ZZP'er werkt] en dacht dat je een goede testpersoon zou zijn voor iets wat ik bouw.`;

    return `Subject: Beta-uitnodiging: Aethelgard — privacy-first boekhoudsoftware voor ondernemers

${open}

Aethelgard (*ay-thel-gard*) is privé, lokale boekhoudsoftware voor ondernemers die inzicht willen in hun eigen cijfers, zonder alles naar de cloud te sturen. De app ondersteunt NL Box 1, Box 3 en Vpb-berekeningen, en bevat een automatische BTW Aangifte-module.

**Wat ik vraag:**
Ongeveer 70 minuten van je tijd, verspreid over de komende twee weken. Vul het feedbackformulier in terwijl je test.

**Download:** ${DOWNLOAD}
**Feedbackformulier:** ${FORM.B}

${t.tech_savvy ? '' : SMARTSCREEN}${KEY_BLOCK(t.key, t.expiryStr)}**Wat je ervoor terugkrijgt:**
Levenslange toegang zodra de app uitkomt, en directe invloed op de functies die er voor jouw type bedrijf toe doen.

Met vriendelijke groet,
Cherie`;
}

function emailB2(t) {
    const open = t.personal_note
        ? `Hi ${t.name},\n\n${t.personal_note}\n\nI wanted to invite you to test something I've been building:`
        : `Hi ${t.name},\n\nI understand you [run a small business / work as a freelancer] in [ES / MX] and thought you'd be an ideal tester.`;

    return `Subject: Beta invitation: Aethelgard — private, desktop accounting for small businesses

${open}

Aethelgard (*ay-thel-gard*) is a privacy-first desktop accounting app for small business owners who want visibility into their numbers without sending everything to a cloud provider. It supports [Spanish / Mexican] tax estimates and runs entirely on your machine.

**What I'm asking:**
About 70 minutes of your time. Fill in the feedback form as you go — no calls required.

**Download:** ${DOWNLOAD}
**Feedback form:** ${FORM.B}

${t.tech_savvy ? '' : SMARTSCREEN}${KEY_BLOCK(t.key, t.expiryStr)}**What you get:**
Lifetime access at launch and direct input into features that matter for businesses like yours.

Cherie`;
}

function emailC(t) {
    const open = t.personal_note
        ? `Hi ${t.name},\n\n${t.personal_note}\n\nI wanted to reach out about something I've been building:`
        : `Hi ${t.name},\n\nI saw your [post / comment] about [self-hosting / privacy / leaving cloud services] and wanted to reach out directly.`;

    return `Subject: Beta access: Aethelgard — local-first, double-entry, cryptographic integrity

${open}

I'm building Aethelgard (*ay-thel-gard*), a desktop accounting app built around three constraints: local-first, double-entry, and cryptographically verifiable. I'm looking for technically literate testers who will go beyond clicking buttons and actually stress-test the security and integrity model.

**Specifically, I'd like your opinion on:**
- VaultGuard: PIN-based vault lock — does the access control model feel solid?
- Database encryption at rest: SQLCipher AES-256, Argon2id key derivation, stored in Windows Credential Manager
- Integrity Dashboard: SHA-based tamper detection across all journal entries
- Backup and portability: does the export format give you real data independence?
- Whether the overall privacy claims feel earned, or like marketing

The app is built with Tauri (Rust backend). Data never leaves your machine unless you configure a backup destination yourself.

**Time commitment:** 45 minutes, async, no calls needed unless you want them.

**Download:** ${DOWNLOAD}
**Feedback form:** ${FORM.C}

${KEY_BLOCK(t.key, t.expiryStr)}**What you get:** Lifetime access at launch and the kind of honest feedback loop that most software developers never get.

Cherie`;
}

function emailD(t) {
    const open = t.personal_note
        ? `Hi ${t.name},\n\n${t.personal_note}`
        : `Hi ${t.name},\n\n[MUTUAL CONNECTION] suggested I reach out.`;

    return `Subject: Aethelgard beta — consolidated multi-entity accounting, private referral

${open}

I'm building Aethelgard (*ay-thel-gard*), a desktop accounting app for people managing multiple legal entities who are tired of paying enterprise software prices or hacking together spreadsheets.

Given that you manage [UK Ltd + personal / property + holding / multiple entities], I think you'd be one of the few people who could give genuinely useful feedback on the multi-entity features.

**What the app does:**
- Full double-entry across unlimited entities in a single vault
- Inter-entity reallocation with correct double-entry on both sides
- Group Consolidation Report (IAS 21) across currencies (GBP, EUR, USD, etc.)
- Deferred Tax across entities with different accounting periods
- Period locks and a cryptographic integrity dashboard

Everything runs locally on your machine — no cloud, no subscription, no third-party data access.

**What I'm asking:**
About 75 minutes to set up two or three entities, move a transaction between them, and review the consolidated reports. Written feedback only — no calls unless you'd prefer one.

**Download:** ${DOWNLOAD}
**Feedback form:** ${FORM.D}

${t.tech_savvy ? '' : SMARTSCREEN}${KEY_BLOCK(t.key, t.expiryStr)}**What you get:**
Lifetime access at launch and a direct line to the roadmap for features that actually matter at your scale.

Cherie`;
}

function emailE(t) {
    const open = t.personal_note
        ? `Hi ${t.name},\n\n${t.personal_note}\n\nI wanted to ask for your professional opinion on something I've been building:`
        : `Hi ${t.name},\n\nI came across your profile / work at [AAT / LinkedIn / firm name] and thought you'd be exactly the right person to tell me where it falls short.`;

    return `Subject: Professional feedback requested: Aethelgard double-entry accounting beta

${open}

I'm building Aethelgard (*ay-thel-gard*), a desktop double-entry accounting app aimed at financially sophisticated individuals and small business owners. Before public release, I need a professional eye on whether the accounting model holds up.

**What I'd like you to assess:**
- Journal entry correctness: does debit = credit enforcement behave as expected?
- Chart of Accounts templates: account types and codes for [UK Ltd / NL BV / US LLC]
- Fixed Assets and Depreciation Register: are the calculations and presentation correct?
- Accruals, Accruals Schedule, and Deferred Tax: conceptually sound under FRS 102 / IFRS?
- Hedge Register: consistent with IFRS 9 / FRS 102 Section 12?
- Reports: Trial Balance, Balance Sheet, P&L, AR/AP Aging — standard presentation?

I'm not looking for a polished review. I'm looking for an honest professional opinion — including "this is not how bookkeeping works" if that's what you find.

**Time commitment:** 75 minutes, no calls required.

**Download:** ${DOWNLOAD}
**Feedback form:** ${FORM.E}

${t.tech_savvy ? '' : SMARTSCREEN}${KEY_BLOCK(t.key, t.expiryStr)}**What you get:** Lifetime access at launch. If you find a genuine accounting error, I'll credit you in the release notes.

Cherie`;
}

// ── Design partner outreach templates (no key — initial contact only) ─────────

function emailDpHnw(t) {
    const open = t.personal_note
        ? `Hi ${t.name},\n\n${t.personal_note}`
        : `Hi ${t.name},`;

    return `Subject: Aethelgard — private wealth ledger, founding member access

${open}

I'm building Aethelgard (*ay-thel-gard*) — a local-first private wealth ledger for people managing companies, property, investments, and other complex assets across multiple entities. It keeps everything on your device with no cloud and no telemetry.

I'm looking for a small number of founding design partners who want a more serious alternative to spreadsheets and cloud accounting — people whose financial lives are genuinely complex and who'd be willing to give direct feedback in exchange for a permanent founding member rate.

I have ${FOUNDING_SLOTS_REMAINING} founding member slots remaining at £299/year (full price at launch is £399). Would you be open to a brief conversation about your current setup and whether this might be useful?

If you'd like to apply: ${DP_FORM}

Cherie`;
}

function emailDpAdvisor(t) {
    const open = t.personal_note
        ? `Hi ${t.name},\n\n${t.personal_note}`
        : `Hi ${t.name},`;

    return `Subject: Aethelgard — private wealth ledger for complex client structures

${open}

I'm launching Aethelgard (*ay-thel-gard*) — a private wealth ledger designed to help clients keep a clear, secure record of their full asset picture across entities, jurisdictions, and asset classes. Everything runs locally on the client's machine: no cloud, no telemetry, no third-party data access.

It may be useful for clients who have outgrown spreadsheets or need a better way to centralise complex holdings — particularly for succession planning, multi-entity structures, or IAS 21 / FRS 102 reporting. I'd value your perspective on whether it fills a gap in your client workflows.

I have ${FOUNDING_SLOTS_REMAINING} founding member slots at £299/year (full price at launch: £399). For advisors managing multiple clients, I also have a three-licence bundle at £699/year.

If you'd like to apply or find out more: ${DP_FORM}

Cherie`;
}

const TEMPLATES = {
    A: emailA, B1: emailB1, B2: emailB2, C: emailC, D: emailD, E: emailE,
    DP_HNW: emailDpHnw, DP_ADVISOR: emailDpAdvisor,
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (SECRET === DEV_SECRET) {
        console.warn('⚠️  WARNING: Using dev secret. Set AETHELGARD_LICENSE_SECRET for production keys.\n');
    }

    const testersPath = join(__dir, 'testers.json');
    if (!existsSync(testersPath)) {
        console.error('testers.json not found. Copy testers.json.example to testers.json and fill it in.');
        process.exit(1);
    }

    const testers  = JSON.parse(readFileSync(testersPath, 'utf8'));
    const draftsDir = join(__dir, 'drafts');
    mkdirSync(draftsDir, { recursive: true });

    const summary = [];

    for (const t of testers) {
        const templateFn = TEMPLATES[t.template];
        if (!templateFn) {
            console.warn(`Unknown template "${t.template}" for ${t.name} — skipping.`);
            continue;
        }

        const isDesignPartner = t.template.startsWith('DP_');
        let tester = { ...t };

        if (!isDesignPartner) {
            const { key, expiryDate } = await makeKey(t.tier ?? 'corporate', t.expiry ?? 'lifetime');
            const expiryStr = expiryDate
                ? `expires ${expiryDate.toISOString().slice(0, 10)}`
                : 'Lifetime — never expires';
            tester = { ...tester, key, expiryStr };
        }

        const draft    = templateFn(tester);
        const filename = `${t.template}_${t.name.toLowerCase().replace(/\s+/g, '_')}.txt`;
        writeFileSync(join(draftsDir, filename), draft, 'utf8');

        summary.push({ ...tester, isDesignPartner, file: filename });
        console.log(`✓ ${t.name} (${t.email}) — ${filename}`);
    }

    // Summary table
    console.log('\n── Summary ──────────────────────────────────────────────────────────────────');
    console.log('Name'.padEnd(22), 'Template'.padEnd(12), 'Detail');
    console.log('─'.repeat(80));
    for (const s of summary) {
        const detail = s.isDesignPartner
            ? `Outreach only — no key (${FOUNDING_SLOTS_REMAINING} slots remaining)`
            : `${s.key}  ${s.tech_savvy ? '[SmartScreen omitted]' : ''}`;
        console.log(s.name.padEnd(22), s.template.padEnd(12), detail);
    }
    console.log(`\nDraft emails written to: scripts/drafts/`);
    console.log('Review each file, personalise any [BRACKETED] fields, then send manually.');
}

main().catch(err => { console.error(err); process.exit(1); });
