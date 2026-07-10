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
- [ ] **NEW OPTION — real inbound email without touching the apex:** the overnight notes said
      Resend has no inbound feature on your account — **that's wrong, it exists** (Resend
      dashboard → Emails → Receiving → "set up a custom domain"). That's the safe pattern
      MORNING.md hoped for: MX record on `inbox.hyugorix.com` only (single-level subdomain,
      allowed by your DNS ground rules; apex/M365 untouched) + a Resend webhook pointed at our
      existing `POST /api/v1/email/inbound` (the payload normalizer for Resend's shape is already
      in the code). ~15 min together, and feature 3's transport becomes fully live. Your call —
      it's a DNS change on your domain, so I didn't touch it.

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
- Prod URL: https://super-profile.kaushikrb909.workers.dev
- Demo page (widget): https://super-profile.kaushikrb909.workers.dev/demo.html
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
- [ ] `[seeded]` **Deliverability sanity check:** send yourself a magic link from the prod login
      page to a *fresh* address (not previously emailed) and confirm it lands in Inbox, not
      spam. If spam: add a DMARC TXT record for hyugorix.com (`v=DMARC1; p=none`) in Cloudflare
      DNS — 2 minutes, helps a lot. (Partial evidence tonight: a real magic link to
      kaushikrb909@gmail.com — not a fresh address, but not the debug backdoor either — landed
      in the primary Inbox within about a minute, not spam. Worth a true fresh-address check
      before submitting since a previously-emailed address doesn't fully rule out filtering.)
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
      confirmed working via Gmail), I noticed two Resend notification emails in your inbox at
      4:27 AM and 4:33 AM: "You have reached 80%/100% of your daily quota for the team
      kaushikrb909." Every send I made *after* that (4:44 AM magic link, 4:49 AM reply) still
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
