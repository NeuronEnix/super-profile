# MORNING.md — for Kaushik

Things that need your hands or your judgment. The overnight run appends here; items marked
`[seeded]` were known before you slept.

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
