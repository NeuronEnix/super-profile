# MORNING.md — for Kaushik

Things that need your hands or your judgment. The overnight run appends here; items marked
`[seeded]` were known before you slept.

## Status snapshot
<!-- The overnight run keeps this section current: what's deployed, URLs, what's green/red -->
- Prod URL: _(filled in after first deploy)_
- Demo page (widget): _(prod URL)/demo_
- Inbound email address pattern: `<workspace-slug>@inbox.hyugorix.com`

## Actions for you

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
      DNS — 2 minutes, helps a lot.
- [ ] `[seeded]` **Optional:** Linear project "super profile" — Linear MCP needs re-auth
      (`/mcp` → linear-personal → authenticate) if you still want issues mirrored there.

## Known limitations / accepted risks (also going into README)

- Magic-link-only login means evaluator email deliverability is the single point of failure for
  first impressions — mitigation above.
- Anonymous widget identity is bearer-style (knowing a userId = that visitor's chats on that
  site). Same as Intercom without Identity Verification; HMAC identity verification is the
  documented production fix.

<!-- Overnight entries append below -->
