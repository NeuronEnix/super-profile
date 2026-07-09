# SuperProfile Assignment — "Build Intercom" — Design Spec

Ship a production-ready customer communication platform in 48 hours on Cloudflare.
Stack decisions (locked): **Workers + Hono (TypeScript)** backend, **D1** database, **R2** for blobs,
**React on Cloudflare Pages** frontend, **Durable Objects WebSockets** for real-time,
**Resend** for outbound email (Cloudflare Email Routing for inbound), **Workers AI** for LLM features.

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
**Workers AI** (summaries), one **Durable Object** class, plus secrets (`RESEND_API_KEY`, etc.).

**Real-time:** one Durable Object per workspace (`WorkspaceHub`) using the WebSocket
**hibernation API** (cheap when idle). Both dashboard agents and widget visitors connect to it.
Critically, **all chat message writes go through the DO**: the DO is single-threaded per workspace,
so it writes to D1 and broadcasts in order — that is the message-ordering guarantee.
Typing indicators and presence are DO-memory only (never hit D1). The widget reconnects with
exponential backoff + missed-message fetch over REST (`after_id` catch-up).

**Email flow:** Cloudflare Email Routing → `email()` handler → parse with `postal-mime` →
thread-match via `In-Reply-To`/`References` against stored `Message-ID`s
(fallback: `reply+<conversationId>@domain` plus-addressing) → insert into D1 → notify DO.
Outbound via Resend with our own `Message-ID` and correct `In-Reply-To` headers, behind a small
`EmailSender` interface so it is stubbed until the domain is verified. A secret-protected
`POST /email/inbound` simulator endpoint allows end-to-end threading tests before Email Routing
is configured.

**Custom domains:** real DNS verification without any account action — query TXT/CNAME via
Cloudflare's DNS-over-HTTPS JSON API (`https://1.1.1.1/dns-query`). SSL provisioning via
Cloudflare for SaaS (custom hostnames API) is stubbed behind an interface + documented, since it
needs a zone / paid feature.

**AI:** Workers AI (Llama 3.3 70B) with context windowing (last N messages + previous summary →
rolling summary), cached in D1 keyed by message count so it only regenerates when the conversation
grows, 10s timeout + graceful "summary unavailable" fallback.

---

## 2. Database schema (D1)

All tenant tables carry `workspace_id`; every query is scoped by it (tenant isolation).
IDs are UUIDv7 (time-ordered — doubles as a stable sort key).

```sql
workspaces        id, name, slug UNIQUE, widget_key UNIQUE, widget_color,
                  support_email, created_at

users             id, workspace_id, email UNIQUE, name, password_hash,
                  role CHECK(role IN ('admin','agent')), last_seen_at, created_at

invites           id, workspace_id, email, role, token UNIQUE, expires_at,
                  accepted_at, created_by, created_at

sessions          id (token hash), user_id, expires_at, created_at

contacts          id, workspace_id, email, name, anon_id,  -- anon_id: widget localStorage UUID
                  last_seen_at, created_at
                  UNIQUE(workspace_id, email), UNIQUE(workspace_id, anon_id)

conversations     id, workspace_id, contact_id, channel CHECK(channel IN ('chat','email')),
                  status CHECK(status IN ('open','snoozed','resolved')) DEFAULT 'open',
                  assignee_id NULL, subject NULL, snoozed_until NULL,
                  last_message_at, ai_summary NULL, ai_summary_msg_count DEFAULT 0,
                  contact_last_read_at, agent_last_read_at, created_at, updated_at
                  INDEX (workspace_id, status, last_message_at DESC)

messages          id, conversation_id, workspace_id,
                  sender_type CHECK(sender_type IN ('contact','agent','system')),
                  sender_id NULL, body_text, body_html NULL,
                  email_message_id NULL,      -- Message-ID header (in/outbound)
                  email_in_reply_to NULL, created_at
                  INDEX (conversation_id, id), INDEX (workspace_id, email_message_id)

attachments       id, message_id, workspace_id, r2_key, filename, content_type, size

kb_collections    id, workspace_id, name, slug, description, position
                  UNIQUE(workspace_id, slug)

kb_articles       id, workspace_id, collection_id, title, slug, body_html, body_text,
                  status CHECK(status IN ('draft','published')), created_by,
                  published_at, created_at, updated_at
                  UNIQUE(workspace_id, slug)

kb_articles_fts   FTS5(title, body_text)      -- powers public search + widget auto-suggest

custom_domains    id, workspace_id, hostname UNIQUE, verification_token,
                  status CHECK(status IN ('pending_dns','active','failed')),
                  ssl_status, verified_at, created_at

canned_responses  id, workspace_id, title, body, tags, created_by, created_at  -- stretch
```

Read receipts are the two `*_last_read_at` watermarks on `conversations` (one row update per read,
not per message). Email threading lives in `messages.email_message_id` / `email_in_reply_to`.

---

## 3. Backend modules

| Module | Responsibility |
|---|---|
| `auth` | signup (creates workspace + admin), login/logout, session cookies, invite issue/accept, RBAC middleware |
| `team` | member list, role changes, removal (admin-only) |
| `conversations` | unified inbox queries (filter by channel/status/assignee), assign/snooze/resolve, message CRUD, read watermarks |
| `realtime` | `WorkspaceHub` DO — WS auth, hibernation, ordered write+broadcast, typing/presence, reconnect protocol |
| `widget` | public widget endpoints — widget session tokens (signed), conversation history, KB suggest; serves `widget.js` and the demo page |
| `email` | inbound parse + thread matching, outbound `EmailSender` (Resend impl + stub), simulator endpoint |
| `kb` | admin CRUD for collections/articles, publish flow, public KB endpoints (slug- or Host-header-resolved), FTS search |
| `ai` | rolling summarization, prompt templates, timeout/fallback, (stretch: reply drafts) |
| `domains` | connect flow, DoH DNS verification, SSL provisioning stub |
| `middleware` | tenancy scoping, zod validation, error envelope, request logging, naive per-IP rate limiting |

Frontend modules: `auth` pages, `inbox` (list + conversation pane + composer),
`kb-admin` (rich text via TipTap), `kb-public` (themed help center),
`settings` (team, widget install snippet, domains), plus the separate `widget` package.

---

## 4. API contract (`/api/v1`, JSON, zod-validated, errors as `{error: {code, message}}`)

### Auth & team
```
POST   /auth/signup                {name, email, password, workspaceName}
POST   /auth/login                 {email, password}
POST   /auth/logout
GET    /auth/me
POST   /invites                    {email, role}            (admin)
GET    /invites                                             (admin)
POST   /invites/accept             {token, name, password}  (public)
DELETE /invites/:id                                         (admin)
GET    /members
PATCH  /members/:id                {role}                   (admin)
DELETE /members/:id                                         (admin)
```

### Inbox
```
GET    /conversations              ?channel=&status=&assignee_id=&cursor=
GET    /conversations/:id
GET    /conversations/:id/messages ?cursor=&after_id=       (after_id = reconnect catch-up)
POST   /conversations/:id/messages {body}                   → chat: DO broadcast; email: send via Resend
PATCH  /conversations/:id          {status?, assignee_id?, snoozed_until?}
POST   /conversations/:id/read
GET    /conversations/:id/summary                           → {summary, generated_at} | 503 fallback
POST   /conversations/:id/draft-reply                       (stretch)
GET    /canned-responses | POST | PATCH/:id | DELETE/:id    (stretch)
```

### Knowledge base
```
CRUD   /kb/collections, /kb/articles     (admin/agent)
POST   /kb/articles/:id/publish
GET    /public/kb/:wsSlug                                    (also resolved by custom-domain Host)
GET    /public/kb/:wsSlug/articles/:slug
GET    /public/kb/:wsSlug/search          ?q=
```

### Widget (authenticated by signed widget token, CORS *)
```
POST   /widget/boot                {widgetKey, anonId, email?, name?} → {token, contact, conversations}
GET    /widget/conversations/:id/messages
POST   /widget/conversations       {body}                   → creates conversation + first message
POST   /widget/conversations/:id/messages {body}
GET    /widget/suggest             ?q=                      → top-3 KB articles (FTS)
GET    /widget.js  ·  GET /demo                             → bundle + demo page
```

### Real-time (WS → WorkspaceHub DO)
```
WS /ws/dashboard   (session cookie)  ·  WS /ws/widget?token=
events: message.created · typing {start|stop} · presence {online|offline}
        read.receipt · conversation.updated (assign/status changes)
client → server: typing, read; everything else flows through REST → DO
```

### Domains & email
```
POST   /domains                    {hostname} → {cname_target, txt_record}
POST   /domains/:id/verify                    → real DoH check → active | failed
DELETE /domains/:id
POST   /email/inbound              (secret header; simulates Email Routing for testing)
email() worker handler             (real inbound once Email Routing is configured)
```

---

## 5. Scope decisions

**Stretch features planned:** canned responses, AI draft replies (cheap once `ai` + inbox exist).

**Deferred (documented in README, not built):** webhooks / REST API keys, SLA tracking,
analytics dashboard, contact page-visit tracking.

**Requires user action (prepared, activated later):**
- Cloudflare Email Routing on a real domain → until then, use `POST /email/inbound` simulator.
- Resend account + domain DKIM verification → until then, `EmailSender` stub logs sends.
- Cloudflare for SaaS custom hostnames (SSL) → DNS verification is real (DoH), SSL step stubbed + documented.
