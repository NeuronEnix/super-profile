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
├── backend/            # Hono on Workers — API + WebSockets + Email handler
│   ├── src/
│   ├── migrations/     # D1 SQL migrations (wrangler d1 migrations)
│   └── wrangler.jsonc
├── frontend/           # React + Vite + Tailwind → Cloudflare Pages
│   └── src/            # dashboard, public KB site, auth pages
└── widget/             # embeddable chat widget — Preact, single ~25KB bundle
    └── src/            # served by the Worker at /widget.js + demo.html
```

**One Worker** does everything: the Hono REST API, WebSocket upgrades, and the `email()` handler
for inbound mail. Bindings: **D1** (source of truth), **R2** (email/chat attachments),
**Workers AI** (summaries), Durable Object classes, plus secrets (`RESEND_API_KEY`, JWT secrets).

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

**Email flow:** Cloudflare Email Routing → `email()` handler → parse with `postal-mime` →
thread-match via `In-Reply-To`/`References` against stored `Message-ID`s
(fallback: `reply+<conversationId>@domain` plus-addressing) → insert into D1 → notify DO.
Outbound via Resend with our own `Message-ID` and correct `In-Reply-To` headers, behind a small
`EmailSender` interface. A secret-protected `POST /email/inbound` simulator endpoint allows
end-to-end threading tests before Email Routing is configured.

**AI:** Workers AI, Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), kept as a single
constant `AI.MODEL` (easy swap). Rolling summary: last N messages + previous summary → new
summary, cached in D1 keyed by message count so it only regenerates when the conversation grows,
10s timeout + graceful "summary unavailable" fallback.

**Custom domains: skipped** (per decision). The approach (DoH DNS verification + Cloudflare for
SaaS custom hostnames for SSL) is documented in the README only; no table, no API, no UI.

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

**Identity model — one global `user_id` for everyone.** Every person (agent, widget visitor,
email sender) is identified by a single global UUIDv7, allocated at **first touch**:

- **Widget visitor**: on first boot the widget proposes a client-generated id (or none). The
  backend checks it against **both** `users.id` and `contacts.user_id`; if unused it is accepted,
  otherwise (or if absent) the backend mints a fresh UUIDv7. **The frontend always persists
  whatever id the backend returns** (localStorage). On later boots the same id comes back with
  the contact's conversation history.
- **Email sender**: first inbound email allocates a `user_id` for that contact the same way.
- **Login/membership**: when a person authenticates via magic link and has no `users` row yet,
  we adopt their pre-allocated identity — `users.id` is created **equal to** the existing
  `contacts.user_id` matched by email (if any, and not already taken) — so all existing
  conversations/contact rows keep pointing at the same person. No id migration ever.

```sql
users               id, email UNIQUE, name, last_seen_at, created_at
                    -- global identity; no password; belongs to N workspaces
                    -- id may be pre-allocated by a contact identity (see above)

workspaces          id, name, slug UNIQUE, widget_key UNIQUE, widget_color,
                    support_email, created_by, created_at

workspace_members   workspace_id, user_id, role CHECK(role IN ('ADMIN','AGENT')),
                    created_at, PRIMARY KEY (workspace_id, user_id)
                    -- a user can create/join multiple workspaces

magic_link_tokens   id, email, token_hash UNIQUE, expires_at, used_at NULL, created_at
                    -- one-time use via atomic conditional UPDATE

invites             id, workspace_id, email, role, token_hash UNIQUE, expires_at,
                    accepted_at NULL, created_by, created_at

contacts            id, workspace_id, user_id,   -- global identity UUIDv7 (no anon_id column)
                    email NULL, name NULL, last_seen_at, created_at
                    UNIQUE(workspace_id, user_id), UNIQUE(workspace_id, email)
                    -- user_id is NOT an FK: the users row may not exist yet (anonymous visitor)

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
| `realtime` | `WorkspaceHub` DO — WS auth, hibernation, ordered write+broadcast, typing/presence, reconnect protocol |
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

### Email
```
POST   /email/inbound              (secret header; simulates Email Routing for testing)
email() worker handler             (real inbound once Email Routing is configured)
```

---

## 7. Scope decisions

**Stretch features planned:** canned responses, AI draft replies (cheap once `ai` + inbox exist).

**Skipped (documented in README, not built):** custom domains (approach: DoH DNS verification +
Cloudflare for SaaS for SSL), webhooks / REST API keys, SLA tracking, analytics dashboard,
contact page-visit tracking.

**Flag-gated:** rate limiting (`FLAG.RATE_LIMIT_ENABLED`, hardcoded, default `false`).

**Requires user action (prepared, activated later):**
- Resend account + domain DKIM verification → until then, `EmailSender` stub logs sends
  (magic-link URLs also logged so login works in dev without email).
- Cloudflare Email Routing on a real domain → until then, use `POST /email/inbound` simulator.
