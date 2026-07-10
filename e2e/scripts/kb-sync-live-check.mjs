// One-shot prod verification for KB sync. Creates a THROWAWAY workspace, verifies the
// bot-protection failure path (superprofile.bio) then the happy path (hono.dev/docs).
//   BASE_URL=https://sp.hyugorix.com DEBUG_AUTH_SECRET=... node scripts/kb-sync-live-check.mjs
const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const DEBUG = process.env.DEBUG_AUTH_SECRET;
if (!DEBUG) throw new Error("DEBUG_AUTH_SECRET required");

async function api(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(path.includes("magic-link") ? { "X-Debug-Auth": DEBUG } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const env = await res.json();
  if (env.code !== "OK") throw new Error(`${path} -> ${env.code}: ${env.msg}`);
  return env.data;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function newWorkspace(label) {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const { debugToken } = await api("/api/v1/auth/magic-link", { method: "POST", body: { email: `sync-check-${suffix}@example.com` } });
  const { accessToken } = await api("/api/v1/auth/verify", { method: "POST", body: { token: debugToken } });
  const { workspace } = await api("/api/v1/workspaces", { method: "POST", body: { slug: `sync-check-${suffix}` }, token: accessToken });
  console.log(`workspace (${label}):`, workspace.id, workspace.slug);
  return { workspace, accessToken };
}

const blocked = await newWorkspace("blocked-path");

// 1) Bot-protected site — must end FAILED with an honest error. A fully-blocked site yields a
// single challenged fetch (no links to follow), so the whole-run outcome comes from the
// zero-imports finalOutcome() classification: bot-protection message if any fetch was blocked,
// no-content message otherwise. FAILED never arms the cooldown, so this workspace could even be
// reused — we still run the happy path on a fresh one to keep the checks independent.
await api(`/api/v1/ws/${blocked.workspace.id}/kb/sync`, { method: "POST", body: { url: "https://superprofile.bio/blog" }, token: blocked.accessToken });
let bs;
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  ({ source: bs } = await api(`/api/v1/ws/${blocked.workspace.id}/kb/sync`, { token: blocked.accessToken }));
  if (bs.status !== "RUNNING") break;
  console.log("  blocked-path:", bs.status, bs.pagesFound, "found");
}
if (bs.status !== "FAILED" || !/bot protection|couldn't import/i.test(bs.error ?? "")) {
  throw new Error(
    `expected FAILED with an honest error, got status=${bs.status} imported=${bs.pagesImported} ` +
      `failed=${bs.pagesFailed} error=${bs.error}`,
  );
}
console.log("ok: zero-import sync fails honestly:", bs.error);

// 2) Happy path — hono.dev/docs, on a fresh workspace to keep the checks independent.
const { workspace, accessToken } = await newWorkspace("happy-path");
await api(`/api/v1/ws/${workspace.id}/kb/sync`, { method: "POST", body: { url: "https://hono.dev/docs" }, token: accessToken });
let s;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  ({ source: s } = await api(`/api/v1/ws/${workspace.id}/kb/sync`, { token: accessToken }));
  console.log("  happy-path:", s.status, `${s.pagesImported} imported / ${s.pagesFound} found`);
  if (s.status !== "RUNNING") break;
}
if (s.status !== "DONE" || s.pagesImported < 5) throw new Error(`expected DONE with >=5 imports, got ${s.status} / ${s.pagesImported}`);

// 3) Cooldown now armed.
const dup = await fetch(`${BASE}/api/v1/ws/${workspace.id}/kb/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ url: "https://hono.dev/docs" }),
}).then((r) => r.json());
if (dup.code !== "KB_SYNC_COOLDOWN") throw new Error(`expected KB_SYNC_COOLDOWN, got ${dup.code}`);
console.log("ok: cooldown armed:", dup.msg);

// 4) Articles are live and searchable on the public KB.
// NOTE: GET /api/v1/public/kb/:wsSlug (backend/src/kb/public.api.ts) returns
// { workspace, collections: [{..., articles: [...] }], uncategorized: [...] } — no top-level
// "articles" field, so imported pages (created with no collectionId) land in `uncategorized`.
const { articles } = await api(`/api/v1/ws/${workspace.id}/kb/articles`, { token: accessToken });
const imported = articles.filter((a) => a.status === "PUBLISHED");
console.log(`ok: ${imported.length} published articles, e.g. "${imported[0]?.title}"`);
const pub = await api(`/api/v1/public/kb/${workspace.slug}`);
const pubArticleCount =
  (pub.collections ?? []).reduce((n, col) => n + col.articles.length, 0) + (pub.uncategorized?.length ?? 0);
console.log(
  "ok: public KB lists",
  (pub.collections ?? []).length,
  "collections and",
  pubArticleCount,
  "published article(s) (uncategorized:",
  pub.uncategorized?.length ?? 0,
  ")",
);

console.log("\nALL CHECKS PASSED — workspace", workspace.slug, "(throwaway, can be ignored)");
