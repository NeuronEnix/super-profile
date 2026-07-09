# super-profile — Intercom clone on Cloudflare (48h hiring assignment)

**READ FIRST, IN ORDER:** `init.md` (full design spec) →
`docs/superpowers/plans/2026-07-10-super-profile-implementation.md` (task plan + execution
protocol) → `decision.md` (decisions already made — do not relitigate).

## Mission

Ship a production-ready customer communication platform (live chat widget + email channel +
unified inbox + KB + AI summaries) for the SuperProfile Staff Engineer assignment. It must be
**deployed and testable by evaluators** ("If it's not deployed, it's an automatic no").
Priorities when trading off: **deployed & working > core-feature correctness > security >
stretch features > visual polish**.

## Operating mode (overnight autonomous run)

- The user (Kaushik) is asleep. **Never ask questions; never wait for input.** When facing a
  genuine dilemma: pick the option that best serves the priorities above, and append an entry to
  `decision.md` (format: Context / Options / Chosen / Why). Anything requiring the user's hands
  goes to `MORNING.md`.
- Work on `main`. Commit after every green step (small, descriptive commits — the evaluator
  reads the history). Push to `origin` (github.com/NeuronEnix/super-profile) after every task.
- After each phase: deploy (`cd backend && npx wrangler deploy`) and verify against prod.
- Update plan checkboxes (`- [x]`) in the plan file as steps complete — progress must survive
  session loss.
- If a command hangs waiting for input, kill it and re-run non-interactively (`--yes`, `CI=true`
  env, or pre-answer with `printf 'y\n' |`).

## Environment & accounts (verified working)

| Thing | Value |
|---|---|
| Cloudflare account (pinned in wrangler.jsonc) | `5c06421b792bba8d18c35d4d575c0b71` (kaushikrb909@gmail.com) |
| Wrangler | `npx wrangler` (v4.110+, OAuth already logged in; scopes: workers/d1/r2/ai/pages/email_routing/email_sending write, zone READ-ONLY) |
| Zones on the account | `hyugorix.com` (OURS to use), `kaushikrb.com` (**do not touch**) |
| Outbound email | Resend; API key in `.env` at repo root (`RESEND_API_KEY`); verified sending domain `notifications.hyugorix.com` |
| Inbound email | `inbox.hyugorix.com` → per-workspace `<wsSlug>@inbox.hyugorix.com` (see init.md email section; simulator endpoint always works) |
| GitHub | `gh` authed as NeuronEnix; remote `origin` exists |
| LLM | Workers AI binding, model const `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — no API key |
| Browser automation | claude-in-chrome MCP (user's real Chrome, logged into Gmail/Outlook/Cloudflare/Resend) — load via ToolSearch; if disconnected, use chrome-devtools-mcp (isolated) or Playwright |
| DNS writes | wrangler token CANNOT write DNS. Use browser automation on dash.cloudflare.com (hyugorix.com only), else note in MORNING.md |
| DNS ground rules | NEVER touch apex hyugorix.com records (MX = Microsoft 365, user's real email). Single-level subdomains only (`inbox.`, `notifications.`); NEVER nested subdomains (no Advanced Certificate Manager) |
| Custom domains feature | DEFERRED overnight (user decision) — README approach only; plan Task 12 is the morning playbook |

## Secrets (names are contract — set via `wrangler secret put`, local in `backend/.dev.vars`)

`RESEND_API_KEY` (from `.env`), `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`WIDGET_TOKEN_SECRET`, `EMAIL_INBOUND_SECRET`, `DEBUG_AUTH_SECRET` (generate the last five with
`openssl rand -hex 32`; store a copy in `.env` too so they survive session loss — `.env` is
gitignored). NEVER commit secrets; never echo them into git-tracked files.

## Hard conventions (user's explicit requirements — violating these = wrong)

- **Response envelope**: every API response is HTTP **200, 400, or 500 only**, body exactly
  `{code, msg, data}`; `data` always an object (`{}` if empty). 200 → `code:"OK", msg:"OK"`.
  400 → `code` is CAPITALIZED_SNAKE_CASE, `msg` is user-displayable. 500 →
  `UNKNOWN_ERROR`/"Something went wrong". Frontend displays `msg` verbatim on 400.
- **Errors**: `CtxError extends Error` with `{name, msg, data, info}` (`info` = internal only,
  logged never sent) + `ctxErr.<domain>.<factory>()` namespace (mirrors user's fantasy-service
  `ctx.error.ts`). One Hono `onError` maps CtxError→400, ZodError→400 INVALID_REQUEST_DATA,
  everything else→500.
- **Constants**: nested `as const` trees in `backend/src/common/const.ts`, values UPPERCASE
  (`ROLE.ADMIN`, `CHANNEL.CHAT`, `CONVERSATION.STATUS.OPEN`...). All enum-ish DB values
  UPPERCASE. Config via `getConfig(env)` in `src/config/env.config.ts` (no process.env).
- **IDs**: UUIDv7 everywhere (own util, no dep). **Auth**: magic-link only (no passwords, no
  sessions table, no jti denylist — stateless by design). Access JWT 30 min (in-memory on FE),
  refresh JWT 30 days (HttpOnly SameSite=Strict cookie, Path=/api/v1/auth/refresh, rotated).
  HS256, separate secrets. **Rate limiting**: exists but `FLAG.RATE_LIMIT_ENABLED=false`.
- **KB**: markdown source of truth (`body_md`), rendered with marked + DOMPurify.
- TypeScript everywhere; Hono on the backend (normal Hono routing); React+Vite+Tailwind SPA
  served by the Worker (NOT Pages); widget = vanilla loader + same-origin iframe.

## Commands

```bash
# local dev (build assets first — no vite dev server needed)
pnpm --dir frontend build && cd backend && npx wrangler dev          # http://localhost:8787
# db
cd backend && npx wrangler d1 migrations apply super-profile --local --yes   # or --remote
# deploy (builds nothing — always build frontend first)
pnpm --dir frontend build && cd backend && npx wrangler deploy
# tests
cd backend && pnpm test                       # vitest unit
cd e2e && BASE_URL=http://localhost:8787 pnpm test   # Playwright (BASE_URL=prod URL for smoke)
```

## Verification protocol (before claiming anything works)

Evidence before assertions: run the command, read the output. UI features: verify in a real
browser (Playwright or chrome MCP) — click it, see it. Realtime: two browser contexts
(widget + dashboard) exchanging messages. Email: simulator round-trip + at least one real Resend
send (check via Resend API `GET /emails/{id}`). Deployed = re-run the E2E smoke against the
prod URL after deploy. The final task in the plan has the full acceptance matrix mapping to the
assignment's 7 required features.
