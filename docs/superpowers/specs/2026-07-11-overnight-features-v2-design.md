# Overnight Features v2 — Design (2026-07-11)

**Executor:** Sonnet (thinking: high), autonomous overnight run via /loop, following an
implementation plan derived from this spec. Same operating mode as the first night: never ask,
log dilemmas in `decision.md`, user-required actions in `MORNING.md`, commit after every green
step, push after every task, deploy + prod-verify after every feature.

**Feature order (cut line runs bottom-up if the night runs short):**

1. **KB Sync** — import a customer's existing public docs site into the KB, plus the AI docs digest
2. **Canned responses** — saved replies with `/` quick-insert in the inbox composer
3. **SLA tracking** — first-response / resolution targets with breach chips
4. **Contact timeline** — pages visited, last seen, past conversations in the inbox side panel
5. **Analytics dashboard** — response times, resolution rate, busiest hours, agent + AI stats

**Explicitly out of scope tonight (user decision):** webhooks / public API; multi-source sync;
deleting KB articles on re-sync; JS-only (client-rendered) docs sites; contact-event pruning.

---

## Feature 1: KB Sync from an existing docs site (+ AI docs digest)

### Why

B2B customers already have public docs. Instead of re-authoring them in our KB, they paste
their docs URL and hit **Sync**. We crawl the site, convert pages to markdown, and populate
`kb_collections` / `kb_articles`. After each sync, an AI-generated **docs digest** (a compact
map of every article: title, URL, one-line gist) is stored on the workspace and injected into
both AI features (autonomous ticket handler + agent Suggest-reply), so the AI knows the full
breadth of the docs even when FTS retrieval misses.

### UX

New collapsible panel `KbSyncPanel` on the KB admin page, directly below `DomainPanel`,
following its exact visual pattern (collapsed bar + status chip; expanded detail).

- Collapsed bar: `📥 Docs import` + status chip:
  - never synced → grey "not set up — import your existing docs site"
  - RUNNING → indigo "Syncing… 12 imported"
  - DONE → emerald "38 articles · synced 2h ago"
  - FAILED → red "Failed"
- Expanded:
  - URL input (accepts `docs.acme.com` or `https://docs.acme.com/help`) + **Sync now** button.
  - While RUNNING: live counters "Found 25 · Imported 12 · Failed 1" — the panel polls
    `GET …/kb/sync` every 2 s while expanded and status is RUNNING.
  - While in cooldown: button disabled, text "Next sync available in 22h 41m".
  - FAILED: the stored error message + button enabled (failure does **not** arm the cooldown).
  - Note text: "Re-sync updates previously imported articles. Articles you created yourself are
    never touched."

### Rules (locked with user)

- **One source per workspace** (`UNIQUE(workspace_id)` on the source table). Changing the URL
  updates the same row; the cooldown still applies (otherwise editing the URL would bypass it).
- **Cooldown**: next sync allowed `KB_SYNC_COOLDOWN_MIN` minutes (default **1440**, env-var
  configurable; `.dev.vars` sets `1` for local testing) after the last **successful** sync.
  A FAILED sync never arms the cooldown.
- **Concurrency**: sync runs inside a new Durable Object, `KbSyncRunner`, named by
  `workspaceId`. The DO is single-threaded, so parallel Sync clicks serialize; the
  status/cooldown check happens inside the DO → race-free by construction. D1 unique
  constraints (`kb_sync_sources.workspace_id`, `kb_articles(workspace_id, source_url)`)
  are the backstop.
- **Re-sync semantics**: upsert by `(workspace_id, source_url)`. Existing imported article →
  update `title`, `body_md`, `body_text`, `updated_at` (slug **stays stable** so public links
  never break). New page → insert as **PUBLISHED** (`published_at = now`). Never delete.
  Manually-created articles (`source_url IS NULL`) are never touched.
- **Caps (user decision: "10 articles is more than enough for now")**: at most **10 articles
  imported** and at most **15 pages fetched** per sync — whichever hits first ends the crawl.
  Same-origin only, and path must be under the given path prefix
  (`https://docs.acme.com/help` → only `/help/**`).
- **Bot-protection detection**: 3 consecutive fetches answering 403/429, or carrying a
  challenge marker (`x-vercel-mitigated: challenge` header, `cf-mitigated: challenge`,
  or a "Security Checkpoint"/challenge-page title), abort the run → status FAILED with error
  **"This site blocks automated access (bot protection). Try a different docs URL."**
  Verified need: superprofile.bio (probed 2026-07-11) challenges every non-browser client
  site-wide — it is the designated graceful-failure showcase in the demo.

### Data model — migration `0005_kb_sync.sql`

```sql
CREATE TABLE kb_sync_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  url TEXT NOT NULL,                    -- normalized start URL
  status TEXT NOT NULL CHECK (status IN ('RUNNING','DONE','FAILED')),
  pages_found INTEGER NOT NULL DEFAULT 0,
  pages_imported INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  requested_by TEXT NOT NULL,           -- user who clicked Sync (becomes created_by on articles)
  started_at INTEGER,
  last_synced_at INTEGER,               -- set on DONE; cooldown anchors here
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
ALTER TABLE kb_articles ADD COLUMN source_url TEXT;
CREATE UNIQUE INDEX idx_kb_articles_source ON kb_articles(workspace_id, source_url)
  WHERE source_url IS NOT NULL;
ALTER TABLE workspaces ADD COLUMN kb_digest TEXT;
ALTER TABLE workspaces ADD COLUMN kb_digest_at INTEGER;
```

FTS stays free: the existing `kb_articles_ai/au` triggers (migration 0002) index imported
articles automatically — search, widget suggestions, and both AI features pick them up with
zero extra code.

### The sync engine — `KbSyncRunner` DO

- `wrangler.jsonc`: new binding `KB_SYNC` → class `KbSyncRunner`; migrations gain
  `{ "tag": "v2", "new_sqlite_classes": ["KbSyncRunner"] }`.
- **`POST /start`** (from the API layer) with `{workspaceId, userId, url}`:
  - If D1 row status is RUNNING **and** `started_at` is newer than 15 min → `SYNC_RUNNING`
    error. (Older than 15 min = stale crash leftover → allowed to restart.)
  - If `last_synced_at + cooldown > now` → `SYNC_COOLDOWN` error with human remaining-time in
    the msg.
  - Else: reset DO storage `{frontier: [startUrl], visited: [], counts…}`, upsert the D1 row
    to RUNNING, `setAlarm(now)`. Before BFS begins, the first alarm also tries
    `GET {origin}/sitemap.xml` — URLs in scope are appended to the frontier (still capped).
- **`alarm()`**: processes up to **5 pages** per firing (small batches = fresh subrequest
  budget every firing, and progress persists between firings):
  - per page: `fetch` with UA `SuperProfileBot/1.0 (+https://sp.hyugorix.com)`, 10 s timeout;
    require 200 + `text/html`; HTML capped at 2 MB. Page-level failures increment
    `pages_failed` and never abort the run.
  - extract main content → convert to markdown → upsert article (see below) → collect
    in-scope links into the frontier (dedupe; stop at 15 fetched or 10 imported).
  - write-through progress counters to the D1 row (the UI polls D1 only — the DO is
    write-only from the panel's perspective).
  - frontier empty or cap reached → **finalize**: generate the digest, set status DONE +
    `last_synced_at`, clear storage. Otherwise re-arm `setAlarm(now + 250ms)`.
  - A whole-alarm crash relies on the runtime's built-in alarm retries; after 3 retries the
    run is marked FAILED with the error message (counter in DO storage).

### Crawler internals — pure functions in `backend/src/kb-sync/crawl.ts` (unit-tested, no I/O)

New dependency: **`node-html-parser`** (pure-JS HTML parser — works in Workers *and* in plain
node vitest; there is no DOM in either). Workers AI `toMarkdown()` was considered and
rejected: nondeterministic, unmockable in tests, and it converts nav/sidebar junk — main-content
extraction is needed regardless.

- `normalizeDocsUrl(input)` → `{startUrl, origin, pathPrefix} | null`. Adds `https://` when
  missing, requires a dotted hostname, strips hash/query. **Rejects** (SSRF + self-fetch
  guard): localhost, IP literals, `*.hyugorix.com`, `sp.hyugorix.com`, `*.workers.dev`,
  `inbox./notifications.` — a Worker cannot fetch its own hostname anyway (subrequest loop,
  error 1042).
- `inScope(url, origin, pathPrefix)` — same origin + path prefix match.
- `extractLinks(html, baseUrl)` — `<a href>` resolved against base, hash stripped, query
  stripped (canonicalize), mailto/tel/external filtered out, deduped.
- `extractMainContent(html)` → `{title, contentHtml}`. Title from `<h1>` else `<title>`
  (site-suffix like " | Acme Docs" trimmed). Content root: `<main>`, else `<article>`, else
  `role="main"`, else the `<body>` child subtree with the most text. Always strips
  `nav/header/footer/aside/script/style/noscript` and elements with `class~="sidebar|toc|nav"`.
- `htmlToMarkdown(contentHtml)` — small serializer over the node-html-parser tree:
  h1–h6, p, ul/ol (nested), pre/code (fenced + inline), a → `[text](url)`, strong/em,
  blockquote, img → `![alt](src)`, table → pipe table (simple), br. Unknown blocks fall back
  to their text. Pages producing < 80 chars of markdown are skipped (not imported, not failed).
- `deriveCollectionName(pageUrl, pathPrefix)` — first path segment below the prefix, `-`/`_`
  split + title-cased (`/guides/x` → "Guides"); no segment → `null` (lands in Uncategorized).
  Collections are find-or-create by slug, reusing the KB slug util.
- `planBatch(state, pageResults)` — the pure frontier-step function; the DO alarm is a thin
  shell around it with injected `fetch`/upsert, so orchestration logic is unit-testable.

### AI docs digest

Deterministic structure, AI writes only prose — **no hallucinated URLs possible**:

1. Load up to 60 PUBLISHED articles (title, slug, collection, first 200 chars of body_text).
2. One AI call (existing `AI_CONF.MODEL` + `runWithTimeout`): input is a numbered list, output
   must be numbered one-line gists (`1. Covers password reset via email link`).
3. Zip the gists back by number and compose the digest **ourselves** in markdown, grouped by
   collection: `- [Title](realUrl) — gist`. Parse failure → fallback digest of titles + URLs
   only (still useful). Cap 4000 chars. Store in `workspaces.kb_digest` + `kb_digest_at`.
4. Regenerated at the end of every sync (manual KB edits go stale until the next sync —
   accepted).

**Injection**: `buildHandlerPrompt` and `buildDraftPrompt` gain an optional `digest` param,
prepended as `Documentation map (everything available):\n{digest}`. Both call sites load
`kb_digest` alongside data they already fetch. FTS top-3 excerpts stay — FTS gives depth,
the digest gives breadth.

**URL base helper** `publicKbBase(db, workspaceId, wsSlug, appUrl)`: if the workspace has an
ACTIVE custom domain → `https://{hostname}` (articles at `/a/{slug}`), else
`{appUrl}/kb/{wsSlug}`. Used by the digest composer **and** refactored into the existing
handler article links — the AI cites `docs.kaushikrb.com/a/…` when the domain is live.

### API

`backend/src/kb-sync/sync.api.ts`, mounted under `/api/v1/ws/:wsId` (auth + wsMiddleware):

- `GET /kb/sync` (member) → `{source: Row | null, cooldownMin}` — reads D1 only.
- `POST /kb/sync` (requireAdmin) body `{url}` → validate + normalize, then DO `/start`;
  returns the fresh row. Errors: `ctxErr.kbSync.invalidUrl` ("Enter a valid docs site URL"),
  `.cooldown` ("You can sync again in {…}"), `.alreadyRunning` ("A sync is already running").

Consts: `KB_SYNC = { STATUS: {RUNNING, DONE, FAILED}, PAGE_CAP: 15, ARTICLE_CAP: 10,
BATCH_SIZE: 5, FETCH_TIMEOUT_MS: 10_000, MAX_HTML_BYTES: 2_000_000, MIN_CONTENT_CHARS: 80,
BLOCKED_STREAK_LIMIT: 3, USER_AGENT: … }`,
`AI_CONF.DIGEST = { MAX_ARTICLES: 60, PER_ARTICLE_EXCERPT: 200, MAX_TOKENS: 900,
DIGEST_CHAR_CAP: 4_000 }`. Config: `KB_SYNC_COOLDOWN_MIN` through `getConfig` (vars default
"1440").

### Testing & verification

- **Unit (plain vitest, zero network)**: every pure function above with realistic HTML
  fixtures (a VitePress-style page, a Docusaurus-style page, a nav-heavy page, link soup with
  relative/absolute/anchor/external hrefs); cooldown decision function (injected clock);
  `planBatch` frontier stepping; digest zip/parse + fallback.
- **No e2e against external sites** (flaky + impolite), **no self-crawl** (error 1042 —
  Worker cannot fetch its own hostname).
- **Prod verification (once, after deploy)**: create/use a **throwaway test workspace — NOT
  ban-gera** (the demo workspace with docs.kaushikrb.com must stay untouched overnight);
  sync `https://hono.dev/docs` (probed 2026-07-11: 200, server-rendered, `<main>` present,
  no sitemap → exercises the BFS path); verify: panel progress ticks, ~10 articles +
  collections appear, public KB page renders one, cooldown countdown shows and the button is
  disabled, digest present (`SELECT length(kb_digest) FROM workspaces …`). Crawling a public
  docs site once by hand is not a third-party *service* call — the no-third-party rule
  (Resend etc.) is about automated tests and paid/rate-limited APIs; the crawl stays out of
  all test suites.
- **Morning demo script (goes in MORNING.md, run on ban-gera by the user)**: paste
  `https://superprofile.bio/blog` → Sync → watch it fail honestly with the bot-protection
  message (FAILED never arms the cooldown) → paste `https://hono.dev/docs` → Sync → watch the
  KB fill live and the articles appear on docs.kaushikrb.com. Failure-first ordering is what
  makes the sequence work within the cooldown rules.

---

## Feature 2: Canned responses

The `canned_responses` table **already exists** (0001): `id, workspace_id, title, body, tags
(comma-separated), created_by, created_at`. No migration needed.

- **API** `backend/src/canned/canned.api.ts` under `/api/v1/ws/:wsId/canned` (any member —
  team-shared): `GET /` list ordered by title; `POST /` `{title 1..120, body 1..5000,
  tags ≤200 optional}`; `PATCH /:id`; `DELETE /:id`. `ctxErr.canned.notFound`.
- **Settings UI**: new `CannedSection.tsx` component in the settings page — list with inline
  add/edit form and two-click-confirm delete (established pattern; no native dialogs).
- **Composer integration (inbox only)**: `Composer` gains an optional prop
  `canned?: CannedResponse[]`. When provided and the text starts with `/`: dropdown above the
  textarea filtered by title/tags substring (`matchCanned(list, query)` — pure, unit-tested),
  ↑/↓ + Enter inserts the body (replacing the `/query`), Esc closes, click inserts, max 8
  shown. A small `⚡` button toggles the same dropdown for discoverability.
  `ConversationView` passes the list (fetched once per workspace in `InboxPage`); the widget's
  `TicketView` reuses `Composer` **without** the prop — visitors never see canned responses
  (same optionality pattern as `onSuggest`/`onFixGrammar`).
- **e2e (local)**: create a canned response in settings → open a conversation → type `/` →
  insert → send. No third-party calls anywhere.

---

## Feature 3: SLA tracking

### Data — migration `0006_sla.sql`

```sql
ALTER TABLE conversations ADD COLUMN first_agent_reply_at INTEGER;
ALTER TABLE conversations ADD COLUMN resolved_at INTEGER;
ALTER TABLE workspaces ADD COLUMN sla_first_response_min INTEGER;  -- NULL = SLA off
ALTER TABLE workspaces ADD COLUMN sla_resolution_min INTEGER;      -- NULL = SLA off
-- backfill (approximations, fine for existing demo data):
UPDATE conversations SET first_agent_reply_at =
  (SELECT MIN(created_at) FROM messages m
   WHERE m.conversation_id = conversations.id AND m.sender_type IN ('AGENT','AI'));
UPDATE conversations SET resolved_at = updated_at WHERE status = 'RESOLVED';
```

### Write paths (all single-choke-point)

- `hub.ts handleMessage` conversation UPDATE gains two CASEs: stamp `first_agent_reply_at`
  when `sender_type IN ('AGENT','AI')` and it is NULL (an AI reply **counts** as first
  response — it is one); clear `resolved_at` when the message reopens the conversation.
- The status PATCH endpoint (`conversations.api`): set `resolved_at = now` on RESOLVED,
  `NULL` on manual reopen to OPEN/SNOOZED.

### Read + UI

- Conversation list/detail selects gain both columns; the workspace payload gains both
  targets; Settings gets an admin-only "SLA targets" section (two minute inputs, blank = off)
  saved via the existing workspace PATCH.
- `computeSla(conv, targets, now)` — pure function in `frontend/src/lib/sla.ts` returning
  per-metric `{state: MET | PENDING | BREACHED, dueAt, atMin}`; backend test file imports it
  relatively (same style as other pure-function tests; if the cross-dir import misbehaves in
  vitest, mirror the ~30-line function into `backend/src/conversations/sla.ts` and test that —
  noted as acceptable duplication).
- Chips: list rows show a chip only when actionable — amber `⏰ 4m` countdown (PENDING) or red
  `SLA breached`; nothing when met/off (keeps the list calm). The conversation header shows
  both metrics precisely ("First response 3m / target 5m ✓ · Resolution due in 12m").
- Breach is **computed on read** — no cron, no background jobs. Verified manually with a
  2-minute target on prod.

---

## Feature 4: Contact timeline

### Data — migration `0007_contact_events.sql`

```sql
CREATE TABLE contact_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  type TEXT NOT NULL CHECK (type IN ('PAGE_VIEW')),
  url TEXT NOT NULL, title TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_contact ON contact_events (contact_id, created_at DESC);
```

### Capture pipeline

The loader knows the page; the iframe knows the identity — they already talk via postMessage.

- **`widget.js` (loader)**: create the iframe **eagerly on load** instead of on first open
  (one-line change; also fixes the pre-open unread badge, which today can't receive
  `sp:unread` until the widget has been opened once). Post `{type:'sp:page', url, title}`
  into the iframe on load and on SPA navigation (wrap `history.pushState`/`replaceState`,
  listen to `popstate` + `hashchange`; skip consecutive duplicates).
- **`WidgetApp` (iframe)**: accept `sp:page` messages only from `window.parent`; queue until
  booted; then `POST /api/v1/widget/events` (widget-token auth) — client-side throttle: same
  URL within 30 s is skipped.
- **Server**: zod `{url ≤2000, title ≤300 optional}`; resolves the contact from the widget
  token, inserts the event, bumps `contacts.last_seen_at`. Rate-limit middleware attached
  (same flag-gated pattern as widget messages).
- `demo.html` gains a tiny fake nav (3 hash "pages" that swap title/content) so the demo
  produces a convincing browsing trail.

### Read + UI

- `GET /ws/:wsId/contacts/:contactId/timeline` (member) → `{contact (incl. lastSeenAt),
  events: last 30, conversations: all for the contact}`.
- `ContactPanel` (11 lines today) becomes the "super profile": name/email, **Last seen 2m
  ago** (live-ish — refetch on conversation change), "Recent activity" (page title or path +
  relative time), "Conversations" (channel icon, subject, status, relative time; current one
  highlighted; clicking selects that conversation in the inbox).
- **e2e (local)**: boot the widget on `demo.html`, click through the fake pages, agent opens
  the conversation → timeline shows the page views. Purely local.

---

## Feature 5: Analytics dashboard

### API

`backend/src/analytics/analytics.api.ts` — `GET /ws/:wsId/analytics?days=14` (member;
1–90, default 14). Bounded SQL fetches (conversations in window with timing columns; messages
grouped per day and per hour-of-day via `strftime`; agent reply counts joined to user names) +
**`computeAnalytics(...)` pure function** (`analytics/compute.ts`, unit-tested: medians on
empty/odd/even sets, rates with zero denominators) returning:

- totals: conversations, open/resolved, resolution rate
- median + average first-response minutes; median resolution minutes (from the SLA columns —
  free thanks to Feature 3)
- volume by day (14 bars), busiest hours (24 bins, from message timestamps)
- per-agent: replies sent, conversations assigned, resolved, median first reply
- channel split CHAT/EMAIL
- **AI stats** (stable, message-derived — the live `ai_handling`/`ai_escalated` flags reset on
  takeover): conversations with ≥1 AI message; of those, RESOLVED with zero human-agent
  messages = "resolved by AI alone" → deflection rate. A differentiator no other submission
  will have.

### UI

`AnalyticsPage` at `/w/:wsId/analytics` + "Analytics" nav item in `Shell`. Stat cards on top;
CSS-only bar charts (inline `width%` divs — **no chart dependency**): 14-day volume, 24-hour
busiest-hours row, agent table, channel split. Honest empty states ("No resolved conversations
in this window yet"). Range toggle 7/14/30 days.

Verification: local e2e asserts the page renders with seeded data; prod has real demo data
from the past two days — eyeball after deploy.

---

## Cross-cutting

- **Conventions law** (unchanged): `{code,msg,data}` envelope · HTTP 200/400/500 only ·
  `ctxErr` factories (new namespaces: `kbSync`, `canned`) · UPPERCASE `as const` trees ·
  UUIDv7 · `getConfig(env)` · Zod `validate()` middleware · markdown KB.
- **Migrations** are additive and applied `--remote` per feature (0005, 0006, 0007) before
  each deploy, exactly like night one.
- **Testing law** (unchanged): unit + local e2e only; **no external/paid service is ever hit
  by a test** — the single hand-run prod sync of hono.dev/docs is verification, not a test.
- **Per feature**: implement → unit green → local e2e where listed → deploy → prod smoke →
  tick plan checkboxes → commit + push → MORNING.md gets a "verify in 60 seconds" click-path.
- **New runtime dependency**: `node-html-parser` only. No Queues, no Browser Rendering, no
  new paid products — $0.
- **Risks & mitigations**: real-world HTML variance → tolerant extractor + per-page failure
  counters + FAILED never blocks retry; DO migration typo bricks deploy → tag v2 checked
  against class name in the same commit; eager widget iframe adds a boot call per page load →
  acceptable (it's how Intercom works) and it fixes the badge; digest parse failure → titles+
  URLs fallback; analytics on empty data → guarded divisions, honest empty states.
