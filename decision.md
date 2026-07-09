# Decision Log

Dilemmas resolved autonomously. Format: Context → Options → Chosen → Why.
Entries below the line were made during the max-effort design review (user awake, informed in
chat); everything after gets appended during the overnight run.

---

## 1. Frontend hosting: Cloudflare Pages → Workers Static Assets (same Worker)

- **Context:** Refresh token lives in a `SameSite=Strict` HttpOnly cookie. Dashboard on
  `*.pages.dev` calling API on `*.workers.dev` is cross-site: the browser would never send that
  cookie → silent auth failure; fixing via `SameSite=None` guts the CSRF design and fights
  Chrome's third-party-cookie phaseout.
- **Options:** (a) Pages + SameSite=None; (b) Pages + proxy tricks; (c) serve the built SPA from
  the same Worker via Workers Static Assets.
- **Chosen:** (c). One origin for app+API+WS+widget+KB; zero dashboard CORS; cookie stays
  Strict; single `wrangler deploy`; also Cloudflare's current recommended direction over Pages.
- **Why it's safe:** user's requirement was "React frontend, hosted on Cloudflare" — that holds;
  only the serving mechanism changed, in service of the user's own security design.

## 2. Custom domains: full skip → "lite" implementation — **SUPERSEDED by user**

> User (before sleeping): skip entirely overnight; do it together in the morning. Overnight
> deliverable = README approach section only. Plan Task 12 kept as the morning playbook,
> marked DO-NOT-EXECUTE. Original reasoning below for the record.

- **Context:** User said skip. But the assignment marks all 7 features non-negotiable
  ("Partial submissions will not be reviewed") while explicitly allowing a stub:
  "Explain your approach even if you stub the DNS verification."
- **Options:** (a) README paragraph only; (b) lite: connect UI + real DoH TXT verification +
  Host-header KB resolution, SSL stubbed + documented; (c) full Cloudflare-for-SaaS integration.
- **Chosen:** (b), ~1.5h scoped, last implementation phase so it can degrade to (a) under time
  pressure.
- **Why:** feature 7 shows up as *working verification demo + honest SSL stub* instead of a
  missing feature. (c) needs paid features + real second domain to demo — not worth it.

## 3. Widget: loader + same-origin iframe (not Preact bundle injected into host DOM)

- **Options:** (a) Preact/shadow-DOM bundle in host page; (b) <2KB vanilla loader that lazily
  mounts an iframe onto `/widget-app` (a route of our own React SPA).
- **Chosen:** (b). CSS/JS isolation for free, zero host-page weight until opened, same-origin
  API+WS inside the iframe (no CORS/cookie pain), one frontend toolchain to maintain overnight,
  and it's the architecture Intercom itself uses.
- **Trade-off:** iframe localStorage is partitioned per host site → same visitor on two
  different customer sites = two identities. That's correct per-tenant behavior anyway.

## 4. E2E auth for autonomous testing: `DEBUG_AUTH_SECRET` header echo

- **Context:** Magic-link-only login + Playwright can't read mailboxes overnight.
- **Chosen:** `POST /auth/magic-link` with header `X-Debug-Auth: <secret>` additionally returns
  the raw token in `data`. Secret is a Worker secret, never committed; without the header the
  endpoint is byte-identical to prod behavior. Evaluators unaffected.
- **Rejected:** disabling auth in a test mode (diverges from what evaluators test); scraping
  Gmail via browser (flaky at 3am).
- **Extended in Task 3:** the same `X-Debug-Auth` gate now also echoes the raw invite token from
  `POST /ws/:wsId/invites` — same rationale (no mailbox access overnight), and it avoids sending
  real Resend emails to made-up test addresses during verification.

## 5. Inbound email: per-workspace addresses + layered transport fallback

- **Context:** hyugorix.com MX belongs to Microsoft 365 (user's real mail) — the apex can never
  point at Cloudflare Email Routing. Multi-workspace product needs per-workspace routing.
- **Chosen:** `<wsSlug>@inbox.hyugorix.com` catch-all; transports in order: CF Email Routing
  subdomain → Resend Inbound webhook → simulator endpoint. Outbound Reply-To carries
  `<wsSlug>+<conversationId>@` plus-addressing so threading survives Message-ID rewrites.
- **Note:** wrangler token can't write DNS; if API/dashboard automation can't finish MX setup,
  it lands in MORNING.md and the simulator carries the demo until then.

## 6. No Cloudflare Queues

- **Context:** Eval criteria mention "queue-based processing".
- **Chosen:** D1 writes serialized through the per-workspace DO (ordering guarantee), outbound
  email via `ctx.waitUntil` with failure recorded as a SYSTEM message. Queues add deploy surface
  without a real workload at this scale. README documents this as a deliberate trade-off with
  the "when we'd add Queues" line (retries/spikes/fan-out).

## 7. Testing stack: plain vitest (pure logic) + Playwright E2E; no vitest-pool-workers

- **Why:** pool-workers setup friction is real and the true integration risk (DO+D1+WS+assets
  together) is covered end-to-end by Playwright against `wrangler dev` and against prod.
  Pure logic (threading matcher, envelope, tokens, validators) unit-tested in plain vitest.

## 8. KB "rich text editor" requirement → markdown editor (user decision, framing noted)

- Markdown textarea + formatting toolbar + live preview, rendered via marked+DOMPurify. README
  frames it as a deliberate choice (portable content, sanitizable, real products do this);
  toolbar covers the "rich" editing affordance.

## 9. Rate limiting ships flag-off (user decision)

- `FLAG.RATE_LIMIT_ENABLED = false` hardcoded; RateLimiter DO + middleware fully implemented and
  unit-tested so flipping the constant turns it on. README documents where and why.

---
<!-- Overnight entries append below -->

## 10. 404 handling: scoped `/api/v1/*` fallback instead of `app.notFound()`

- **Context:** Plan Task 1 called for `app.notFound()` → `ctxErr.general.notFound()` for bogus-route
  400s. But `index.ts` ends with `app.all('*', c => c.env.ASSETS.fetch(c.req.raw))` for the SPA —
  once a catch-all route pattern is registered, Hono considers every request "matched", so
  `app.notFound()` never fires (it only runs when no route pattern matches at all).
- **Chosen:** an explicit `app.all('/api/v1/*', () => { throw ctxErr.general.notFound() })`
  registered after the real API routes but before the SPA catch-all. Bogus `/api/v1/...` paths get
  the 400 envelope; genuine frontend paths still fall through to `ASSETS.fetch` for the SPA.
  Verified via curl against `wrangler dev`.
- **Why it's safe:** functionally identical outcome to what the plan asked for (bogus API route →
  400 NOT_FOUND envelope); the mechanism differs only because of a Hono routing nuance the plan
  didn't anticipate.

## 11. Workspace PATCH drops `supportEmail` (init.md contract vs. actual schema)

- **Context:** init.md's API contract lists `PATCH /ws/:wsId {name?, widgetColor?, supportEmail?}`,
  but the `workspaces` table (0001_init.sql) has no `support_email` column, and no other part of
  the spec (email module, KB, widget) reads or writes a per-workspace support email — outbound
  mail already uses `<slug>@notifications.hyugorix.com` unconditionally.
- **Chosen:** implement PATCH with only `{name?, widgetColor?}`. Adding an unused column this late
  risks a needless migration for a field nothing consumes.
- **Why it's safe:** no feature depends on it; if evaluators want it, it's a one-column migration
  away and the pattern (zod-validated partial PATCH) is already in place.

## 12. Invite-accept requires the accepting user's verified email to match the invite

- **Context:** init.md/plan don't explicitly say to cross-check emails on `POST
  /auth/invite-accept` — only that the invite token itself is consumed atomically. But invite
  tokens are bearer-style secrets; without an email check, anyone who obtains a leaked/guessed
  invite token while logged into *any* account could join the target workspace.
- **Chosen:** reject with `NOT_AUTHORIZED` ("This invite is for a different email address") unless
  the authenticated user's `users.email` matches `invites.email` exactly.
- **Why it's safe:** matches the invite's implied contract (an invite is *for* a specific email);
  costs one extra SELECT; doesn't block the intended flow (recipient signs in via magic link with
  the invited address, then accepts).

## 13. Email transport: real inbound routing stays out of scope tonight — simulator carries the demo

- **Context:** Task 6 asked me to try wiring real inbound transport (Cloudflare Email Routing or
  Resend Inbound) for `inbox.hyugorix.com` before falling back to the simulator.
- **Investigated (read-only, no DNS changes made):**
  - **Cloudflare Email Routing** on the `hyugorix.com` zone: already has 5 pre-existing routing
    rules (support@/info@/help@/company@/kaushik@ → kaushikrb909@gmail.com) but the whole feature
    shows **Status: Disabled, DNS records: Not configured** — i.e. it was set up at some point but
    never activated, and today's MX truly is Microsoft 365 only. Critically, Cloudflare Email
    Routing is a **zone-level** feature: enabling it adds/changes MX records at the zone's apex
    (`hyugorix.com`), not scoped to a subdomain. There is no dashboard option to scope it to only
    `inbox.hyugorix.com` while leaving the apex MX untouched. Enabling it would violate the
    absolute rule "never modify apex hyugorix.com records" — did not proceed.
  - **Resend Inbound**: checked the Resend dashboard (Domains → notifications.hyugorix.com) —
    no "Receiving"/"Inbound" tab is present in this account, only Records/Configuration. The
    feature isn't available/enabled here.
- **Chosen:** stick with the simulator endpoint (`POST /api/v1/email/inbound` with
  `X-Inbound-Secret`) as the demo path for the assignment. It is fully implemented and verified
  end-to-end tonight: simulated inbound → new EMAIL conversation; agent reply → **real** Resend
  send to kaushikrb909@gmail.com (confirmed via Gmail "Show original": correct From, Reply-To
  plus-address, In-Reply-To/References headers, SPF/DKIM/DMARC all PASS); simulated customer
  replies via both plus-addressing and In-Reply-To/References header matching both correctly
  threaded into the same conversation with zero duplicates.
- **Why it's safe:** doesn't touch the user's real Microsoft 365 mail; the full pipeline (parsing,
  threading, outbound send, real headers) is proven end-to-end — only the "how does a real email
  physically reach our Worker" leg is stubbed, exactly the kind of thing the assignment explicitly
  allows stubbing with an honest explanation. Real transport setup (enabling Cloudflare Email
  Routing at the apex, which needs the user's explicit go-ahead since it's their real work email)
  is now a MORNING.md task.

## 14. Team-management UI lives on the "Settings" page, built in Task 7 (no dedicated task existed)

- **Context:** the plan's task list never assigns a frontend task to invites/team-management UI —
  Shell's sidebar has a "Settings" nav item (Task 7) but no task builds its contents, even though
  invite/role-management is required assignment feature #1 and the backend (Task 3) was already
  complete.
- **Chosen:** built a real (not placeholder) `SettingsPage` in Task 7 — workspace rename,
  members list with role change/remove (ADMIN-gated) and last-admin guard reflected via the
  existing 400 errors, invite form + pending-invites list with revoke.
- **Why it's safe:** the backend contract was already finalized in Task 3; this just fills a real
  gap in task coverage rather than adding scope beyond the assignment's non-negotiable feature 1.
