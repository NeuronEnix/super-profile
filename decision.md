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

## 2. Custom domains: full skip → "lite" implementation

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
