# MORNING.md — for Kaushik

Things that need your hands or your judgment. The overnight run appends here; items marked
`[seeded]` were known before you slept.

## Morning review (Fable) — read this first

A full review of the overnight build is done: every backend module read, the deployed app
exercised live in Chrome, 12 real issues found, fixed, and re-verified against prod (all tests
green, everything committed/pushed). Details in decision.md #22. The three things you asked about:

- **"Lots of Resend emails" — explained and stopped.** Not a product bug: every overnight test
  run sent a *real* magic-link email to its fake `...@example.com` test address (the debug-auth
  path echoed the token but still sent the email). Dozens of sends burned the ~100/day quota —
  that's what the 4:27/4:33 AM quota notices were. Fixed: `X-Debug-Auth` requests now skip the
  send entirely, so test runs cost **zero** emails (confirmed: a full prod e2e run adds nothing
  to the Resend log). Real user flows are unchanged. The stuck "Delivery Delayed" sends to
  example.com will expire/bounce on their own; no action needed, quota resets daily.
- **Your mailboxes:** Gmail delivery was proven overnight (magic link + reply, SPF/DKIM/DMARC
  pass, landed in Inbox). I deliberately did NOT send test emails to kaushik@/support@hyugorix.com
  to conserve quota — if you want the Outlook check, one magic-link login from the prod page to
  kaushik@hyugorix.com does it (1 email).
- [ ] **DECISION — real inbound email transport (you asked me to "just add the MX records";
      I couldn't, here's why + your options).** I investigated all the way to the paywall/risk
      and made **zero changes** to anything (no DNS, no Resend config, no purchase):
      - **Resend Receiving (the clean path, on your own `inbox.hyugorix.com`)** requires the
        **Resend Pro plan — $20/mo**. Your free plan allows only 1 domain, already used by
        `notifications.hyugorix.com` for sending. Adding `inbox.hyugorix.com` as a second
        (receiving) domain is gated behind Pro. I won't spend your money without your say-so. If
        you upgrade, I can do the rest (~30 min): add the receiving domain, give you the exact MX
        record to paste into Cloudflare DNS, and add Resend webhook-signature verification to our
        `/api/v1/email/inbound` (Resend webhooks can't send our `X-Inbound-Secret` header, so the
        endpoint needs that small change — noted so it's not a surprise).
      - **Cloudflare Email Routing (free)** would deliver straight to our Worker's existing
        `email()` handler (cleanest — no webhook, no secret). BUT the overnight investigation
        (decision #13) found its setup targets the **apex MX = your real Microsoft 365 mail**, the
        one thing we agreed never to touch. I did not attempt it. Separately, the browser
        automation now blocks me from opening `dash.cloudflare.com` at all, so I couldn't even
        re-verify whether a subdomain-only MX is possible — that exploration would have to be you,
        at the Cloudflare dashboard, and only if you can confirm it won't disturb the apex.
      - **Do nothing (recommended for the assignment):** the simulator is a fully honest,
        fully-tested transport stub. The entire inbound *engineering* — parsing, threading,
        dedup, real outbound replies with correct headers — is built and proven; only the
        physical "how mail reaches the Worker" leg is stubbed, which the assignment explicitly
        permits. For a hiring submission this is defensible as-is; I wouldn't spend $20/mo or risk
        your real email for a demo. **My recommendation: leave it, unless you specifically want
        live inbound — then pick Resend Pro and tell me to proceed.**

Also fixed in the review, evaluator-visible (full list in decision.md #22): a login race that
made the first API call after every magic-link sign-in transiently fail (this was the real cause
of the "flaky tests" the overnight notes blamed on timing); invite links being permanently burned
if clicked while signed into the wrong account; a 500 when a widget visitor and an email sender
share the same address; a WebSocket hole letting one visitor fake typing/read-receipts on another
visitor's conversation; conversations showing "unread" right after you reply; the widget
promising "share your name or email" with no input fields; missed-message catch-up after
reconnects; inbound email dedup for webhook retries.

## Status snapshot
<!-- The overnight run keeps this section current: what's deployed, URLs, what's green/red -->
- Prod URL: https://sp.hyugorix.com
- Demo page (widget): https://sp.hyugorix.com/demo.html
- Inbound email address pattern: `<workspace-slug>@inbox.hyugorix.com`
- **FINAL STATUS: Tasks 0–10 and 13 complete, all 7 required assignment features built,
  deployed, and verified against prod with real evidence (see the acceptance matrix in
  `docs/superpowers/plans/2026-07-10-super-profile-implementation.md` Task 13, all boxes ticked).
  Task 11 (stretch: canned responses + AI drafts) deliberately skipped per its own
  pre-authorized fallback clause (decision #18). Task 12 (custom domains) deliberately deferred
  to this morning per your explicit decision before sleeping — README documents the full
  approach, schema is ready, morning playbook is Task 12 in the plan.**
- README.md is written at the repo root — read it first, it's the evaluator's front door.
- `git log` has one commit per task tonight; `decision.md` has 21 numbered entries covering every
  autonomous call made, including two real bugs found and fixed during Task 13's own
  verification pass (a D1 batch counting bug, #19; a missing widget-key UI, #20) and one honest
  limitation (screenshots not embedded as files, #21).

## Actions for you

- [ ] `[seeded]` **Custom domains feature (deferred by you):** we build it together in the
      morning — the ready playbook is Task 12 in
      `docs/superpowers/plans/2026-07-10-super-profile-implementation.md` (connect UI + real
      DoH TXT verification + Host-header KB resolution; SSL stays a documented
      Cloudflare-for-SaaS stub). ~1.5h. The README already explains the approach, so the
      submission is defensible even if we run out of time.
- [ ] `[seeded]` **Optional — pretty support address:** in M365 admin, set shared mailbox
      `support@hyugorix.com` to forward to `<your-workspace-slug>@inbox.hyugorix.com`.
      Microsoft blocks external forwarding by default: Security (Defender) → Policies →
      Anti-spam → Outbound policy → set *Automatic forwarding* to "On – Forwarding is enabled",
      then Exchange admin → shared mailbox → Manage mail flow settings → forwarding.
      If skipped, hand evaluators the `...@inbox.hyugorix.com` address directly — fully fine.
- [ ] `[seeded]` **Decide rate limiting for submission:** currently
      `FLAG.RATE_LIMIT_ENABLED = false` (your call for testing). To enforce before submitting,
      flip the constant in `backend/src/common/const.ts` and redeploy — limits are generous
      (won't trip evaluators).
- [x] **Custom domain — DONE.** App is live at **https://sp.hyugorix.com** (display name stays
      "SuperProfile"); the API is also aliased at **https://api-sp.hyugorix.com** (same Worker).
      Both are Workers Custom Domains provisioned by `wrangler deploy` (auto DNS + TLS), both
      single-level subdomains, apex untouched. `APP_URL` now points at `sp.hyugorix.com` so magic
      links use it. The old `*.workers.dev` URL is now disabled (wrangler's default once a custom
      domain exists) — if you want it back as a fallback, say so and I'll add `"workers_dev": true`
      to `wrangler.jsonc`. README/e2e/docs all updated to the new URL.
- [ ] **DMARC — exact change for you to make (removes your Gmail, points reports at support@).**
      A *strong* DMARC record already exists on `hyugorix.com` (`p=reject`, strict alignment — it's
      why app mail lands in Inbox, not spam; the overnight "add p=none" note was wrong). Its report
      address currently points at your personal Gmail. To move reports to support@hyugorix.com and
      drop the Gmail, edit the single TXT record at `_dmarc.hyugorix.com` in Cloudflare DNS to
      exactly this value (I can't write DNS — the browser tool blocks the Cloudflare dashboard):
      `v=DMARC1; p=reject; rua=mailto:support@hyugorix.com; ruf=mailto:support@hyugorix.com; sp=reject; adkim=s; aspf=s; pct=100`
      Steps: Cloudflare → hyugorix.com → DNS → Records → find the TXT record named `_dmarc` → Edit →
      replace the content with the line above → Save. Leave `p=reject`/`sp=reject` as-is (they work).
      Delivery-neutral — it only changes where daily reports land; your mail keeps flowing.
- [ ] `[seeded]` **Deliverability sanity check (optional):** magic link to a *fresh* address, or
      the Outlook `kaushik@hyugorix.com` check (1 email). Gmail already confirmed landing in Inbox.
- [ ] `[seeded]` **Optional:** Linear project "super profile" — Linear MCP needs re-auth
      (`/mcp` → linear-personal → authenticate) if you still want issues mirrored there.

## Known limitations / accepted risks (also going into README)

- Magic-link-only login means evaluator email deliverability is the single point of failure for
  first impressions — mitigation above.
- Anonymous widget identity is bearer-style (knowing a userId = that visitor's chats on that
  site). Same as Intercom without Identity Verification; HMAC identity verification is the
  documented production fix.

<!-- Overnight entries append below -->

- [ ] **Real inbound email transport (Task 6):** the email channel is fully built and verified
      (inbound ingestion, threading via plus-address + In-Reply-To/References, real outbound
      Resend send confirmed in your Gmail with correct headers) but the *transport* — how a real
      email physically reaches the Worker — is still the simulator endpoint
      (`POST /api/v1/email/inbound` + `X-Inbound-Secret`), not live. Two options, both need your
      go-ahead because they touch DNS on your real domain:
      1. **Cloudflare Email Routing** (dash.cloudflare.com → hyugorix.com → Email Routing) — you
         already have 5 routing rules configured (support@/info@/help@/company@/kaushik@ → your
         Gmail) but the feature is Disabled/DNS-not-configured. Enabling it adds/changes MX
         records **at the zone apex** (`hyugorix.com`) — there's no dashboard option to scope it
         to only `inbox.hyugorix.com`. This would sit alongside (and could conflict with) your
         real Microsoft 365 MX. Do this only if you're comfortable reviewing exactly what
         Cloudflare proposes to change before confirming.
      2. **Resend Inbound** — checked the Resend dashboard; no Receiving/Inbound tab exists in
         your account (feature not enabled/available there). Would need Resend to expose it, or
         a different inbound-email provider that supports subdomain-scoped MX (the safe pattern —
         doesn't touch the apex).
      If you don't want to touch DNS before submitting, the simulator is a fully honest,
      fully-tested demo path — decision.md #13 has the details evaluators/you can read.

- [ ] **Check Resend's daily send quota before the evaluation window.** While verifying real
      email delivery tonight (magic link + a real inbound→reply→threaded-reply round trip, all
      confirmed working via the inbox), I noticed two Resend notification emails in your inbox at
      4:27 AM and 4:33 AM: "You have reached 80%/100% of your daily quota for the account."
      Every send I made *after* that (4:44 AM magic link, 4:49 AM reply) still
      went through fine, so whatever the quota is didn't actually block anything tonight — but
      it's worth a 2-minute check of the Resend dashboard's usage/plan page before evaluators
      start testing, in case a free-tier daily cap could bite at the wrong moment during their
      session. If it's close to plan limits, either upgrading or just being aware of the reset
      time would avoid a confusing "magic link never arrived" report.
- [x] **AI summaries (Task 10) — done.** Rolling WANTS/TRIED/STATUS summary via Workers AI,
      cached, 10s-timeout fallback, verified with a real generated summary against prod (see
      decision #17). Flag-gated rate limiting (magic-link + widget) also built and verified
      (temporarily enabled locally to confirm enforcement actually works, then reverted).
- [x] **Knowledge base (Task 9) — done.** Markdown editor, FTS5 search, public site, widget
      auto-suggest, all verified against prod (see decision #16).
- [x] **Widget install UX gap found and fixed (Task 13).** There was no way to find your own
      widget key anywhere in the dashboard UI — caught while walking the evaluator quick-start
      flow myself. Settings now has an "Install the widget" section with the script tag, a copy
      button, and quick links to the demo page and public KB (decision #20).
