# super-profile Implementation Plan

> **For agentic workers:** This plan is designed for inline execution in a `/loop`
> (superpowers:executing-plans style). Steps use checkbox (`- [ ]`) syntax — **mark them `[x]`
> in this file as you complete them and commit the plan file with your changes** so progress
> survives session loss. superpowers:subagent-driven-development may be used for isolated
> parallelizable tasks, but default to inline execution.

**Goal:** Ship the Intercom-clone described in `init.md`, deployed on Cloudflare, all 7 required
features working, by morning.

**Architecture:** One Worker (Hono API + WorkspaceHub DO + email handler + static assets serving
the React SPA). D1 = source of truth, R2 = attachments, Workers AI = summaries. See `init.md`
for the full spec — it is the contract; this plan is the route. Read `CLAUDE.md` for environment,
conventions, and operating mode.

**Tech stack (pin these):** hono ^4, zod ^3, postal-mime ^2 (backend); react ^19, react-dom ^19,
react-router ^7, @tanstack/react-query ^5, marked ^15, dompurify ^3, tailwindcss ^4 +
@tailwindcss/vite, vite ^7 (frontend); @playwright/test ^1 (e2e); vitest ^3 (backend unit).
pnpm. No other runtime deps without a decision.md entry.

## Global constraints (every task inherits these)

- Envelope/error/constants conventions exactly as CLAUDE.md "Hard conventions". HTTP 200/400/500 only.
- All enum values UPPERCASE; all IDs UUIDv7 via `src/common/id.ts`; timestamps = epoch **ms** INTEGER in DB, ISO strings in API responses; DB snake_case, API camelCase.
- Every D1 query on tenant tables includes `workspace_id = ?` even when derivable via join.
- Commit after every green step; push after every task; deploy after every phase-completing task.
- Never commit secrets. Never touch the kaushikrb.com zone.
- **DNS rules:** never modify apex `hyugorix.com` records (MX is Microsoft 365 — the user's real email). Only create records under single-level subdomains (`inbox.hyugorix.com`, `notifications.hyugorix.com`). NEVER create nested subdomains (`*.x.hyugorix.com`) — no Advanced Certificate Manager on this account (irrelevant for MX-only names, but the rule is absolute).
- **Execution protocol per task:** read the task → do steps in order → run the verification commands and READ the output → tick checkboxes in this file → `git add -A && git commit` → push. If blocked >45 min on one step, take the task's Fallback, log it in decision.md, move on.

---

### Task 0: Scaffold, D1, wrangler config, hello-envelope deploy

**Files:**
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/wrangler.jsonc`,
  `backend/src/index.ts`, `backend/.dev.vars`, `backend/migrations/0001_init.sql`,
  `frontend/` (Vite React TS scaffold), `frontend/public/widget.js` (placeholder),
  `frontend/public/demo.html` (placeholder), `e2e/package.json`, `e2e/playwright.config.ts`

**Interfaces produced:** deployed Worker URL (record it in MORNING.md "Status snapshot");
D1 database `super-profile` with full schema; `Env` type in `backend/src/types.ts`:

```ts
export type Env = {
  DB: D1Database; AI: Ai; ASSETS: Fetcher; ATTACHMENTS: R2Bucket;
  WORKSPACE_HUB: DurableObjectNamespace; RATE_LIMITER: DurableObjectNamespace;
  APP_URL: string; INBOUND_DOMAIN: string; SEND_DOMAIN: string; ENVIRONMENT: string;
  RESEND_API_KEY: string; JWT_ACCESS_SECRET: string; JWT_REFRESH_SECRET: string;
  WIDGET_TOKEN_SECRET: string; EMAIL_INBOUND_SECRET: string; DEBUG_AUTH_SECRET: string;
};
```

- [x] **0.1 Scaffold packages**: `pnpm create vite frontend --template react-ts`; add tailwind v4 (`pnpm --dir frontend add -D tailwindcss @tailwindcss/vite`, add `@tailwindcss/vite` plugin to `vite.config.ts`, `@import "tailwindcss";` at top of `src/index.css`). `mkdir backend e2e`; `pnpm --dir backend init` + `pnpm --dir backend add hono zod postal-mime && pnpm --dir backend add -D typescript vitest @cloudflare/workers-types wrangler`; `pnpm --dir e2e init && pnpm --dir e2e add -D @playwright/test && pnpm --dir e2e exec playwright install chromium`.
- [x] **0.2 wrangler.jsonc** (backend/) — exact content, fill `database_id` after 0.3:

```jsonc
{
  "name": "super-profile",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "account_id": "5c06421b792bba8d18c35d4d575c0b71",
  "observability": { "enabled": true },
  "assets": { "directory": "../frontend/dist", "binding": "ASSETS",
              "not_found_handling": "single-page-application", "run_worker_first": true },
  "d1_databases": [{ "binding": "DB", "database_name": "super-profile", "database_id": "FILL_ME" }],
  "durable_objects": { "bindings": [
    { "name": "WORKSPACE_HUB", "class_name": "WorkspaceHub" },
    { "name": "RATE_LIMITER", "class_name": "RateLimiter" }
  ]},
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["WorkspaceHub", "RateLimiter"] }],
  "ai": { "binding": "AI" },
  "r2_buckets": [{ "binding": "ATTACHMENTS", "bucket_name": "super-profile-attachments" }],
  "vars": { "APP_URL": "FILL_AFTER_FIRST_DEPLOY", "INBOUND_DOMAIN": "inbox.hyugorix.com",
            "SEND_DOMAIN": "notifications.hyugorix.com", "ENVIRONMENT": "prod" }
}
```

(`new_sqlite_classes` is mandatory — classic DO storage is paid-only. Placeholder DO classes in 0.5 so deploy succeeds.)

- [x] **0.3 Create cloud resources**: `cd backend && npx wrangler d1 create super-profile` (paste id into wrangler.jsonc) and `npx wrangler r2 bucket create super-profile-attachments`.
- [x] **0.4 Migration 0001_init.sql** — full DDL, exact:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT,
  last_seen_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  widget_key TEXT NOT NULL UNIQUE, widget_color TEXT NOT NULL DEFAULT '#4f46e5',
  created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('ADMIN','AGENT')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE invites (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('ADMIN','AGENT')),
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
  accepted_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE contacts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT, name TEXT, last_seen_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, user_id), UNIQUE (workspace_id, email)
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  channel TEXT NOT NULL CHECK (channel IN ('CHAT','EMAIL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SNOOZED','RESOLVED')),
  assignee_id TEXT REFERENCES users(id), subject TEXT, snoozed_until INTEGER,
  last_message_at INTEGER NOT NULL, last_message_preview TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  ai_summary TEXT, ai_summary_msg_count INTEGER NOT NULL DEFAULT 0,
  contact_last_read_at INTEGER, agent_last_read_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_conv_inbox ON conversations (workspace_id, status, last_message_at DESC);
CREATE INDEX idx_conv_contact ON conversations (workspace_id, contact_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('CONTACT','AGENT','SYSTEM')),
  sender_id TEXT, body_text TEXT NOT NULL, body_html TEXT,
  email_message_id TEXT, email_in_reply_to TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_msg_conv ON messages (conversation_id, id);
CREATE INDEX idx_msg_email_mid ON messages (workspace_id, email_message_id);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
  workspace_id TEXT NOT NULL, r2_key TEXT NOT NULL, filename TEXT NOT NULL,
  content_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE kb_collections (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, slug)
);
CREATE TABLE kb_articles (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  collection_id TEXT REFERENCES kb_collections(id),
  title TEXT NOT NULL, slug TEXT NOT NULL, body_md TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  created_by TEXT NOT NULL, published_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, slug)
);
CREATE TABLE custom_domains (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  hostname TEXT NOT NULL UNIQUE, verification_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_DNS' CHECK (status IN ('PENDING_DNS','ACTIVE','FAILED')),
  ssl_status TEXT NOT NULL DEFAULT 'STUBBED', verified_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE canned_responses (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
```

Apply: `npx wrangler d1 migrations apply super-profile --local --yes` then `--remote --yes` (if `--yes` unsupported, `printf 'y\n' |`). Expected: all statements executed.

- [x] **0.5 Hello worker** — `src/index.ts`: Hono app; placeholder `export class WorkspaceHub { constructor(state: DurableObjectState, env: Env) {} async fetch() { return new Response('ok'); } }` and same for `RateLimiter`; route `GET /api/v1/health` → `{code:"OK",msg:"OK",data:{ts}}`; catch-all `app.all('*', c => c.env.ASSETS.fetch(c.req.raw))`. `pnpm --dir frontend build`, `npx wrangler dev` → curl health + `/` returns SPA html.
- [x] **0.6 Secrets**: generate `openssl rand -hex 32` ×5 → append to root `.env` (JWT_ACCESS_SECRET etc.); write all six into `backend/.dev.vars`; `npx wrangler secret put <NAME>` ×6 (pipe values: `printf '%s' "$VAL" | npx wrangler secret put NAME`).
- [x] **0.7 Deploy + record URL**: `npx wrangler deploy` → note `https://super-profile.<sub>.workers.dev`, set `APP_URL` var in wrangler.jsonc, redeploy, update MORNING.md snapshot. Curl prod `/api/v1/health`.
- [x] **0.8 Commit + push** (`feat: scaffold worker, d1 schema, deploy skeleton`).

**Fallback:** R2 create fails → drop the binding from config, note in decision.md (attachments are stretch).

---

### Task 1: Common infra — const, config, id, errors, envelope, validation, logging

**Files:** Create `backend/src/common/const.ts`, `src/common/id.ts`, `src/ctx/ctx.error.ts`,
`src/common/envelope.ts`, `src/config/env.config.ts`, `src/middleware/validate.ts`,
`src/middleware/logger.ts`; Test `backend/test/{id,error,envelope}.test.ts`.

**Interfaces produced (used by every later task):**
- `uuidv7(): string` · `sha256Hex(s: string): Promise<string>` · `now(): number` (Date.now)
- `CtxError` + `ctxErr.<domain>.<factory>(e?: {msg?, data?, info?})` with domains/factories:
  `general.unknown|notFound|invalidRequestData` · `auth.invalidToken|tokenExpired|expiredAccessToken|invalidAccessToken|notAuthorized|invalidRefreshToken` ·
  `workspace.notFound|notMember|adminRequired|slugTaken` · `user.notFound` ·
  `invite.notFound|expired` · `conversation.notFound` · `kb.collectionNotFound|articleNotFound|slugTaken` ·
  `widget.invalidKey|invalidToken` · `email.sendFailed|invalidInbound` · `ai.unavailable` ·
  `domain.notFound|verificationFailed` · `rateLimit.exceeded`
- `ok(c, data?)` → 200 envelope. `registerErrorHandler(app)` → onError mapping CtxError→400 `{code:name,msg,data}`, ZodError→400 INVALID_REQUEST_DATA (first issue path+message as msg), else console.error(info)→500 UNKNOWN_ERROR.
- `getConfig(env: Env)` → typed CONFIG (APP_URL, domains, secrets, ENVIRONMENT).
- `validate(schema, source: 'json'|'query'|'param')` Hono middleware → `c.get('body')` typed.
- `logger` middleware: one JSON line/request `{reqId, method, path, status, ms}`; `c.set('reqId', uuidv7())`.
- const.ts (exact starter — extend, never rename):

```ts
export const ROLE = { ADMIN: "ADMIN", AGENT: "AGENT" } as const;
export const CHANNEL = { CHAT: "CHAT", EMAIL: "EMAIL" } as const;
export const CONVERSATION = { STATUS: { OPEN: "OPEN", SNOOZED: "SNOOZED", RESOLVED: "RESOLVED" } } as const;
export const MESSAGE = { SENDER_TYPE: { CONTACT: "CONTACT", AGENT: "AGENT", SYSTEM: "SYSTEM" } } as const;
export const ARTICLE = { STATUS: { DRAFT: "DRAFT", PUBLISHED: "PUBLISHED" } } as const;
export const DOMAIN = { STATUS: { PENDING_DNS: "PENDING_DNS", ACTIVE: "ACTIVE", FAILED: "FAILED" } } as const;
export const AUTH = { ACCESS_TOKEN_TTL_SEC: 30 * 60, REFRESH_TOKEN_TTL_SEC: 30 * 24 * 3600,
  MAGIC_LINK_TTL_SEC: 10 * 60, INVITE_TTL_SEC: 7 * 24 * 3600, WIDGET_TOKEN_TTL_SEC: 7 * 24 * 3600,
  REFRESH_COOKIE: "sp_refresh", REFRESH_COOKIE_PATH: "/api/v1/auth/refresh" } as const;
export const AI_CONF = { MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  SUMMARY_WINDOW: 30, TIMEOUT_MS: 10_000, MAX_TOKENS: 300 } as const;
export const FLAG = { RATE_LIMIT_ENABLED: false } as const;
export const RATE_LIMIT = { MAGIC_LINK: { PER_EMAIL: 3, PER_IP: 10, WINDOW_SEC: 600 },
  WIDGET_MSG: { PER_USER: 60, WINDOW_SEC: 60 } } as const;
export const WS_EVENT = { MESSAGE_CREATED: "MESSAGE_CREATED", TYPING: "TYPING", PRESENCE: "PRESENCE",
  READ_RECEIPT: "READ_RECEIPT", CONVERSATION_UPDATED: "CONVERSATION_UPDATED", PONG: "PONG" } as const;
```

- uuidv7 (exact):

```ts
export function uuidv7(): string {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  const t = BigInt(Date.now());
  b[0]=Number(t>>40n&255n); b[1]=Number(t>>32n&255n); b[2]=Number(t>>24n&255n);
  b[3]=Number(t>>16n&255n); b[4]=Number(t>>8n&255n); b[5]=Number(t&255n);
  b[6]=(b[6]&0x0f)|0x70; b[8]=(b[8]&0x3f)|0x80;
  const h=[...b].map(x=>x.toString(16).padStart(2,"0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
```

- [x] Write vitest tests first (uuidv7 format regex + 1000 ids sortable-by-time & unique; ctxErr factory returns CtxError with name/msg/data; envelope shapes incl. ZodError mapping via a fake context or exported pure mapper) → red → implement → green.
- [x] Wire logger+error handler into index.ts; curl a bogus route → 400 NOT_FOUND envelope (add explicit `app.notFound` → `ctxErr.general.notFound`).
- [x] Commit + push (`feat: envelope, ctxErr, constants, config, logging`).

---

### Task 2: Auth — magic link, JWTs, refresh rotation, middleware

**Files:** Create `backend/src/auth/auth.api.ts`, `src/auth/token.ts`, `src/auth/magic.ts`,
`src/email/sender.ts`, `src/middleware/auth.ts`; Test `test/token.test.ts`, `test/magic.test.ts` (pure parts).

**Interfaces produced:**
- `signAccessToken(env, userId): Promise<string>` / `verifyAccessToken(env, jwt): Promise<{sub:string}>` (hono/jwt, HS256, exp; verify throws `ctxErr.auth.expiredAccessToken()` on exp, `invalidAccessToken()` otherwise). Same pair for refresh + widget tokens (widget payload `{sub, ws, kind:"CONTACT"}`).
- `authMiddleware` → validates Bearer → `c.set("userId")`. `wsMiddleware` (mounted at `/api/v1/ws/:wsId/*`) → membership lookup → `c.set("member", {role, workspaceId})` or `ctxErr.workspace.notMember()`. `requireAdmin`.
- `EmailSender` interface `{ send(m: {from, to, subject, html, text, headers?, replyTo?}): Promise<{id: string|null}> }`; `resendSender(apiKey)` (POST api.resend.com/emails; non-2xx → `ctxErr.email.sendFailed({info})`) and `logSender` (console.log link/dev). Factory `getSender(env)`: RESEND_API_KEY present ? resend : log.
- Endpoints (public): `POST /api/v1/auth/magic-link {email}` — always 200 `{}`; creates users-less token row (`token = crypto.randomUUID()+crypto.randomUUID()` no dashes, store sha256Hex, TTL 10 min); sends email "Sign in to SuperProfile" with link `${APP_URL}/auth/verify?token=...`; **if header `X-Debug-Auth` equals `env.DEBUG_AUTH_SECRET`, include `{debugToken: raw}` in data**. Rate-limit hooks (Task 10) wrap this.
  `POST /auth/verify {token}` — atomic consume:

```ts
const res = await db.prepare(
  "UPDATE magic_link_tokens SET used_at=?1 WHERE token_hash=?2 AND used_at IS NULL AND expires_at>?1"
).bind(now(), hash).run();
if (res.meta.changes !== 1) {
  const row = await db.prepare("SELECT expires_at, used_at FROM magic_link_tokens WHERE token_hash=?1").bind(hash).first();
  throw !row ? ctxErr.auth.invalidToken() : ctxErr.auth.tokenExpired();
}
```

  then upsert user by email (SELECT → INSERT `{id: uuidv7()}` if missing), return `data:{accessToken, user}` + set refresh cookie (HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth/refresh; Max-Age 30d).
  `POST /auth/refresh` — read cookie, verify refresh JWT (`ctxErr.auth.invalidRefreshToken()` on any failure), return new access + rotate cookie. `POST /auth/logout` — clear cookie. `GET /auth/me` (Bearer) — `{user, workspaces:[{id,name,slug,role}]}`.
- [x] TDD the pure parts (token sign/verify roundtrip + expiry with fake time offsets; consume-SQL builder). Implement, wire routes.
- [x] Verify by curl against `wrangler dev`: magic-link with X-Debug-Auth → verify → me → refresh (cookie jar `curl -c/-b`) → each envelope correct; wrong token → 400 INVALID_TOKEN; reused token → 400 TOKEN_EXPIRED.
- [x] Commit + push (`feat: magic-link auth with access/refresh tokens`).

---

### Task 3: Workspaces, team, invites

**Files:** Create `backend/src/workspaces/workspaces.api.ts`, `src/team/team.api.ts`; extend auth for invite accept.

**Interfaces produced:** endpoints per init.md §6 (workspaces create/list/patch; invites CRUD; members list/patch/delete). Workspace create: slug = slugify(name) + `-xxxx` suffix on collision; `widget_key = "wk_" + uuidv7 (no dashes)`; creator gets ADMIN membership row (same D1 batch). Invite: token like magic link (store hash), email via sender with link `${APP_URL}/invite?token=...`; `POST /auth/invite-accept {token}` (Bearer) consumes (same atomic pattern, TTL 7d) → upsert membership with invite role → `{workspace}`. Rules: PATCH/DELETE members = ADMIN only; cannot demote/remove the last ADMIN (400 `NOT_AUTHORIZED` with msg "Workspace needs at least one admin"); invite to email already a member → 400 (`workspace.slugTaken` NO — add `ctxErr.invite.alreadyMember` factory, msg "Already a member").

- [x] Implement + curl-verify the full flow with two debug users (A creates ws, invites B's email, B accepts, B listed as member, role change, removal guard).
- [x] Commit + push (`feat: workspaces, team management, invites`).

---

### Task 4: Conversations core + WorkspaceHub DO write path (no WS yet)

**Files:** Create `backend/src/realtime/hub.ts` (WorkspaceHub), `src/conversations/conversations.api.ts`, `src/conversations/service.ts`; Test `test/conv-helpers.test.ts`.

**Interfaces produced:**
- **DO write path (the ordering guarantee — ALL message inserts go through here):** Worker calls `env.WORKSPACE_HUB.idFromName(workspaceId)` → `stub.fetch("https://do/message", {method:"POST", body: JSON.stringify(MessageIn)})`.

```ts
type MessageIn = {
  workspaceId: string;
  conversationId?: string;                 // omit with newConversation set
  newConversation?: { contactId: string; channel: "CHAT"|"EMAIL"; subject: string|null };
  senderType: "CONTACT"|"AGENT"|"SYSTEM"; senderId: string|null;
  bodyText: string; bodyHtml?: string|null;
  emailMessageId?: string|null; emailInReplyTo?: string|null;
};
type MessageOut = { conversation: ConversationRow; message: MessageRow };
```

  Inside the DO (single-threaded per workspace): create conversation row if `newConversation` (subject: CHAT → first 80 chars of bodyText); INSERT message; UPDATE conversation `last_message_at, last_message_preview (120 chars), message_count+1, updated_at`; **reopen rule**: if senderType=CONTACT and status != OPEN → status=OPEN + also INSERT SYSTEM message "Conversation reopened"; return MessageOut. (Task 5 adds `broadcast(out)` at the end — leave a `this.broadcast?.()` hook now.)
- `GET /ws/:wsId/conversations?channel=&status=&assigneeId=&cursor=&limit=25` — keyset pagination on `(last_message_at, id)` DESC, cursor = base64 of both; **snooze lazy-flip**: before SELECT, run `UPDATE conversations SET status='OPEN', snoozed_until=NULL, updated_at=?1 WHERE workspace_id=?2 AND status='SNOOZED' AND snoozed_until<?1`. Each item: conversation + contact {id,name,email} + unread flag (`agent_last_read_at < last_message_at`).
- `GET .../conversations/:id` (with contact detail) · `GET .../conversations/:id/messages?cursor=&afterId=` (ASC by id; afterId = everything newer, for reconnect catch-up) · `POST .../conversations/:id/messages {body}` → DO (senderType AGENT) [+ Task 6 email side-effect] · `PATCH .../conversations/:id {status?, assigneeId?, snoozedUntil?}` — validates assignee is a member; writes D1 in Worker; INSERT SYSTEM message via DO ("Assigned to X" / "Snoozed until Y" / "Resolved" / "Reopened") which also broadcasts · `POST .../read` → set agent_last_read_at (via DO `/read` route so Task 5 can broadcast receipts).
- Widget public endpoints: `POST /api/v1/widget/boot {widgetKey, userId?, email?, name?}` → workspace by widget_key (`ctxErr.widget.invalidKey`); resolve identity per init.md (users row exists+contact exists → returning; users exists w/o contact → create contact; unknown/absent proposed id → mint fresh users row `email:null`); returns `{userId, token (widget JWT), contact, conversations:[...listing shape...]}`. `GET /api/v1/widget/conversations/:id/messages?afterId=` + `POST /api/v1/widget/conversations {body}` + `POST /api/v1/widget/conversations/:id/messages {body}` + `POST /api/v1/widget/conversations/:id/read` — all require widget token; **every query double-checks conversation.contact.user_id === token.sub** (`ctxErr.conversation.notFound` otherwise, no oracle).
- [x] Unit-test pure helpers (cursor encode/decode, preview truncation, reopen decision fn). Implement DO + routes; curl-verify: boot → create conv → agent list shows it (filters work) → agent reply → widget messages show both → patch assign/resolve → SYSTEM messages present → snooze with past `snoozedUntil` flips OPEN on next list.
- [x] Commit + push (`feat: conversations, DO-serialized message writes, widget REST`).

---

### Task 5: Realtime WS (hibernation) — typing, presence, receipts, live messages

**Files:** Modify `backend/src/realtime/hub.ts`; create `src/realtime/ws.api.ts`.

**Interfaces produced:**
- Upgrade routes (Worker validates BEFORE forwarding to DO): `GET /ws-connect/dashboard?wsId=&token=<accessJWT>` → verify + membership; `GET /ws-connect/widget?token=<widgetJWT>`. Forward to DO `/connect` with headers `x-kind: AGENT|CONTACT`, `x-user-id`, then return `stub.fetch(req)` (must pass the original Request for upgrade).
- DO uses **hibernation API**: `this.state.acceptWebSocket(ws)` + `ws.serializeAttachment({kind, userId})`; handlers `webSocketMessage/webSocketClose`. In-memory `convContact: Map<conversationId, contactUserId>` (fill on message writes; lazy D1 lookup on miss — survives hibernation wake).
- Client→server JSON: `{type:"TYPING", conversationId, state:"START"|"STOP"}` · `{type:"READ", conversationId}` · `{type:"PING"}`.
- Server→client events (all envelope-free raw JSON): `MESSAGE_CREATED {conversation, message}` · `TYPING {conversationId, from:"AGENT"|"CONTACT", state}` · `PRESENCE {agentsOnline}` · `READ_RECEIPT {conversationId, by, at}` · `CONVERSATION_UPDATED {conversation}` · `PONG`.
- **Routing rule (security-critical):** AGENT sockets receive everything for the workspace. CONTACT sockets receive an event ONLY if `event.conversation.contactUserId === attachment.userId` (typing/read: look up via convContact map). TYPING from a contact goes to agents only; from an agent goes to that conversation's contact only.
- READ handling in DO: update the right watermark column in D1, broadcast READ_RECEIPT.
- PRESENCE: broadcast `{agentsOnline: count of AGENT sockets}` on every AGENT open/close.
- `broadcast()` hook from Task 4 now sends MESSAGE_CREATED per routing rule; PATCH conversation flows emit CONVERSATION_UPDATED.
- [x] Verify with `wrangler dev` + a Node script in `e2e/scripts/ws-check.mjs` (two WebSocket clients: agent + widget token): message POST → both receive MESSAGE_CREATED; typing relays; second widget user for another contact does NOT receive the first contact's events (assert isolation!); read → receipt.
- [x] Commit + push (`feat: realtime websockets with hibernation, typing/presence/receipts`).

**Fallback:** hibernation API misbehaving in local dev → standard `new WebSocketPair()` handlers (document in decision.md; hibernation is a cost optimization, not a feature gate).

---

### Task 6: Email channel — ingest, threading, outbound replies, transport setup

**Files:** Create `backend/src/email/inbound.ts`, `src/email/outbound.ts`, `src/email/email.api.ts`; modify `src/index.ts` (export `email` handler), `src/conversations/conversations.api.ts` (EMAIL reply side-effect); Test `test/threading.test.ts`, `test/address.test.ts`.

**Interfaces produced:**
- `parseInboundAddress(to: string, inboundDomain: string): {wsSlug: string, conversationId: string|null} | null` — handles `slug@`, `slug+convId@`, case-insensitive, ignores other domains.
- `ingestInboundEmail(env, parsed: {to, from, fromName, subject, messageId, inReplyTo, references: string[], text, html}): Promise<MessageOut|null>` — resolve workspace by slug (null → log+drop); upsert user by email + contact; conversation = plus-address convId (validated against workspace) → else header match `SELECT conversation_id FROM messages WHERE workspace_id=? AND email_message_id IN (inReplyTo, ...references) LIMIT 1` → else new EMAIL conversation (subject = mail subject stripped of Re:/Fwd:); through DO with `source` senderType CONTACT + emailMessageId/emailInReplyTo stored.
- Three entry points converge on it: **(a)** `email(message, env, ctx)` Worker handler — `PostalMime.parse(message.raw)`; **(b)** `POST /api/v1/email/inbound` with header `X-Inbound-Secret: env.EMAIL_INBOUND_SECRET` accepting BOTH our simulator JSON `{to, from, subject, messageId?, inReplyTo?, references?, text}` AND Resend-Inbound webhook shape (detect by body keys; map accordingly); **(c)** none else.
- Outbound (EMAIL-channel agent reply in POST messages route): after DO persist, `ctx.waitUntil(sendReply(...))` where sendReply builds: from `"${ws.name}" <${ws.slug}@${env.SEND_DOMAIN}>`, to contact.email, subject `Re: ${conversation.subject}`, replyTo `${ws.slug}+${conversationId}@${env.INBOUND_DOMAIN}`, headers `{"Message-ID": "<m-${message.id}@${env.SEND_DOMAIN}>", "In-Reply-To": lastInboundMessageId, "References": chain (≤10)}`; store our Message-ID on the message row (UPDATE after send); on send failure: INSERT SYSTEM message "⚠ Email delivery failed" via DO.
- [x] TDD `parseInboundAddress` + threading matcher (pure fn taking header values + a lookup callback) — cover: plus-address wins; In-Reply-To match; References fallback; no match → null; Re:-stripping.
- [x] Wire + verify via simulator against local: new mail → conversation EMAIL appears; agent reply (logSender locally prints payload — assert headers in output); simulated customer reply with `In-Reply-To: <m-...>` AND separately with only the plus-address To: → both land in same conversation.
- [x] **Transport setup (remote):** try `npx wrangler email routing ...` / Cloudflare API for Email Routing on hyugorix.com with subdomain `inbox` catch-all → this Worker. If CLI/API can't (scope/plan), use browser automation on dash.cloudflare.com (Email Routing product, hyugorix.com zone only). If subdomain routing is plan-gated: configure **Resend Inbound** instead (Resend dashboard via browser → Receiving → add inbox.hyugorix.com, webhook `${APP_URL}/api/v1/email/inbound` — include the X-Inbound-Secret header if Resend supports custom headers; otherwise verify Resend webhook signature `svix-*` headers with the signing secret, store it as an extra Worker secret) + add the MX records Resend shows via Cloudflare dashboard browser automation. Whatever lands, END-TO-END TEST: send a real email from Resend (`from onboarding@resend.dev` is fine) or via the user's Gmail through browser automation to `<slug>@inbox.hyugorix.com` → conversation appears in prod. If everything is blocked: simulator stays the demo path; write exact remaining clicks in MORNING.md.
- [x] Deploy; real outbound check: reply from prod dashboard to a conversation whose contact email = kaushikrb909@gmail.com; confirm via Resend API `GET https://api.resend.com/emails/{id}` status + via browser in Gmail.
- [x] Commit + push (`feat: email channel with threading and per-workspace inbound addresses`).

---

### Task 7: Frontend foundation — api client, auth, shell

**Files:** Create in `frontend/src/`: `lib/api.ts`, `lib/types.ts`, `auth/AuthContext.tsx`,
`pages/Login.tsx`, `pages/Verify.tsx`, `pages/InviteAccept.tsx`, `App.tsx` (router),
`components/Shell.tsx` (sidebar: Inbox, Knowledge Base, Settings; workspace switcher; user menu).

**Interfaces produced:**
- `api<T>(path, {method, body, accessTokenRef}): Promise<T>` — unwraps envelope; non-"OK" → throws `ApiError {code, msg}`; on `EXPIRED_ACCESS_TOKEN`/`INVALID_ACCESS_TOKEN` → one `POST /api/v1/auth/refresh` (credentials:"include") then retry once, else redirect /login. **Access token in a module-level ref only — never storage.** Toast component renders any ApiError.msg verbatim (user rule).
- AuthContext: `{user, workspaces, activeWs, accessToken}`; boot = try refresh → me. Routes: `/login` (email → "check your inbox" state), `/auth/verify` (reads ?token → POST verify → store token in memory → navigate), `/invite` (needs login → accept → switch ws), `/w/:wsId/*` (protected, Shell), `/kb/:wsSlug/*` (public, Task 9), `/widget-app` (Task 8, no Shell).
- Design: load `frontend-design:frontend-design` skill for this task + Tasks 8–9 UI. Direction: clean neutral SaaS (Linear-meets-Intercom); Tailwind, system font stack + `Inter` via @fontsource? NO external fonts needed — system stack; slate/indigo palette (widget_color accent); 13–14px dense UI; generous empty states.
- [x] Build → wrangler dev → Playwright `e2e/tests/auth.spec.ts`: login via debug header (request magic-link with `X-Debug-Auth` from env `DEBUG_AUTH_SECRET`, then drive /auth/verify?token=...), assert dashboard shell renders with workspace name; logout works.
- [x] Commit + push (`feat: frontend shell, auth flow, api client with silent refresh`).

---

### Task 8: Inbox UI + Widget (loader, iframe app, demo) + realtime wiring

**Files:** Create `frontend/src/inbox/{InboxPage,ConversationList,ConversationView,Composer,ContactPanel,SummaryPanel}.tsx`, `frontend/src/lib/ws.ts` (reconnecting socket hook: exp backoff 1s→30s + `afterId` catch-up fetch on reopen), `frontend/src/widget/{WidgetApp,TicketList,TicketView,NewTicket}.tsx`, `frontend/public/widget.js`, `frontend/public/demo.html`; `e2e/tests/chat.spec.ts`.

**Behavior (acceptance):**
- Inbox: filter tabs (All/Chat/Email × Open/Snoozed/Resolved + assignee dropdown incl. "Me"/"Unassigned"); rows: contact name/email, subject, preview, relative time, channel icon, unread dot; live reorder on MESSAGE_CREATED. ConversationView: message bubbles (CONTACT left, AGENT right, SYSTEM centered subtle), grouped timestamps, "Seen" under last agent message when contact_last_read_at ≥ its created_at; typing indicator line; header actions: assign (member dropdown), snooze (1h/tomorrow/next week), resolve/reopen; presence dot in header. Composer: textarea, Enter=send Shift+Enter=newline, canned-response picker (Task 11, placeholder now), sends typing START/STOP (debounced 2s).
- `widget.js` (vanilla, exact behavior): reads `data-widget-key` off its own `<script>`; injects fixed bottom-right 56px round button (bg = widget_color fetched lazily? NO — default indigo, real color inside iframe); on first click creates iframe `${origin}/widget-app?key=<key>` 380×580 rounded panel (100% width on mobile <480px), toggles open/close; postMessage `sp:unread` from iframe → badge count on button.
- `/widget-app`: boots via `POST /widget/boot` with localStorage `sp_uid` (+ persists returned userId); **ticket-style home** (user requirement): conversation list w/ subject+preview+unread, "New conversation" button, KB search box (Task 9 wires suggest; input present now); TicketView = chat thread + composer + agent typing + "Delivered/Seen"; NewTicket = optional name/email fields (if contact has none) + first message → creates conversation. WS connect with widget token; reconnect logic shared hook.
- `demo.html`: standalone page ("Acme Corp — demo store" hero) + the ONE script tag `<script src="/widget.js" data-widget-key="INJECTED_AT_TEST"></script>` — plus a note it works on any site. (Playwright injects a real key via query param handling in demo.html: tiny inline script copies `?key=` into the script tag before load — keep demo self-configuring: if `?key=` present use it, else placeholder text with instructions.)
- [x] Playwright `chat.spec.ts`: context A opens `/demo?key=<real>` → new ticket "My order is broken" → context B logs into dashboard → sees conversation, replies → A receives live (no reload, assert within 5s); A types → B sees typing indicator; B assigns+resolves → A's ticket shows Resolved; A sends again → reopens OPEN in B's list.
- [x] Deploy + run chat.spec against prod URL. Update MORNING.md snapshot with /demo link.
- [x] Commit + push (`feat: unified inbox UI and embeddable ticket-style chat widget`).

---

### Task 9: Knowledge base — admin CRUD, markdown editor, public site, search, widget suggest

**Files:** Create `backend/src/kb/kb.api.ts`, `backend/src/kb/search.ts`, `backend/migrations/0002_fts.sql`; `frontend/src/kb/{KbAdminPage,ArticleEditor,CollectionModal}.tsx`, `frontend/src/kb-public/{KbHome,KbArticle,KbSearch}.tsx`; widget suggest wiring; `e2e/tests/kb.spec.ts`.

**Interfaces/behavior:**
- 0002_fts.sql: `CREATE VIRTUAL TABLE kb_articles_fts USING fts5(title, body_text, content='kb_articles', content_rowid='rowid');` + AI/AU/AD triggers. Apply local+remote; **if D1 rejects → delete the migration file, set `search.ts` to LIKE mode, decision.md entry** (`searchArticles(db, wsId, q, limit)` interface identical either way; FTS query: `SELECT a.* FROM kb_articles_fts f JOIN kb_articles a ON a.rowid=f.rowid WHERE kb_articles_fts MATCH ?1 AND a.workspace_id=?2 AND a.status='PUBLISHED' LIMIT ?3` with `q` sanitized to `"${q.replace(/"/g,'')}"` phrase-or-terms).
- Admin endpoints per init.md; `body_text` derived server-side on save: body_md stripped (`md.replace(/```[\s\S]*?```/g," ").replace(/[#*_>\[\]()!\-\`]/g," ")` collapse spaces). Publish sets status+published_at; unpublish supported (PATCH status DRAFT).
- Editor: two-pane markdown textarea + live preview (marked + DOMPurify), toolbar buttons (B/I/H2/link/list/code → insert md syntax at cursor), title, collection select, slug (auto from title, editable), Save draft / Publish buttons. List page: collections sidebar (create/rename), articles table w/ status chips.
- Public (no auth, envelope API): `GET /api/v1/public/kb/:wsSlug` `{workspace:{name,widgetColor}, collections:[{...,articles:[{title,slug}]}]}` (PUBLISHED only) · `.../articles/:slug` full body_md · `.../search?q=` hits. Frontend routes `/kb/:wsSlug`, `/kb/:wsSlug/a/:slug` (rendered markdown, prose styling), search box with results dropdown. Resolve by Host header too (Task 12 wires custom domains through same handler — public KB API accepts `?host=` OR the Worker rewrites based on Host before ASSETS fallback; implement as: Hono middleware — if request Host matches an ACTIVE custom_domain, internally treat path `/` and `/a/:slug` as that workspace's KB routes).
- Widget suggest: `GET /api/v1/widget/suggest?q=` (widget token) → top 3 published; TicketList search box + NewTicket composer (debounced 400ms while typing the first message) show suggestion cards (title + snippet) linking to public article (new tab).
- [x] Playwright kb.spec: create collection+article → publish → public page renders markdown (assert an `<h2>` from md) → search finds it → widget NewTicket typing "how do I reset" surfaces the article card.
- [x] Deploy + smoke on prod. Commit + push (`feat: markdown knowledge base with public site, search, widget suggestions`).

---

### Task 10: AI summaries (+ RateLimiter DO, flag-gated) 

**Files:** Create `backend/src/ai/summary.ts`, `src/ai/ai.api.ts`, `src/ratelimit/limiter.ts` (DO) + middleware; `frontend` SummaryPanel wiring; `e2e/tests/summary.spec.ts`.

**Interfaces/behavior:**
- `GET /ws/:wsId/conversations/:id/summary` → if `ai_summary_msg_count === message_count && ai_summary` return cached `{summary, generatedAt, cached:true}`; else build prompt: system = `You summarize customer support conversations for an agent about to reply. Output exactly three labeled lines:\nWANTS: what the customer wants\nTRIED: what has been tried/answered so far\nSTATUS: current state and what should happen next.\nBe specific and under 80 words total.`; user = (previous summary ? `Previous summary:\n${it}\n\n` : "") + `Conversation (newest last):\n` + last 30 msgs as `[CONTACT|AGENT|SYSTEM] text` (each msg body clipped 500 chars); call `env.AI.run(AI_CONF.MODEL, {messages, max_tokens: AI_CONF.MAX_TOKENS})` raced vs 10s timeout → persist summary+count → return. Failure/timeout → `ctxErr.ai.unavailable()` (msg "AI summary unavailable right now"); frontend panel shows msg + Retry button. Regenerate button = same endpoint with `?force=1` (skips cache).
- SummaryPanel (in ConversationView side column with ContactPanel): auto-fetches when conversation has ≥6 messages; shows the three lines; "updates as conversation progresses" = refetch on MESSAGE_CREATED for the open conversation (cache makes it cheap).
- RateLimiter DO: `fetch("/check", {key, limit, windowSec})` → in-memory `Map<key, number[]>` prune+push → `{allowed}`; middleware `rateLimit(keyFn, limit, window)` no-ops when `!FLAG.RATE_LIMIT_ENABLED`; applied to magic-link (email+IP keys) and widget message POST. Unit-test the window math with injected timestamps (pure fn `slideWindow(times, now, windowMs, limit)`).
- [x] summary.spec: seed a conversation with 8 alternating messages via API → GET summary → assert 200 with WANTS/TRIED/STATUS lines OR (if AI flaky in CI) accept 400 AI_UNAVAILABLE and mark test soft-skip — but require at least one successful real summary manually verified against prod before ticking this box.
- [x] Deploy; verify on prod with a real conversation. Commit + push (`feat: rolling AI summaries with cache and graceful fallback; flag-gated rate limiting`).

---

### Task 11: Stretch — canned responses + AI draft replies

**Files:** `backend/src/canned/canned.api.ts`, `src/ai/draft.ts` (+route); frontend Composer picker + "✨ Draft reply" button.

- Canned CRUD per init.md; Composer `/` opens picker (filter by title/tags), insert into textarea. Draft: `POST .../draft-reply` → context = last 10 messages + top-3 KB hits for the last CONTACT message text; system prompt: `Draft a helpful, concise support reply (2-6 sentences, plain text, no signature). Use the knowledge base excerpts only if relevant.`; returns `{draft}` → fills composer (editable, never auto-sends). Same 10s/fallback discipline.
- [ ] Verify both in prod UI (screenshot via Playwright). Commit + push (`feat: canned responses and AI reply drafts`).

**Fallback:** if behind schedule at this point, SKIP this task entirely (log in decision.md) — Task 12/13 matter more.

---

### Task 12: Custom domains (lite) — **DEFERRED: DO NOT EXECUTE OVERNIGHT**

> User decision (post-review): skip this feature tonight; it will be done in the morning with
> the user. Overnight scope: (a) README "Custom domains" section explaining the full approach
> (DoH TXT verification + Cloudflare-for-SaaS SSL) — that's part of Task 13; (b) the
> `custom_domains` table already exists in the schema. Leave this task's checkboxes UNCHECKED
> and skip straight to Task 13. The spec below stays as the morning playbook.

**Files:** `backend/src/domains/domains.api.ts`, `src/domains/verify.ts`; `frontend/src/settings/DomainsPage.tsx`; Host-header middleware finalized (Task 9 hook).

- Endpoints per init.md §6. Verify = DoH: `GET https://cloudflare-dns.com/dns-query?name=_sp-verify.${hostname}&type=TXT` header `accept: application/dns-json`; ACTIVE iff any TXT answer data (quotes stripped) === verification_token; also check CNAME of hostname → APP_URL host (informational only — flag `cnameOk` in response, TXT alone gates ACTIVE). `verifyDomain(hostname, token, fetchFn)` pure-ish for unit test with fake fetch.
- Settings UI: add hostname → records table (copy buttons) → Verify button → status chip; explainer text of what production SSL would do (Cloudflare for SaaS `POST /zones/:id/custom_hostnames` — 3 sentences).
- README section (Task 13) explains the full production path.
- [ ] Unit-test verify fn (mock DoH responses: match/mismatch/NXDOMAIN). UI verify with a real TXT? — if quick, add `_sp-verify.test.hyugorix.com` TXT via Cloudflare dashboard browser automation and demo ACTIVE end-to-end (nice screenshot for README); else mark FAILED path shown. Commit + push (`feat: custom domain connect with real DNS verification (SSL stubbed)`).

---

### Task 13: Hardening, README, final acceptance sweep

**Files:** `README.md` (root), polish across; `e2e/tests/smoke.spec.ts` (prod).

- [x] README (the evaluator reads this — spend real effort): what/why, architecture diagram (ASCII), schema summary, real-time design (DO ordering + hibernation + reconnect), email engineering (threading diagram: Message-ID/In-Reply-To/plus-addressing), AI design (windowing/cache/fallback/cost), security section (token model incl. CSRF/XSS reasoning, tenant isolation, widget isolation, sanitization, rate-limit flag), trade-offs & deliberate scope (from decision.md: no Queues, markdown-as-rich-text, stateless refresh, custom-domain SSL stub), built vs skipped table, local setup (exact commands incl. `.dev.vars` template), deployment, testing instructions for evaluators (URLs, demo page, inbound email address, sample workspace), known limitations (from MORNING.md list).
- [x] Hardening pass: every route zod-validated (grep for `c.req.json()` outside validate); D1 batch where multi-write; widget CORS headers on `/api/v1/widget/*` + `/api/v1/public/*` (`Access-Control-Allow-Origin: *`, no credentials) and NONE elsewhere; security headers on HTML (CSP frame-ancestors for /widget-app must ALLOW all — it's an embed; X-Frame-Options absent there, DENY on dashboard routes... assets serve both, so: set CSP via Hono only on API-rendered pages, skip static-page headers, note in README); 404/empty states in UI; loading skeletons on inbox. Also found+fixed a real bug while verifying (D1 batch changes-counting, decision #19) and a real onboarding gap (no UI ever surfaced the widget key, decision #20).
- [x] **Final acceptance matrix — run every line against PROD, tick only on evidence:**
  - [x] 1a Signup/login via magic link (real email to Gmail read via browser MCP, not debug header — once)
  - [x] 1b Invite flow both roles; role enforcement (AGENT can't invite)
  - [x] 1c Assign conversations to agents
  - [x] 2 Widget on /demo: real-time both ways, typing, presence, read receipts, history after reload (same browser), ticket-style multi-conversation
  - [x] 3 Email: real inbound → conversation (or simulator + MORNING.md note if transport blocked); dashboard reply → real email in Gmail; customer reply threads into same conversation
  - [x] 4 Inbox filters (channel/status/assignee), assign/snooze/resolve, snooze auto-reopen
  - [x] 5 KB: create/edit/publish markdown, categories, public page + search, widget auto-suggest
  - [x] 6 AI summary on a long conversation; updates after new messages; fallback path renders when forced (temporarily bad model name locally to see 400 — do not deploy that)
  - [x] 7 Custom domains: approach fully documented in README (feature implementation deferred to morning per user — confirm MORNING.md carries the task)
  - [x] Stretch present: canned responses, AI drafts (if Task 11 done) — N/A, Task 11 deliberately skipped (decision #18)
  - [x] Envelope discipline: spot-check 5 endpoints incl. errors (200/400 shapes)
  - [x] README accurate; MORNING.md final status written; decision.md complete
- [x] `e2e` full suite green against prod (`BASE_URL=<prod> pnpm test`). Screenshots captured via browser automation but the tool's save-to-disk path wasn't resolvable this session — not embedded as files (decision #21); the README leans on live URLs + a detailed walkthrough instead.
- [x] Final commit + push (`docs: README, hardening, final acceptance evidence`).
- [x] **Stop the loop** (ScheduleWakeup stop) after appending the final status block to MORNING.md.

---

## Self-review notes (writing-plans checklist)

- Spec coverage: all init.md sections map to Tasks 0–13; assignment's 7 features map to the
  acceptance matrix in Task 13. Rate limiting (flag), logging, validation are Tasks 1/10/13.
- Type consistency: `MessageIn/MessageOut`, `ctxErr` factory names, `searchArticles`,
  `parseInboundAddress`, env/secret names are single-sourced here and in CLAUDE.md — do not
  rename; extend only.
- Known intentional deviations from full TDD granularity: UI tasks verify via Playwright
  acceptance instead of unit tests (decision.md #7).
