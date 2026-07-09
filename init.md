# SuperProfile Assignment — "Build Intercom" — Design Spec

Ship a production-ready customer communication platform in 48 hours on Cloudflare.
Stack decisions (locked): **Workers + Hono (TypeScript)** backend, **D1** database, **R2** for blobs,
**React on Cloudflare Pages** frontend, **Durable Objects WebSockets** for real-time,
**Resend** for all outbound email — magic links + agent replies (Cloudflare Email Routing for inbound),
**Workers AI** for LLM features.

---

## 1. Architecture overview

```
super-profile/
├── backend/            # THE Worker: Hono API + WS + email() + serves frontend/dist
│   ├── src/
│   ├── migrations/     # D1 SQL migrations (wrangler d1 migrations)
│   ├── test/           # vitest unit tests
│   └── wrangler.jsonc
├── frontend/           # React + Vite + Tailwind SPA → built to dist/, served by the Worker
│   ├── public/         # widget.js (vanilla loader) + demo.html (verbatim static assets)
│   └── src/            # dashboard, public KB, auth pages, /widget-app (iframe UI)
└── e2e/                # Playwright tests (run against local wrangler dev or prod URL)
```

**One Worker, one origin.** The Worker serves the Hono REST API, WebSocket upgrades, the
`email()` handler, AND the built React SPA via **Workers Static Assets**
(`not_found_handling: "single-page-application"`, `run_worker_first: true` with an explicit
`ASSETS` fallback route in Hono). Same-origin app+API means the SameSite=Strict refresh cookie
works with zero CORS for the dashboard (Pages hosting would have made it a third-party cookie
and silently broken auth — see decision.md). Bindings: **D1** (source of truth), **R2**
(attachments), **Workers AI**, Durable Objects, `ASSETS`, plus secrets.

**Widget embed architecture:** `/widget.js` is a tiny dependency-free vanilla loader (<2KB,
lives in `frontend/public/`) that injects a floating button and lazily creates an **iframe**
pointing to `/widget-app?key=<widgetKey>` (a route of the same React SPA). Iframe = full CSS/JS
isolation on host pages, zero host-page bundle cost until opened, and same-origin API/WS from
inside the iframe. Visitor identity persists in the iframe's localStorage (partitioned per host
site by browsers — per-site persistence, which is correct behavior).

**Durable Objects usage** (used wherever serialization/state helps, D1 stays source of truth):
- `WorkspaceHub` (one per workspace) — WebSocket hub with the **hibernation API**. Dashboard
  agents and widget visitors connect here. All chat message writes flow through it: the DO is
  single-threaded per workspace, so it writes to D1 then broadcasts — that is the
  message-ordering guarantee. Typing indicators and presence live in DO memory only.
- `RateLimiter` — per-key (email / IP) sliding-window counters for the magic-link endpoint and
  widget endpoints. **Enforced only when the hardcoded flag `FLAG.RATE_LIMIT_ENABLED` is true**
  (false during dev/testing; flipping the constant turns it on).
- Magic-link one-time use is enforced in **D1** with an atomic conditional UPDATE (D1 serializes
  writes, so no DO is needed for this).

**Email flow — per-workspace addressing on `inbox.hyugorix.com`:**
- Every workspace gets an inbound address **`<wsSlug>@inbox.hyugorix.com`** (shown in
  Settings → Email). A catch-all on that subdomain hits the Worker; the local part resolves the
  workspace. Threading fallback: outbound replies set
  `Reply-To: <wsSlug>+<conversationId>@inbox.hyugorix.com` (plus-addressing), so replies thread
  deterministically even if a provider rewrites Message-IDs.
- **Inbound transport, in order of preference:** (1) Cloudflare Email Routing subdomain
  catch-all → `email()` handler (`postal-mime` parse); (2) if subdomain routing is
  plan-gated: **Resend Inbound** (MX for inbox.hyugorix.com → Resend, webhook → our endpoint);
  (3) always available: secret-protected `POST /api/v1/email/inbound` simulator. All three
  converge on one `ingestInboundEmail()` function.
- **Thread matching:** plus-address conversationId → else `In-Reply-To`/`References` matched
  against stored `messages.email_message_id` (workspace-scoped) → else new conversation.
- **Outbound** via Resend (`EmailSender` interface): From
  `"<Workspace Name>" <wsSlug@notifications.hyugorix.com>` (any local part on the verified
  domain), our own Message-ID + In-Reply-To/References headers, Reply-To plus-address.
- MX/DNS changes the wrangler token can't make (zone scope is read-only) are done via browser
  automation on the Cloudflare dashboard — **hyugorix.com zone only**.

**AI:** Workers AI, Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), kept as a single
constant `AI.MODEL` (easy swap). Rolling summary: last N messages + previous summary → new
summary, cached in D1 keyed by message count so it only regenerates when the conversation grows,
10s timeout + graceful "summary unavailable" fallback.

**Custom domains: deferred to the morning session (user decision).** Overnight, the feature is
NOT built — only the README documents the approach: Settings page collects `help.theirdomain.com`
→ shows required records (CNAME to the worker hostname + TXT `_sp-verify.<host>` with a token)
→ Verify does a real DNS lookup via DNS-over-HTTPS (`https://cloudflare-dns.com/dns-query`,
`accept: application/dns-json`) → PENDING_DNS/ACTIVE/FAILED; public KB resolves by Host header;
SSL = Cloudflare for SaaS custom hostnames API (stub). The `custom_domains` table exists in the
schema; the morning playbook is plan Task 12. MORNING.md carries the task.

**DNS ground rules:** apex `hyugorix.com` records are never touched (MX → Microsoft 365, the
user's real mail). Only single-level subdomains (`inbox.`, `notifications.`) get records; never
nested subdomains (no Advanced Certificate Manager on the account).

---

## 2. Auth design — magic link + access/refresh tokens

No passwords anywhere. Signup and login are the same flow.

**Magic link flow**
1. `POST /auth/magic-link {email}` → generate a random 256-bit token; store **SHA-256 hash** of it
   in `magic_link_tokens` with `expires_at` (10 min) and `used_at = NULL`; email the raw token as
   a link (`https://app.example.com/auth/verify?token=...`) via Resend.
2. `POST /auth/verify {token}` → hash the token and atomically consume it:
   `UPDATE magic_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
   — exactly-once semantics via D1's serialized writes (`meta.changes === 1` or reject with
   `TOKEN_EXPIRED` / `INVALID_TOKEN`).
3. On success: upsert `users` row by email (first login = signup), then issue **both tokens**.

**Tokens (stateless — no session table, no jti denylist; a denylist would just be sessions again)**
- Both tokens are **HS256** JWTs signed with **different secrets** (`JWT_ACCESS_SECRET` /
  `JWT_REFRESH_SECRET`), so one can never be replayed as the other.
- **Access token**: JWT, 30 min TTL, `{sub: userId}`. Returned in the response body `data`.
  Frontend keeps it **in memory only** (never localStorage/cookies) → XSS cannot exfiltrate a
  durable credential. Sent as `Authorization: Bearer`.
- **Refresh token**: JWT, 30 days TTL. Set as **HttpOnly, Secure,
  SameSite=Strict** cookie, `Path=/api/v1/auth/refresh` — JS can never read it, and it is only
  ever sent to the refresh endpoint → CSRF surface is the refresh endpoint alone, which only
  mints tokens (SameSite=Strict blocks cross-site sends anyway).
- `POST /auth/refresh` (cookie auth) → new access token in body + **rotated** refresh cookie.
- `POST /auth/logout` → clears the cookie (access token just expires).
- CSRF on mutating APIs: they accept **only** the Bearer access token, never cookies → immune to
  classic CSRF by construction.

**Autonomous-testing backdoor (prod-safe):** a `DEBUG_AUTH_SECRET` Worker secret exists; when
`POST /auth/magic-link` carries header `X-Debug-Auth: <that secret>`, the response `data`
additionally includes the raw magic token so automated E2E tests (Playwright) can log in against
local AND deployed environments without a mailbox. The secret is never committed; requests
without the header behave identically to production. Evaluators are unaffected.

**Rate limiting (flag-gated, not enforced by default)**
`/auth/magic-link` limited per **email** (e.g. 3/10 min) and per **IP** (e.g. 10/10 min) via the
`RateLimiter` DO — active only when `FLAG.RATE_LIMIT_ENABLED === true` (hardcoded constant,
default `false` for dev/testing). Same mechanism noted for widget boot + message endpoints.

**Invites** join the same flow: invite email contains an invite-token link; accepting while
logged in (or after magic-link verify) creates the `workspace_members` row.

---

## 3. Response envelope & error handling (fantasy-service conventions)

Only three HTTP statuses: **200** (success), **400** (known/displayable error), **500** (unknown).
Every response body is exactly:

```jsonc
{ "code": "OK",            "msg": "OK",                  "data": {} }   // 200 — code always "OK"
{ "code": "TOKEN_EXPIRED", "msg": "Token expired",       "data": {} }   // 400 — CAPITALIZED_SNAKE_CASE code, msg is user-displayable
{ "code": "UNKNOWN_ERROR", "msg": "Something went wrong","data": {} }   // 500
```

- `data` is **always an object** (`{}` when empty); payloads go inside it.
- Frontend rule: on 400, display `msg` verbatim; on 200, proceed with `data`.
- Implementation mirrors `fantasy-service/src/ctx/ctx.error.ts`: a `CtxError extends Error`
  carrying `{name, msg, data, info}` (`info` = internal-only debug detail, logged, never sent),
  plus a `ctxErr` factory namespace grouped by domain:
  `ctxErr.auth.tokenExpired()`, `ctxErr.auth.invalidToken()`, `ctxErr.user.notFound()`,
  `ctxErr.conversation.notFound()`, `ctxErr.workspace.notMember()`, `ctxErr.general.unknown()`, …
- One Hono `app.onError` middleware: `CtxError` → 400 envelope; anything else → logged + 500
  `UNKNOWN_ERROR`. Zod validation failures → 400 `INVALID_REQUEST_DATA` with a readable `msg`.

**Constants** live in `src/common/const.ts`, fantasy-service style — nested `as const` trees, all
values `UPPERCASE`:

```ts
export const ROLE = { ADMIN: "ADMIN", AGENT: "AGENT" } as const;
export const CHANNEL = { CHAT: "CHAT", EMAIL: "EMAIL" } as const;
export const CONVERSATION = {
  STATUS: { OPEN: "OPEN", SNOOZED: "SNOOZED", RESOLVED: "RESOLVED" },
} as const;
export const MESSAGE = {
  SENDER_TYPE: { CONTACT: "CONTACT", AGENT: "AGENT", SYSTEM: "SYSTEM" },
} as const;
export const ARTICLE = { STATUS: { DRAFT: "DRAFT", PUBLISHED: "PUBLISHED" } } as const;
export const AUTH = {
  ACCESS_TOKEN_TTL_SEC: 30 * 60,
  REFRESH_TOKEN_TTL_SEC: 30 * 24 * 60 * 60,
  MAGIC_LINK_TTL_SEC: 10 * 60,
} as const;
export const AI = { MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } as const;
export const FLAG = { RATE_LIMIT_ENABLED: false } as const;  // hardcoded; flip to enforce
export const RATE_LIMIT = { MAGIC_LINK: { PER_EMAIL: 3, PER_IP: 10, WINDOW_SEC: 600 } } as const;
```

Config mirrors `env.config.ts` but adapted to Workers: a `getConfig(env)` that assembles a typed
`CONFIG` object from Worker bindings/secrets (no `process.env` on Workers).

---

## 4. Database schema (D1)

All tenant tables carry `workspace_id`; every query is scoped by it (tenant isolation).
**All IDs are UUIDv7** (time-ordered — doubles as a stable sort key).
**All enum-ish values are UPPERCASE** and mirrored in `const.ts`.

**Identity model — everyone is a `users` row, created at first touch.** A "user" is simply a
person: agent, widget visitor, or email sender. The **backend is the only id minter** (UUIDv7).

- **Widget visitor (first boot)**: the widget may propose an id; the backend accepts it only if
  it doesn't exist in `users`, otherwise it mints a fresh UUIDv7. Either way it **inserts a
  `users` row immediately** (`email = NULL`) and returns the id — **the widget always persists
  whatever the backend returns**. Later boots send that id back and get history.
- **Verified email = one global identity.** Inbound email and magic-link login both
  **upsert `users` by email** — proving you receive mail at an address always resolves to the
  same `users` row, no matter how many workspaces you contact. (An email typed into the widget
  is *unverified*: it's stored on the contact for display only and never claims a `users` row.)
- **Roles are just relationships**: an "agent" is a user with a `workspace_members` row; a
  "customer" is a user with a `contacts` row. Same person can be both.

```sql
users               id, email UNIQUE NULL, name, last_seen_at, created_at
                    -- every person, created at first touch; email NULL = anonymous visitor
                    -- email set only via verified flows (magic link / inbound mail)

workspaces          id, name, slug UNIQUE, widget_key UNIQUE, widget_color,
                    support_email, created_by, created_at

workspace_members   workspace_id, user_id, role CHECK(role IN ('ADMIN','AGENT')),
                    created_at, PRIMARY KEY (workspace_id, user_id)
                    -- a user can create/join multiple workspaces

magic_link_tokens   id, email, token_hash UNIQUE, expires_at, used_at NULL, created_at
                    -- one-time use via atomic conditional UPDATE

invites             id, workspace_id, email, role, token_hash UNIQUE, expires_at,
                    accepted_at NULL, created_by, created_at

contacts            id, workspace_id, user_id REFERENCES users(id),
                    email NULL, name NULL, last_seen_at, created_at
                    UNIQUE(workspace_id, user_id), UNIQUE(workspace_id, email)
                    -- a user's profile *within* a workspace; one users row, N contacts
                    -- (one per workspace they've contacted); real FK — users always exists

conversations       id, workspace_id, contact_id,
                    channel CHECK(channel IN ('CHAT','EMAIL')),
                    status CHECK(status IN ('OPEN','SNOOZED','RESOLVED')) DEFAULT 'OPEN',
                    assignee_id NULL, subject NULL, snoozed_until NULL,
                    last_message_at, ai_summary NULL, ai_summary_msg_count DEFAULT 0,
                    contact_last_read_at, agent_last_read_at, created_at, updated_at
                    INDEX (workspace_id, status, last_message_at DESC)

messages            id, conversation_id, workspace_id,
                    sender_type CHECK(sender_type IN ('CONTACT','AGENT','SYSTEM')),
                    sender_id NULL, body_text, body_html NULL,   -- body_html: inbound email only
                    email_message_id NULL,      -- Message-ID header (in/outbound)
                    email_in_reply_to NULL, created_at
                    INDEX (conversation_id, id), INDEX (workspace_id, email_message_id)

attachments         id, message_id, workspace_id, r2_key, filename, content_type, size

kb_collections      id, workspace_id, name, slug, description, position
                    UNIQUE(workspace_id, slug)

kb_articles         id, workspace_id, collection_id, title, slug,
                    body_md,                    -- MARKDOWN source of truth, rendered client-side
                    body_text,                  -- stripped plaintext for FTS
                    status CHECK(status IN ('DRAFT','PUBLISHED')), created_by,
                    published_at, created_at, updated_at
                    UNIQUE(workspace_id, slug)

kb_articles_fts     FTS5(title, body_text)      -- powers public search + widget auto-suggest
                    -- separate migration; if D1 rejects FTS5, searchArticles() falls back to LIKE

custom_domains      id, workspace_id, hostname UNIQUE, verification_token,
                    status CHECK(status IN ('PENDING_DNS','ACTIVE','FAILED')),
                    ssl_status DEFAULT 'STUBBED', verified_at NULL, created_at

canned_responses    id, workspace_id, title, body, tags, created_by, created_at  -- stretch
```

Read receipts are the two `*_last_read_at` watermarks on `conversations` (one row update per read,
not per message). Email threading lives in `messages.email_message_id` / `email_in_reply_to`.

---

## 5. Backend modules

| Module | Responsibility |
|---|---|
| `auth` | magic-link issue/verify (one-time, hashed, TTL), access/refresh JWTs, refresh rotation, logout, invite accept |
| `team` | member list, invites, role changes, removal (ADMIN-only) |
| `workspaces` | create (multiple per user), list mine, settings; membership+role middleware |
| `conversations` | unified inbox queries (filter by channel/status/assignee), assign/snooze/resolve, message CRUD, read watermarks |
| `realtime` | `WorkspaceHub` DO — WS auth, hibernation, ordered write+broadcast, typing/presence, reconnect protocol. **Contact isolation rule: widget sockets receive events ONLY for conversations whose contact user_id matches their token; agent sockets get workspace-wide events.** |
| `domains` | custom-domain lite — connect, DoH TXT verification, Host-header KB resolution, SSL stub |
| `ratelimit` | `RateLimiter` DO + middleware, active only behind `FLAG.RATE_LIMIT_ENABLED` |
| `widget` | public widget endpoints — widget session tokens (signed), conversation history, KB suggest; serves `widget.js` and the demo page |
| `email` | inbound parse + thread matching, outbound `EmailSender` (Resend impl + stub), magic-link mails, simulator endpoint |
| `kb` | admin CRUD for collections/articles (markdown), publish flow, public KB endpoints, FTS search |
| `ai` | rolling summarization, prompt templates, timeout/fallback, (stretch: reply drafts) |
| `common` / `config` | `const.ts` (fantasy-style constant trees), `ctx.error.ts`-style `ctxErr` factories, response envelope helper, `getConfig(env)`, zod schemas, UUIDv7, structured logging |

Frontend modules: `auth` (email entry + verify landing, in-memory access token + silent refresh),
`inbox` (list + conversation pane + composer), `kb-admin` (markdown editor with preview),
`kb-public` (markdown-rendered help center), `settings` (workspaces, team, widget install
snippet), plus the separate `widget` package.

**Widget UX — ticket-style (à la Bylon / Rentomojo):** opening the bubble shows the
**conversation list** (each item titled by its subject or first-message snippet, with last
message preview + unread dot), not a single chat. Tapping an item opens that conversation's
messages; a **"New conversation"** button starts a fresh ticket for a new topic. First screen
also hosts the KB auto-suggest search. State machine: `home (list + search)` → `conversation`
→ back to `home`; if the visitor has no conversations yet, `home` shows the composer directly.

---

## 6. API contract

All under `/api/v1`. Every response uses the `{code, msg, data}` envelope (§3).
Workspace-scoped routes live under `/api/v1/ws/:wsId/...` — middleware verifies membership
(and role where marked ADMIN).

### Auth (public)
```
POST   /auth/magic-link            {email}                  → {} (always 200 to avoid email enumeration)
POST   /auth/verify                {token}                  → data: {accessToken, user}  + refresh cookie
POST   /auth/refresh               (refresh cookie)         → data: {accessToken}        + rotated cookie
POST   /auth/logout                                         → clears cookie
GET    /auth/me                    (Bearer)                 → data: {user, workspaces: [{id, name, role}]}
POST   /auth/invite-accept         {token}   (Bearer)       → data: {workspace}
```

### Workspaces (Bearer)
```
POST   /workspaces                 {name}                   → creates + ADMIN membership (multiple allowed)
GET    /workspaces                                          → my workspaces + roles
PATCH  /ws/:wsId                   {name?, widgetColor?, supportEmail?}   (ADMIN)
```

### Team (Bearer, workspace-scoped)
```
POST   /ws/:wsId/invites           {email, role}            (ADMIN)  → sends invite email
GET    /ws/:wsId/invites                                    (ADMIN)
DELETE /ws/:wsId/invites/:id                                (ADMIN)
GET    /ws/:wsId/members
PATCH  /ws/:wsId/members/:userId   {role}                   (ADMIN)
DELETE /ws/:wsId/members/:userId                            (ADMIN)
```

### Inbox (Bearer, workspace-scoped)
```
GET    /ws/:wsId/conversations              ?channel=&status=&assigneeId=&cursor=
GET    /ws/:wsId/conversations/:id
GET    /ws/:wsId/conversations/:id/messages ?cursor=&afterId=   (afterId = reconnect catch-up)
POST   /ws/:wsId/conversations/:id/messages {body}          → CHAT: DO broadcast; EMAIL: send via Resend
PATCH  /ws/:wsId/conversations/:id          {status?, assigneeId?, snoozedUntil?}
POST   /ws/:wsId/conversations/:id/read
GET    /ws/:wsId/conversations/:id/summary                  → data: {summary, generatedAt} | AI_UNAVAILABLE
POST   /ws/:wsId/conversations/:id/draft-reply              (stretch)
CRUD   /ws/:wsId/canned-responses                           (stretch)
```

### Knowledge base (Bearer, workspace-scoped; articles are markdown)
```
CRUD   /ws/:wsId/kb/collections
CRUD   /ws/:wsId/kb/articles                {title, collectionId, bodyMd, ...}
POST   /ws/:wsId/kb/articles/:id/publish
```

### Knowledge base (public, no auth)
```
GET    /public/kb/:wsSlug                                   → collections + published articles
GET    /public/kb/:wsSlug/articles/:slug                    → data: {article: {..., bodyMd}}  (client renders md)
GET    /public/kb/:wsSlug/search            ?q=             → FTS5
```

### Widget (public, signed widget token; CORS *)
```
POST   /widget/boot                {widgetKey, userId?, email?, name?}
                                   → data: {userId, token, contact, conversations}
                                   -- userId echoed back if free, else a fresh UUIDv7;
                                   -- widget always persists the returned userId
GET    /widget/conversations/:id/messages
POST   /widget/conversations       {body}                   → creates conversation + first message
POST   /widget/conversations/:id/messages {body}
GET    /widget/suggest             ?q=                      → top-3 published KB articles (FTS)
GET    /widget.js  ·  GET /demo                             → bundle + demo page
```

### Real-time (WS → WorkspaceHub DO)
```
WS /ws-connect/dashboard?token=<accessToken>   ·   WS /ws-connect/widget?token=<widgetToken>
server → client: MESSAGE_CREATED · TYPING {START|STOP} · PRESENCE {ONLINE|OFFLINE}
                 READ_RECEIPT · CONVERSATION_UPDATED (assign/status changes)
client → server: TYPING, READ; everything else flows through REST → DO
```

### Custom domains (Bearer, workspace-scoped, ADMIN)
```
POST   /ws/:wsId/domains           {hostname}   → data: {records: {cname, txtName, txtValue}, domain}
POST   /ws/:wsId/domains/:id/verify             → real DoH TXT check → ACTIVE | FAILED
DELETE /ws/:wsId/domains/:id
GET    /ws/:wsId/domains
```

### Email
```
POST   /api/v1/email/inbound       (X-Inbound-Secret header; simulator + Resend-Inbound webhook target)
email() worker handler             (Cloudflare Email Routing catch-all on inbox.hyugorix.com)
Inbound address per workspace:     <wsSlug>@inbox.hyugorix.com
Reply-To on outbound:              <wsSlug>+<conversationId>@inbox.hyugorix.com
```

---

## 7. Scope decisions

**Stretch features planned:** canned responses, AI draft replies (cheap once `ai` + inbox exist).

**Lite (working demo + documented stub):** custom domains — real DoH DNS verification and
Host-header KB resolution; SSL provisioning stubbed with the Cloudflare-for-SaaS approach in the
README.

**Skipped (documented in README, not built):** webhooks / REST API keys, SLA tracking,
analytics dashboard, contact page-visit tracking, R2 attachment UI if time runs out
(table + R2 binding exist).

**Conversation behavior rules:** SNOOZED conversations flip back to OPEN lazily once
`snoozed_until` passes (computed at read time — no cron); any new CONTACT message on a
SNOOZED/RESOLVED conversation reopens it to OPEN with a SYSTEM message. Subject for CHAT
conversations = first message truncated to 80 chars; for EMAIL = the mail subject.

**Flag-gated:** rate limiting (`FLAG.RATE_LIMIT_ENABLED`, hardcoded, default `false`).

**Requires user action (prepared, activated later):**
- Resend account + domain DKIM verification → until then, `EmailSender` stub logs sends
  (magic-link URLs also logged so login works in dev without email).
- Cloudflare Email Routing on a real domain → until then, use `POST /email/inbound` simulator.
