# MORNING.md — for Kaushik

Overnight batch v2 (2026-07-11 night → 07-11 morning). This file is fully replaced tonight — it
covers only the five new features. Everything from the previous session (custom domains, DMARC,
inbound email transport, rate-limit flag, etc.) is unchanged and still exactly as documented in
`README.md` / `decision.md` entries #1–22; nothing in this batch touched any of that.

## TL;DR

All five features from `docs/superpowers/specs/2026-07-11-overnight-features-v2-design.md` are
**built, deployed, and verified**:

1. KB sync from an existing docs site (+ AI docs digest)
2. Canned responses
3. SLA tracking
4. Contact timeline
5. Analytics dashboard

Latest prod deploy: Worker version `c9639658-1c30-45c4-b4a9-d3d7a8da2ddb`. Evidence tonight:
**145/145 backend unit tests green**, **6/6 Playwright specs green locally** (`wrangler dev`) and
**6/6 green again against prod** (`https://sp.hyugorix.com`), `https://docs.kaushikrb.com` →
**200**. `ban-gera` (your real demo workspace) was **not touched** — verified directly against
D1 (`kb_sync_sources` has no row for it at all): its sync cooldown is **UNARMED**. That matters
because the demo script below runs on `ban-gera` and needs the cooldown to be free the first
time you run it — see the demo script and the note at the bottom about what happens *after* you
run it once.

Full autonomous-decision trail: `decision.md` entries **#23–#30** (new tonight) — two are
orchestrator review fixes over the executor's first pass (#24 overrides #23: a zero-import sync
now fails honestly instead of quietly reporting "DONE · 0 articles"). Plan file:
`docs/superpowers/plans/2026-07-11-overnight-features-v2.md` — all 11 tasks, 84 steps ticked.

---

## Feature 1: KB sync from an existing docs site (+ AI docs digest)

**What:** paste a customer's public docs URL into a new "Docs import" panel on the KB admin
page → a `KbSyncRunner` Durable Object (one per workspace) crawls it, converts pages to
markdown, and populates `kb_collections`/`kb_articles`. After every *successful* sync, one AI
call over all published articles produces a compact "docs digest" (title + real URL + one-line
gist per article, grouped by collection) stored on the workspace and injected into both AI
features (the autonomous handler and agent Suggest-reply), so AI replies can cite an imported
article even when full-text search alone would miss it.

**Where:**
- Schema: `backend/migrations/0005_kb_sync.sql` (`kb_sync_sources` table, `kb_articles
  .source_url`, `workspaces.kb_digest`/`kb_digest_at`) — commit `c423d8b`
- Crawler (pure functions, unit-tested, zero I/O): `backend/src/kb-sync/crawl.ts` — commit
  `179443c` (`backend/test/kb-sync-crawl.test.ts`)
- Digest (pure functions): `backend/src/kb-sync/digest.ts` — commit `6549731`
  (`backend/test/kb-sync-digest.test.ts`)
- The DO + import upsert + API + AI wiring: `backend/src/kb-sync/runner.ts`,
  `backend/src/kb-sync/import.service.ts`, `backend/src/kb-sync/sync.api.ts`,
  `backend/src/domains/host.ts` (`publicKbBase`), `backend/src/ai/handler.ts` +
  `backend/src/ai/draft.ts` (digest param) — commit `2e9e31b`
- UI panel: `frontend/src/kb/KbSyncPanel.tsx`, plus the live prod verification script
  `e2e/scripts/kb-sync-live-check.mjs` — commit `6deeea0`
- Zero-import honesty fix (orchestrator review): `finalOutcome()` in `crawl.ts` — see
  decision #24; landed inside the same feature line, verified live post-deploy.

**60-second verify:** log in to any *throwaway* workspace (never ban-gera for a test run) →
Knowledge Base tab → "📥 Docs import" panel below the domain panel → paste `hono.dev/docs` →
Sync → watch "Found N · Imported N" tick up every 2s → within ~15-20s status flips to
emerald "N articles · synced just now" → open the public KB page for that workspace and see an
imported article rendered.

## Feature 2: Canned responses

**What:** saved, team-shared reply templates. Settings gets a management section (add/edit,
two-click-confirm delete). In the inbox composer (not the widget — visitors never see these),
typing `/` opens a dropdown filtered by title/tag, ↑/↓ + Enter inserts the body, Esc closes; a
`⚡` button toggles the same dropdown for discoverability.

**Where:** `backend/src/canned/canned.api.ts` (`GET/POST/PATCH/DELETE
/api/v1/ws/:wsId/canned`), `frontend/src/settings/CannedSection.tsx`,
`frontend/src/lib/canned.ts` (pure `matchCanned` filter, unit-tested in
`backend/test/canned-match.test.ts`), `Composer` gains the optional `canned` prop — commit
`3626ab0`. E2E: `e2e/tests/canned.spec.ts`.

**60-second verify:** Settings → "Canned responses" → add one (title + body) → open any
conversation in the inbox → type `/` in the composer → see it in the dropdown → Enter → it's in
the textarea → Send.

## Feature 3: SLA tracking

**What:** optional per-workspace first-response and resolution targets (minutes; blank = SLA
off, admin-only setting). Conversation list rows show a chip only when it's actionable (amber
countdown while pending, red once breached); the conversation header shows both metrics
precisely. Computed on read — no cron, no background job. An AI-handled reply counts as a first
response, same as a human agent's (decision #25) — Delegate-to-AI tickets aren't unfairly scored
as permanently breaching SLA.

**Where:** `backend/migrations/0006_sla.sql` (`conversations.first_agent_reply_at`/
`resolved_at`, `workspaces.sla_first_response_min`/`sla_resolution_min`, with a backfill for
existing rows), the single write choke-point in `backend/src/realtime/hub.ts`'s message-insert
UPDATE, status-PATCH in `backend/src/conversations/conversations.api.ts`, workspace PATCH in
`backend/src/workspaces/workspaces.api.ts`, pure `computeSla` in `frontend/src/lib/sla.ts`
(mirrored/tested per plan note in `backend/test/sla.test.ts`), UI in
`frontend/src/inbox/ConversationList.tsx` + `ConversationView.tsx` — commit `83714ad`.

**60-second verify:** Settings (admin) → set both SLA targets to 1–2 minutes → open a fresh
conversation → header shows "First response due in Nm" → wait past target (or reply/don't
reply) → chip flips to breached-red on the list and in the header.

## Feature 4: Contact timeline

**What:** the widget iframe now boots **eagerly** on page load (not lazily on first open) so it
can report page views from the very first visit — this also incidentally fixes the pre-open
unread badge, which previously couldn't receive `sp:unread` until the widget had been opened
once (decision #26). Page navigations (including SPA hash routing, debounced so one navigation
= one report with the settled title) land in a new `contact_events` table. The inbox's contact
panel becomes a "super profile": name/email, **Last seen** (relative time), a recent-activity
feed of pages browsed, and every past conversation with that contact (clickable).

**Where:** `backend/migrations/0007_contact_events.sql`, `backend/src/widget/widget.api.ts`
(`POST /api/v1/widget/events`), `frontend/public/widget.js` (eager iframe + debounced
`postPage()`), `frontend/src/widget/WidgetApp.tsx` (`sp:page` bridge),
`frontend/public/demo.html` (fake 3-page nav for a convincing demo trail) — commit `fa3be02`.
Read API + `ContactPanel` UI: `GET /ws/:wsId/contacts/:contactId/timeline`,
`frontend/src/inbox/ContactPanel.tsx` — commit `ba78a3d`. E2E: `e2e/tests/timeline.spec.ts`.

**60-second verify:** open `sp.hyugorix.com/demo.html?key=<widget key>` in a second tab, click
through the 3 fake nav links without opening the chat → in the dashboard, start/open a
conversation from that visitor → the contact panel shows "Last seen" + the pages just browsed.

## Feature 5: Analytics dashboard

**What:** a new "Analytics" tab (`/w/:wsId/analytics`) — stat cards (totals, resolution rate,
median first-response/resolution minutes), a 14/30/7-day volume bar chart, a 24-hour
busiest-hours row, a per-agent table (replies/assigned/resolved), channel split, and an AI
deflection rate (conversations the AI resolved entirely alone, zero human agent messages) — CSS-
only bars, no chart dependency. Two definitional calls worth knowing: per-agent stats attribute
by the conversation's **current** assignee, not a full reassignment history (decision #28,
approximation — fine for a small team, flagged as a trade-off not an oversight); the resolution
median only counts conversations a human/AI actually engaged with before closing (has both
`resolved_at` and `first_agent_reply_at`) — AI-alone resolutions are reported separately via
deflection rate so one metric can't dilute the other (decision #29).

**Where:** `backend/src/analytics/analytics.api.ts` (`GET /ws/:wsId/analytics?days=`),
`backend/src/analytics/compute.ts` (pure `computeAnalytics`, unit-tested in
`backend/test/analytics-compute.test.ts` — medians on empty/odd/even sets, zero-denominator
rates), `frontend/src/analytics/AnalyticsPage.tsx`, nav item in `frontend/src/components
/Shell.tsx` — commit `053c17e`.

**60-second verify:** Analytics tab → range toggle 7/14/30 days → stat cards + bars render with
real numbers from prod's existing demo data; AI deflection rate should be non-zero given the
Delegate-to-AI conversations already in ban-gera.

---

## Live demo script (run this on ban-gera, in this exact order)

Order matters — step 1 must run *before* step 2 on the same workspace, because a failed sync
never arms the cooldown but a successful one does; running the bot-protection failure first
costs nothing and sets up the "honest failure → real success" narrative for evaluators.

1. **KB page (ban-gera) → Docs import panel → paste `https://superprofile.bio/blog` → Sync.**
   Watch it end **FAILED** with the bot-protection message ("This site blocks automated access
   (bot protection). Try a different docs URL.") — no cooldown armed, button stays enabled.
2. **Same panel → paste `https://hono.dev/docs` → Sync.** Watch the counters tick up live
   ("Found N · Imported N"), status flips to emerald "N articles · synced just now" — articles
   are now live on `docs.kaushikrb.com` (ban-gera's custom domain).
3. **Widget demo page → browse Pricing/Features (or the demo's fake nav links) → open a
   ticket.** In the dashboard inbox, the contact panel shows the browsing trail + "Last seen."
4. **Composer: type `/`** → a canned response inserts. **Settings:** set SLA targets to 1–2
   minutes → chips on the conversation list/header count down and flip red once breached.
5. **Delegate to AI** on a ticket related to something in the imported Hono docs → the AI's
   reply cites an imported article by its `docs.kaushikrb.com` URL — the digest generated in
   step 2 is what makes this possible even if full-text search alone wouldn't have surfaced it.
6. **Analytics tab** → live numbers, including the AI deflection rate.

---

## Notes

- **After step 2 of the demo (the hono.dev sync), ban-gera's KB-sync cooldown arms for 24h**
  (`KB_SYNC_COOLDOWN_MIN` default 1440). If you want to **rehearse the demo more than once**
  before the real evaluation, temporarily lower `KB_SYNC_COOLDOWN_MIN` in `backend/wrangler.jsonc`
  (`vars`) to something small (e.g. `1`) and redeploy (`cd backend && npx wrangler deploy`), run
  through it, then set it back to `1440` and redeploy again before the real session — otherwise
  an evaluator re-running the sync mid-demo will just see "Next sync available in ~24h" instead
  of a live crawl. The bot-protection step (superprofile.bio) never arms the cooldown, so you can
  re-run *that* half as many times as you like without redeploying anything.
- **Throwaway `sync-check-*` workspaces exist in prod** (created by tonight's live-verification
  script and the Playwright prod-smoke run against real workspaces it creates itself) — these are
  expected clutter, entirely ignorable, and never touch ban-gera.
- **Resolution-median definition** (worth knowing before reading the Analytics tab yourself):
  it only counts conversations that were actually engaged with by a human or the AI before
  closing — an AI-alone resolution doesn't count toward it (that's what the deflection rate is
  for). See decision #29 if you want the full reasoning.
- **Nothing here requires your hands** beyond the optional cooldown-rehearsal step above — all
  five features are already live on `https://sp.hyugorix.com` and `https://docs.kaushikrb.com`.
  Everything from the *previous* night's MORNING.md (custom domains connect-UI playbook, DMARC
  TXT record change, real inbound email transport decision, Resend quota check) is untouched and
  still pending exactly as previously documented — see `decision.md` #1–22 and the prior
  `docs/superpowers/plans/2026-07-10-super-profile-implementation.md` Task 12 for those.
- **Minor pre-existing README staleness spotted and fixed:** the "Built vs. skipped" table's
  "AI draft replies" row still said "Skipped" even though "Delegate to AI" (autonomous
  KB-grounded replies) was built in the session *before* this one (commit `1fd3aa8`) — corrected
  in tonight's README pass since it directly contradicted the new feature list. Flagging in case
  there's other drift from that same gap worth a closer read when you're up.
