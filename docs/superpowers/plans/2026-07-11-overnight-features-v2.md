# Overnight Features v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five features in priority order: KB sync from an existing docs site (+ AI docs digest), canned responses, SLA tracking, contact timeline, analytics dashboard.

**Architecture:** Everything on the existing Cloudflare stack (Workers + Hono, D1, Durable Objects, Workers AI). The sync engine is a new `KbSyncRunner` DO (single-threaded per workspace = concurrency safety; alarm loop = the async queue). All other features are D1 tables + API routes + React components following the codebase's established patterns.

**Tech Stack:** TypeScript, Hono, D1/SQLite, Durable Objects, Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), React+Vite+Tailwind, vitest (plain node — NO workers pool), Playwright. One new dependency: `node-html-parser` (backend).

**Spec:** `docs/superpowers/specs/2026-07-11-overnight-features-v2-design.md` — read it first.

## Execution protocol (orchestrator + subagents)

- The orchestrator (Fable, this session) dispatches ONE subagent per task (Sonnet, thinking high). The subagent reads `CLAUDE.md`, the spec, and its own task section, then executes every step **except the git commit/push steps** — the orchestrator reviews the diff and commits.
- Subagents run tests/builds/deploys themselves. All wrangler commands need `CLOUDFLARE_ACCOUNT_ID=5c06421b792bba8d18c35d4d575c0b71` in the environment.
- `pnpm --dir frontend build` must run **from the repo root** (running it from `backend/` fails with ENOENT).
- Never ask the user anything. Dilemmas → pick per CLAUDE.md priorities and append to `decision.md`. User-required actions → `MORNING.md`.
- Tick the checkboxes in THIS file as steps complete.

## Global constraints (from CLAUDE.md — violating these = wrong)

- Response envelope: HTTP **200/400/500 only**, body exactly `{code, msg, data}`; `data` always an object.
- Errors via `ctxErr.<domain>.<factory>()` returning `CtxError`; one global `onError` maps them.
- Constants: nested `as const` trees in `backend/src/common/const.ts`, values UPPERCASE.
- IDs: `uuidv7()` from `backend/src/common/id.ts`. Config via `getConfig(env)` — never `process.env`.
- **Tests never make third-party requests.** No test may fetch hono.dev, superprofile.bio, Resend, or any external host. Unit tests use inline HTML fixtures; e2e runs against localhost only. The single live hono.dev sync in Task 5 is a hand-run verification **script**, not part of any test suite.
- Do not crawl our own hostnames (worker self-fetch = error 1042). `normalizeDocsUrl` must reject them.
- Never touch the `ban-gera` workspace on prod. Prod verification uses throwaway workspaces created via the debug-auth flow.
- Commit after every green step (orchestrator does the committing), push after every task, deploy + prod-smoke after every feature.

---

### Task 1: KB sync foundations (migration, consts, config, errors, DO registration)

**Files:**
- Create: `backend/migrations/0005_kb_sync.sql`
- Modify: `backend/src/common/const.ts`
- Modify: `backend/src/config/env.config.ts`
- Modify: `backend/src/types.ts`
- Modify: `backend/src/ctx/ctx.error.ts`
- Modify: `backend/wrangler.jsonc`
- Modify: `backend/.dev.vars` (gitignored — append, never commit)

**Interfaces (produced for later tasks):**
- `KB_SYNC` const tree, `AI_CONF.DIGEST`, `CONTACT_EVENT` const
- `getConfig(env).KB_SYNC_COOLDOWN_MIN: number`
- `ctxErr.kbSync.{invalidUrl,cooldown,alreadyRunning}`, `ctxErr.canned.notFound`, `ctxErr.contact.notFound`
- `Env.KB_SYNC: DurableObjectNamespace`
- Tables `kb_sync_sources`, columns `kb_articles.source_url`, `workspaces.kb_digest`, `workspaces.kb_digest_at`

- [x] **Step 1: Write migration `backend/migrations/0005_kb_sync.sql`**

```sql
CREATE TABLE kb_sync_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','DONE','FAILED')),
  pages_found INTEGER NOT NULL DEFAULT 0,
  pages_imported INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  requested_by TEXT NOT NULL,
  started_at INTEGER,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE kb_articles ADD COLUMN source_url TEXT;
CREATE UNIQUE INDEX idx_kb_articles_source ON kb_articles(workspace_id, source_url)
  WHERE source_url IS NOT NULL;
ALTER TABLE workspaces ADD COLUMN kb_digest TEXT;
ALTER TABLE workspaces ADD COLUMN kb_digest_at INTEGER;
```

- [x] **Step 2: Apply locally and verify**

Run: `cd backend && CI=true npx wrangler d1 migrations apply super-profile --local`
Expected: `0005_kb_sync.sql` listed as applied, no error.

- [x] **Step 3: Add consts** — in `backend/src/common/const.ts`, after the `DOMAIN` line add:

```ts
export const KB_SYNC = { STATUS: { RUNNING: "RUNNING", DONE: "DONE", FAILED: "FAILED" },
  PAGE_CAP: 15, ARTICLE_CAP: 10, BATCH_SIZE: 5, FETCH_TIMEOUT_MS: 10_000,
  MAX_HTML_BYTES: 2_000_000, MIN_CONTENT_CHARS: 80, BLOCKED_STREAK_LIMIT: 3,
  STALE_RUNNING_MS: 15 * 60 * 1000,
  USER_AGENT: "SuperProfileBot/1.0 (+https://sp.hyugorix.com)",
  BLOCKED_MSG: "This site blocks automated access (bot protection). Try a different docs URL." } as const;
export const CONTACT_EVENT = { TYPE: { PAGE_VIEW: "PAGE_VIEW" } } as const;
```

and inside `AI_CONF` (after the `HANDLER` line, before ` } as const`):

```ts
  DIGEST: { MAX_ARTICLES: 60, PER_ARTICLE_EXCERPT: 200, MAX_TOKENS: 900, CHAR_CAP: 4_000 },
```

- [x] **Step 4: Config + Env.** In `backend/src/types.ts` add to `Env`: `KB_SYNC: DurableObjectNamespace;` and `KB_SYNC_COOLDOWN_MIN?: string;`. In `backend/src/config/env.config.ts` add to `Config`: `KB_SYNC_COOLDOWN_MIN: number;` and to the returned object: `KB_SYNC_COOLDOWN_MIN: Number(env.KB_SYNC_COOLDOWN_MIN ?? "1440") || 1440,`.

- [x] **Step 5: Error namespaces.** In `backend/src/ctx/ctx.error.ts`, after the `domain` namespace add:

```ts
  export const kbSync = {
    invalidUrl: (e?: TResErr) =>
      new CtxError({ name: "KB_SYNC_INVALID_URL", msg: "Enter a valid docs site URL (e.g. docs.yourcompany.com)", ...e }),
    cooldown: (e?: TResErr) =>
      new CtxError({ name: "KB_SYNC_COOLDOWN", msg: "You can sync again later", ...e }),
    alreadyRunning: (e?: TResErr) =>
      new CtxError({ name: "KB_SYNC_ALREADY_RUNNING", msg: "A sync is already in progress", ...e }),
  };

  export const canned = {
    notFound: (e?: TResErr) =>
      new CtxError({ name: "CANNED_NOT_FOUND", msg: "Canned response not found", ...e }),
  };

  export const contact = {
    notFound: (e?: TResErr) =>
      new CtxError({ name: "CONTACT_NOT_FOUND", msg: "Contact not found", ...e }),
  };
```

- [x] **Step 6: wrangler.jsonc.** Add to `durable_objects.bindings`: `{ "name": "KB_SYNC", "class_name": "KbSyncRunner" }`. Append to `migrations`: `{ "tag": "v2", "new_sqlite_classes": ["KbSyncRunner"] }`. Add to `vars`: `"KB_SYNC_COOLDOWN_MIN": "1440"`. Append `KB_SYNC_COOLDOWN_MIN=1` to `backend/.dev.vars` (file is gitignored).

- [x] **Step 7: Green check.** Run: `cd backend && pnpm test` — all suites pass (110 tests, nothing new yet). NOTE: the worker won't typecheck/deploy until Task 4 exports `KbSyncRunner`; that's expected — do NOT deploy in this task.

- [ ] **Step 8: Commit** (orchestrator): `git add -A && git commit -m "feat(kb-sync): schema, consts, config and error scaffolding"`

---

### Task 2: Crawler pure functions (`node-html-parser` + tests)

**Files:**
- Create: `backend/src/kb-sync/crawl.ts`
- Test: `backend/test/kb-sync-crawl.test.ts`

**Interfaces (produced):**
- `type DocsSource = { startUrl: string; origin: string; pathPrefix: string }`
- `normalizeDocsUrl(input: string): DocsSource | null`
- `inScope(url: string, source: DocsSource): boolean`
- `extractLinks(html: string, baseUrl: string): string[]`
- `extractMainContent(html: string): { title: string; contentHtml: string }`
- `htmlToMarkdown(html: string): string`
- `deriveCollectionName(pageUrl: string, source: DocsSource): string | null`
- `isBlockedResponse(status: number, header: (name: string) => string | null, body: string): boolean`
- `cooldownRemainingMs(lastSyncedAt: number | null, cooldownMin: number, nowMs: number): number`
- `humanizeMs(ms: number): string`
- `nextBatch(frontier: string[], visitedCount: number, importedCount: number): number` — how many URLs to process this alarm

- [x] **Step 1: Install the parser.** Run from repo root: `pnpm --dir backend add node-html-parser`
Expected: added to backend/package.json dependencies.

- [x] **Step 2: Write the failing tests** — `backend/test/kb-sync-crawl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  cooldownRemainingMs, deriveCollectionName, extractLinks, extractMainContent,
  htmlToMarkdown, humanizeMs, inScope, isBlockedResponse, nextBatch, normalizeDocsUrl,
} from "../src/kb-sync/crawl";

const SRC = normalizeDocsUrl("https://docs.acme.com/help")!;

describe("normalizeDocsUrl", () => {
  it("adds https and strips hash/query/trailing slash", () => {
    expect(normalizeDocsUrl("docs.acme.com")).toEqual({
      startUrl: "https://docs.acme.com/", origin: "https://docs.acme.com", pathPrefix: "",
    });
    expect(normalizeDocsUrl("https://docs.acme.com/help/?x=1#top")).toEqual({
      startUrl: "https://docs.acme.com/help", origin: "https://docs.acme.com", pathPrefix: "/help",
    });
  });
  it("rejects junk, IPs, own zones and localhost", () => {
    for (const bad of ["", "not a url", "ftp://x.com", "localhost", "127.0.0.1", "10.0.0.8",
      "sp.hyugorix.com", "anything.hyugorix.com", "foo.workers.dev", "docs"]) {
      expect(normalizeDocsUrl(bad)).toBeNull();
    }
  });
});

describe("inScope", () => {
  it("same origin + path prefix", () => {
    expect(inScope("https://docs.acme.com/help/setup", SRC)).toBe(true);
    expect(inScope("https://docs.acme.com/help", SRC)).toBe(true);
    expect(inScope("https://docs.acme.com/pricing", SRC)).toBe(false);
    expect(inScope("https://evil.com/help/setup", SRC)).toBe(false);
    expect(inScope("https://docs.acme.com/helpful", SRC)).toBe(false);
  });
  it("root prefix covers the whole origin", () => {
    const root = normalizeDocsUrl("docs.acme.com")!;
    expect(inScope("https://docs.acme.com/anything/deep", root)).toBe(true);
  });
});

describe("extractLinks", () => {
  it("resolves relative links, canonicalizes, filters junk schemes and dedupes", () => {
    const html = `<a href="/help/a">A</a><a href="b">B</a><a href="#frag">skip</a>
      <a href="mailto:x@y.z">skip</a><a href="https://other.com/x">ext</a>
      <a href="/help/a?utm=1#x">dupe of A</a>`;
    const links = extractLinks(html, "https://docs.acme.com/help/index");
    expect(links).toContain("https://docs.acme.com/help/a");
    expect(links).toContain("https://docs.acme.com/help/b");
    expect(links).toContain("https://other.com/x"); // scope filtering happens later
    expect(links.filter((l) => l === "https://docs.acme.com/help/a")).toHaveLength(1);
    expect(links.some((l) => l.includes("mailto"))).toBe(false);
  });
});

describe("extractMainContent", () => {
  it("prefers <main>, strips nav/aside/footer and sidebar classes, trims title suffix", () => {
    const html = `<html><head><title>Setup | Acme Docs</title></head><body>
      <nav>NAVJUNK</nav>
      <main><h1>Setup guide</h1><div class="sidebar">SIDEJUNK</div><p>Real content here.</p></main>
      <footer>FOOTJUNK</footer></body></html>`;
    const { title, contentHtml } = extractMainContent(html);
    expect(title).toBe("Setup guide");
    expect(contentHtml).toContain("Real content here.");
    for (const junk of ["NAVJUNK", "SIDEJUNK", "FOOTJUNK"]) expect(contentHtml).not.toContain(junk);
  });
  it("falls back to the densest body section when no main/article", () => {
    const html = `<body><div id="tiny">hi</div><div id="big"><p>${"word ".repeat(50)}</p></div></body>`;
    expect(extractMainContent(html).contentHtml).toContain("word");
  });
});

describe("htmlToMarkdown", () => {
  it("converts headings, paragraphs, lists, code, links, emphasis", () => {
    const md = htmlToMarkdown(
      `<h2>Install</h2><p>Run the <strong>installer</strong> and <em>wait</em>.</p>
       <ul><li>First</li><li>Second <a href="/docs/x">docs</a></li></ul>
       <pre><code class="language-ts">const a = 1;</code></pre>
       <p>Inline <code>npm i</code> works.</p>`,
    );
    expect(md).toContain("## Install");
    expect(md).toContain("**installer**");
    expect(md).toContain("*wait*");
    expect(md).toContain("- First");
    expect(md).toContain("[docs](/docs/x)");
    expect(md).toContain("```ts\nconst a = 1;\n```");
    expect(md).toContain("`npm i`");
    expect(md).not.toMatch(/\n{3,}/);
  });
  it("renders ordered lists and tables", () => {
    const md = htmlToMarkdown(
      `<ol><li>one</li><li>two</li></ol>
       <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$9</td></tr></table>`,
    );
    expect(md).toContain("1. one");
    expect(md).toContain("2. two");
    expect(md).toContain("| Plan | Price |");
    expect(md).toContain("| Pro | $9 |");
  });
});

describe("deriveCollectionName", () => {
  it("uses the first path segment below the prefix, title-cased", () => {
    expect(deriveCollectionName("https://docs.acme.com/help/getting-started/install", SRC)).toBe("Getting Started");
    expect(deriveCollectionName("https://docs.acme.com/help/api_reference/auth", SRC)).toBe("Api Reference");
  });
  it("top-level pages get no collection", () => {
    expect(deriveCollectionName("https://docs.acme.com/help/overview", SRC)).toBeNull();
    expect(deriveCollectionName("https://docs.acme.com/help", SRC)).toBeNull();
  });
});

describe("isBlockedResponse", () => {
  const h = (map: Record<string, string>) => (name: string) => map[name.toLowerCase()] ?? null;
  it("detects 403/429 and challenge markers", () => {
    expect(isBlockedResponse(429, h({}), "")).toBe(true);
    expect(isBlockedResponse(403, h({}), "")).toBe(true);
    expect(isBlockedResponse(200, h({ "x-vercel-mitigated": "challenge" }), "")).toBe(true);
    expect(isBlockedResponse(200, h({}), "<title>Vercel Security Checkpoint</title>")).toBe(true);
    expect(isBlockedResponse(200, h({}), "<title>Acme Docs</title>")).toBe(false);
    expect(isBlockedResponse(404, h({}), "")).toBe(false);
  });
});

describe("cooldown + humanize + nextBatch", () => {
  it("cooldownRemainingMs", () => {
    expect(cooldownRemainingMs(null, 1440, 1_000_000)).toBe(0);
    expect(cooldownRemainingMs(1_000_000, 1, 1_000_000 + 30_000)).toBe(30_000);
    expect(cooldownRemainingMs(1_000_000, 1, 1_000_000 + 61_000)).toBe(0);
  });
  it("humanizeMs", () => {
    expect(humanizeMs(30_000)).toBe("1 min");
    expect(humanizeMs(90 * 60_000)).toBe("1h 30m");
    expect(humanizeMs(120 * 60_000)).toBe("2h");
  });
  it("nextBatch respects both caps and the batch size", () => {
    expect(nextBatch(["a", "b", "c", "d", "e", "f"], 0, 0)).toBe(5); // BATCH_SIZE
    expect(nextBatch(["a", "b"], 14, 0)).toBe(1); // PAGE_CAP 15
    expect(nextBatch(["a", "b"], 0, 10)).toBe(0); // ARTICLE_CAP 10
    expect(nextBatch([], 0, 0)).toBe(0);
  });
});
```

- [x] **Step 3: Run tests to verify they fail.** `cd backend && pnpm test kb-sync-crawl` — FAIL (module not found).

- [x] **Step 4: Implement `backend/src/kb-sync/crawl.ts`:**

```ts
import { parse, HTMLElement, Node, NodeType } from "node-html-parser";
import { KB_SYNC } from "../common/const";

export type DocsSource = { startUrl: string; origin: string; pathPrefix: string };

// Own zones (self-fetch = subrequest loop, error 1042), localhost and raw IPs are never crawlable.
const FORBIDDEN_HOST_RE = /(^|\.)(hyugorix\.com|workers\.dev|localhost|local|internal)$/i;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function normalizeDocsUrl(input: string): DocsSource | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.includes(":") || IP_RE.test(host) || FORBIDDEN_HOST_RE.test(host)) return null;
  const pathPrefix = url.pathname.replace(/\/+$/, "");
  return { startUrl: `${url.origin}${pathPrefix || "/"}`, origin: url.origin, pathPrefix };
}

export function inScope(rawUrl: string, source: DocsSource): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.origin !== source.origin) return false;
  const path = u.pathname.replace(/\/+$/, "");
  return source.pathPrefix === "" || path === source.pathPrefix || path.startsWith(`${source.pathPrefix}/`);
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const root = parse(html);
  const out = new Set<string>();
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      const abs = new URL(href, baseUrl);
      if (abs.protocol !== "https:" && abs.protocol !== "http:") continue;
      abs.hash = "";
      abs.search = "";
      out.add(abs.toString().replace(/\/+$/, "") || abs.origin);
    } catch {
      // unparseable href — skip
    }
  }
  return [...out];
}

const STRIP_SELECTOR = "nav,header,footer,aside,script,style,noscript,form,iframe,svg";
const STRIP_CLASS_RE =
  /\b(sidebar|side-bar|toc|table-of-contents|breadcrumb|navbar|nav-bar|menu|footer|header|edit-link|pagination|prev-next|banner|announcement|skip-link)\b/i;

function pickDensestSection(root: HTMLElement): HTMLElement | null {
  const body = root.querySelector("body");
  if (!body) return null;
  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const child of body.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    if (/^(NAV|HEADER|FOOTER|ASIDE|SCRIPT|STYLE)$/i.test(el.tagName ?? "")) continue;
    const len = el.text.replace(/\s+/g, " ").length;
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  return best;
}

export function extractMainContent(html: string): { title: string; contentHtml: string } {
  const root = parse(html);
  const rawTitle = root.querySelector("h1")?.text.trim() || root.querySelector("title")?.text.trim() || "";
  const title = (rawTitle.split(/\s+[|·—–]\s+/)[0] || rawTitle).trim().slice(0, 200) || "Untitled";
  const container =
    root.querySelector("main") ??
    root.querySelector("article") ??
    root.querySelector('[role="main"]') ??
    pickDensestSection(root) ??
    root.querySelector("body") ??
    root;
  for (const el of container.querySelectorAll(STRIP_SELECTOR)) el.remove();
  for (const el of container.querySelectorAll("[class]")) {
    if (STRIP_CLASS_RE.test(el.getAttribute("class") ?? "")) el.remove();
  }
  return { title, contentHtml: container.innerHTML };
}

type Ctx = { listDepth: number };

function renderChildren(el: HTMLElement, ctx: Ctx): string {
  return el.childNodes.map((n) => renderNode(n, ctx)).join("");
}

/** Children rendered then flattened to a single line — for heading/link/emphasis interiors. */
function inline(el: HTMLElement, ctx: Ctx): string {
  return renderChildren(el, ctx).replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ");
}

function renderTable(el: HTMLElement): string {
  const rows = el.querySelectorAll("tr");
  if (rows.length === 0) return "";
  const lines: string[] = [];
  rows.forEach((tr, i) => {
    const cells = tr.querySelectorAll("th,td").map((c) => c.text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"));
    if (cells.length === 0) return;
    lines.push(`| ${cells.join(" | ")} |`);
    if (i === 0) lines.push(`|${cells.map(() => " --- ").join("|")}|`);
  });
  return `\n\n${lines.join("\n")}\n\n`;
}

function renderNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.rawText.replace(/\s+/g, " ");
  if (node.nodeType !== NodeType.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = (el.tagName ?? "").toUpperCase();
  switch (tag) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `\n\n${"#".repeat(Number(tag[1]))} ${inline(el, ctx).trim()}\n\n`;
    case "P":
      return `\n\n${inline(el, ctx).trim()}\n\n`;
    case "BR":
      return "  \n";
    case "HR":
      return "\n\n---\n\n";
    case "STRONG":
    case "B": {
      const t = inline(el, ctx).trim();
      return t ? `**${t}**` : "";
    }
    case "EM":
    case "I": {
      const t = inline(el, ctx).trim();
      return t ? `*${t}*` : "";
    }
    case "CODE":
      return `\`${el.text.trim()}\``;
    case "PRE": {
      const codeEl = el.querySelector("code");
      const code = (codeEl ?? el).text.replace(/\s+$/, "");
      const lang = /language-([\w-]+)/.exec(codeEl?.getAttribute("class") ?? "")?.[1] ?? "";
      return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const label = inline(el, ctx).trim() || href;
      if (!href || href.startsWith("#")) return label;
      return `[${label}](${href})`;
    }
    case "IMG": {
      const alt = (el.getAttribute("alt") ?? "").trim();
      return alt ? `*${alt}*` : "";
    }
    case "UL":
    case "OL": {
      const items = el.childNodes.filter(
        (n) => n.nodeType === NodeType.ELEMENT_NODE && ((n as HTMLElement).tagName ?? "").toUpperCase() === "LI",
      ) as HTMLElement[];
      const indent = "  ".repeat(ctx.listDepth);
      const lines = items.map((li, i) => {
        const marker = tag === "OL" ? `${i + 1}.` : "-";
        const body = renderChildren(li, { listDepth: ctx.listDepth + 1 })
          .trim()
          .replace(/\n{2,}/g, "\n")
          .split("\n")
          .map((l, j) => (j === 0 ? l : `${indent}  ${l.trim()}`))
          .join("\n");
        return `${indent}${marker} ${body}`;
      });
      return `\n\n${lines.join("\n")}\n\n`;
    }
    case "BLOCKQUOTE": {
      const innerMd = renderChildren(el, ctx).trim().split("\n").map((l) => `> ${l}`).join("\n");
      return `\n\n${innerMd}\n\n`;
    }
    case "TABLE":
      return renderTable(el);
    default:
      return renderChildren(el, ctx);
  }
}

export function htmlToMarkdown(html: string): string {
  const root = parse(html);
  return root.childNodes
    .map((n) => renderNode(n, { listDepth: 0 }))
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function deriveCollectionName(pageUrl: string, source: DocsSource): string | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  const rest = u.pathname.replace(/\/+$/, "").slice(source.pathPrefix.length).replace(/^\//, "");
  const segments = rest.split("/").filter(Boolean);
  if (segments.length < 2) return null; // top-level page → uncategorized
  const seg = decodeURIComponent(segments[0]).replace(/[-_]+/g, " ").trim();
  if (!seg) return null;
  return seg
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 120);
}

export function isBlockedResponse(status: number, header: (name: string) => string | null, body: string): boolean {
  if (status === 403 || status === 429) return true;
  if (/challenge/i.test(header("x-vercel-mitigated") ?? "") || /challenge/i.test(header("cf-mitigated") ?? "")) {
    return true;
  }
  return /security checkpoint|just a moment|attention required/i.test(body.slice(0, 2000));
}

export function cooldownRemainingMs(lastSyncedAt: number | null, cooldownMin: number, nowMs: number): number {
  if (!lastSyncedAt) return 0;
  return Math.max(0, lastSyncedAt + cooldownMin * 60_000 - nowMs);
}

export function humanizeMs(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** How many frontier URLs to process in this alarm firing (0 = crawl is finished). */
export function nextBatch(frontier: string[], visitedCount: number, importedCount: number): number {
  if (importedCount >= KB_SYNC.ARTICLE_CAP) return 0;
  const pageRoom = Math.max(0, KB_SYNC.PAGE_CAP - visitedCount);
  return Math.min(frontier.length, KB_SYNC.BATCH_SIZE, pageRoom);
}
```

- [x] **Step 5: Run tests until green.** `cd backend && pnpm test` — ALL suites pass. If a markdown expectation is off by whitespace, fix the serializer (not the test) unless the test itself asserts something the spec doesn't require.

- [x] **Step 6: Commit**: `git add -A && git commit -m "feat(kb-sync): crawler pure functions — url normalization, extraction, html-to-markdown"`

---

### Task 3: Digest pure functions + tests

**Files:**
- Create: `backend/src/kb-sync/digest.ts`
- Test: `backend/test/kb-sync-digest.test.ts`

**Interfaces (produced):**
- `type DigestArticle = { title: string; slug: string; collection: string | null; excerpt: string }`
- `buildGistPrompt(articles: DigestArticle[]): string`
- `parseGists(response: string, count: number): Map<number, string>`
- `composeDigest(articles: DigestArticle[], gists: Map<number, string>, urlBase: string, charCap: number): string`

- [x] **Step 1: Failing tests** — `backend/test/kb-sync-digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildGistPrompt, composeDigest, parseGists, type DigestArticle } from "../src/kb-sync/digest";

const ARTICLES: DigestArticle[] = [
  { title: "Install", slug: "install", collection: "Getting Started", excerpt: "How to install." },
  { title: "Pricing", slug: "pricing", collection: null, excerpt: "Plans and costs." },
];

describe("buildGistPrompt", () => {
  it("numbers the articles and demands numbered one-line output", () => {
    const p = buildGistPrompt(ARTICLES);
    expect(p).toContain("1. Install");
    expect(p).toContain("2. Pricing");
    expect(p).toMatch(/one line per article/i);
  });
});

describe("parseGists", () => {
  it("parses `N. text` lines, ignores junk and out-of-range numbers", () => {
    const g = parseGists("1. Covers installation steps.\nnot a line\n2) Explains plan pricing.\n9. nope", 2);
    expect(g.get(1)).toBe("Covers installation steps.");
    expect(g.get(2)).toBe("Explains plan pricing.");
    expect(g.has(9)).toBe(false);
  });
});

describe("composeDigest", () => {
  it("groups by collection with REAL urls we build ourselves, appends gists when present", () => {
    const gists = new Map([[1, "Covers installation."]]);
    const d = composeDigest(ARTICLES, gists, "https://docs.kaushikrb.com", 4000);
    expect(d).toContain("### Getting Started");
    expect(d).toContain("- [Install](https://docs.kaushikrb.com/a/install) — Covers installation.");
    expect(d).toContain("### Other");
    expect(d).toContain("- [Pricing](https://docs.kaushikrb.com/a/pricing)");
  });
  it("caps total length", () => {
    expect(composeDigest(ARTICLES, new Map(), "https://x.y", 40).length).toBeLessThanOrEqual(40);
  });
});
```

- [x] **Step 2: Run to fail**, then implement `backend/src/kb-sync/digest.ts`:

```ts
export type DigestArticle = { title: string; slug: string; collection: string | null; excerpt: string };

export function buildGistPrompt(articles: DigestArticle[]): string {
  const list = articles.map((a, i) => `${i + 1}. ${a.title}\n${a.excerpt}`).join("\n\n");
  return (
    "For each numbered documentation article below, write ONE short sentence (max 20 words) saying what it covers. " +
    "Output exactly one line per article in the format `N. sentence`, same numbering, nothing else.\n\n" + list
  );
}

export function parseGists(response: string, count: number): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of response.split("\n")) {
    const m = /^\s*(\d+)[.):]\s+(.{3,})$/.exec(line.trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= count && !map.has(n)) map.set(n, m[2].trim());
  }
  return map;
}

/** The digest structure and every URL are built by US — the model only contributes gists,
 * so it can never hallucinate a link. */
export function composeDigest(
  articles: DigestArticle[],
  gists: Map<number, string>,
  urlBase: string,
  charCap: number,
): string {
  const groups = new Map<string, string[]>();
  articles.forEach((a, i) => {
    const gist = gists.get(i + 1);
    const line = `- [${a.title}](${urlBase}/a/${a.slug})${gist ? ` — ${gist}` : ""}`;
    const key = a.collection ?? "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(line);
  });
  let out = "";
  for (const [name, lines] of groups) out += `### ${name}\n${lines.join("\n")}\n\n`;
  return out.trim().slice(0, charCap);
}
```

- [x] **Step 3: Green**: `cd backend && pnpm test` all pass. **Commit**: `git add -A && git commit -m "feat(kb-sync): digest gist prompt/parse/compose (deterministic urls)"`

---

### Task 4: KbSyncRunner DO, import service, sync API, digest generation, AI injection

**Files:**
- Create: `backend/src/kb-sync/import.service.ts`
- Create: `backend/src/kb-sync/runner.ts`
- Create: `backend/src/kb-sync/sync.api.ts`
- Modify: `backend/src/kb/kb.api.ts` (export `uniqueSlug`)
- Modify: `backend/src/domains/host.ts` (add `publicKbBase`)
- Modify: `backend/src/ai/handler.ts` (digest param + publicKbBase)
- Modify: `backend/src/ai/draft.ts` (digest param)
- Modify: `backend/src/index.ts` (mount + DO export)
- Test: extend `backend/test/draft.test.ts`-style prompt assertions in `backend/test/ai-digest-injection.test.ts`

**Interfaces (produced):**
- DO endpoint `POST https://do/start` body `{ workspaceId, userId, source: DocsSource }` → 200 `{ok:true}` | 409 `{error:{name,msg}}`
- `GET /api/v1/ws/:wsId/kb/sync` → `{ source: SyncSourceRow | null, cooldownMin: number }`
- `POST /api/v1/ws/:wsId/kb/sync` body `{url}` (admin) → `{ source: SyncSourceRow }`
- `SyncSourceRow = { id, url, status, pagesFound, pagesImported, pagesFailed, error, lastSyncedAt, startedAt, createdAt }`
- `publicKbBase(db, workspaceId, wsSlug, appUrl): Promise<string>` (base such that `base + "/a/" + slug` is a live article URL)
- `regenerateDigest(env, workspaceId): Promise<void>`
- `buildHandlerPrompt(messages, articles, digest?: string | null)` / `buildDraftPrompt(messages, articles, digest?: string | null)`

- [x] **Step 1: Export the slug helper.** In `backend/src/kb/kb.api.ts` change `async function uniqueSlug(` to `export async function uniqueSlug(`.

- [x] **Step 2: `backend/src/domains/host.ts`** — append (needs `DOMAIN` import from `../common/const`):

```ts
/** Where this workspace's public KB lives: its ACTIVE custom domain if it has one, else the
 * app-hosted /kb/:slug page. Returned base is always used as `${base}/a/${articleSlug}`. */
export async function publicKbBase(
  db: D1Database,
  workspaceId: string,
  wsSlug: string,
  appUrl: string,
): Promise<string> {
  const row = await db
    .prepare("SELECT hostname FROM custom_domains WHERE workspace_id=?1 AND status=?2 LIMIT 1")
    .bind(workspaceId, DOMAIN.STATUS.ACTIVE)
    .first<{ hostname: string }>();
  return row ? `https://${row.hostname}` : `${appUrl.replace(/\/$/, "")}/kb/${wsSlug}`;
}
```

- [x] **Step 3: `backend/src/kb-sync/import.service.ts`:**

```ts
import { now, uuidv7 } from "../common/id";
import { ARTICLE } from "../common/const";
import { slugify } from "../common/slug";
import { uniqueSlug } from "../kb/kb.api";
import { stripMarkdown } from "../kb/search";
import type { Env } from "../types";

async function findOrCreateCollection(env: Env, workspaceId: string, name: string): Promise<string> {
  const slug = slugify(name);
  const existing = await env.DB.prepare("SELECT id FROM kb_collections WHERE workspace_id=?1 AND slug=?2")
    .bind(workspaceId, slug)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = uuidv7();
  const { count } = (await env.DB.prepare("SELECT COUNT(*) as count FROM kb_collections WHERE workspace_id=?1")
    .bind(workspaceId)
    .first<{ count: number }>()) ?? { count: 0 };
  await env.DB.prepare(
    "INSERT INTO kb_collections (id, workspace_id, name, slug, description, position, created_at) VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)",
  )
    .bind(id, workspaceId, name, slug, count, now())
    .run();
  return id;
}

export async function upsertImportedArticle(
  env: Env,
  input: {
    workspaceId: string;
    requestedBy: string;
    sourceUrl: string;
    title: string;
    bodyMd: string;
    collectionName: string | null;
  },
): Promise<"INSERTED" | "UPDATED"> {
  const ts = now();
  const collectionId = input.collectionName
    ? await findOrCreateCollection(env, input.workspaceId, input.collectionName)
    : null;
  const existing = await env.DB.prepare("SELECT id FROM kb_articles WHERE workspace_id=?1 AND source_url=?2")
    .bind(input.workspaceId, input.sourceUrl)
    .first<{ id: string }>();
  if (existing) {
    // Slug stays stable so public links never break; status untouched (an admin may have drafted it).
    await env.DB.prepare(
      "UPDATE kb_articles SET title=?1, body_md=?2, body_text=?3, collection_id=?4, updated_at=?5 WHERE id=?6",
    )
      .bind(input.title, input.bodyMd, stripMarkdown(input.bodyMd), collectionId, ts, existing.id)
      .run();
    return "UPDATED";
  }
  const id = uuidv7();
  const slug = await uniqueSlug(env.DB, "kb_articles", input.workspaceId, input.title);
  await env.DB.prepare(
    `INSERT INTO kb_articles
       (id, workspace_id, collection_id, title, slug, body_md, body_text, status, created_by,
        published_at, created_at, updated_at, source_url)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, ?11)`,
  )
    .bind(
      id, input.workspaceId, collectionId, input.title, slug, input.bodyMd,
      stripMarkdown(input.bodyMd), ARTICLE.STATUS.PUBLISHED, input.requestedBy, ts, input.sourceUrl,
    )
    .run();
  return "INSERTED";
}
```

NOTE the INSERT binds: `?10` is used for published_at, created_at AND updated_at (same timestamp); `?11` is source_url. Count carefully — 11 placeholders, 11 binds.

- [x] **Step 4: digest generation.** Create the function inside `backend/src/kb-sync/runner.ts` (next step) as `regenerateDigest`, exported:

```ts
export async function regenerateDigest(env: Env, workspaceId: string): Promise<void> {
  const ws = await env.DB.prepare("SELECT slug FROM workspaces WHERE id=?1")
    .bind(workspaceId)
    .first<{ slug: string }>();
  if (!ws) return;
  const { results } = await env.DB.prepare(
    `SELECT a.title as title, a.slug as slug, a.body_text as bodyText, c.name as collection
     FROM kb_articles a LEFT JOIN kb_collections c ON c.id = a.collection_id
     WHERE a.workspace_id=?1 AND a.status='PUBLISHED'
     ORDER BY COALESCE(c.position, 999), a.title LIMIT ?2`,
  )
    .bind(workspaceId, AI_CONF.DIGEST.MAX_ARTICLES)
    .all<{ title: string; slug: string; bodyText: string; collection: string | null }>();
  if (results.length === 0) return;
  const articles: DigestArticle[] = results.map((r) => ({
    title: r.title,
    slug: r.slug,
    collection: r.collection,
    excerpt: r.bodyText.slice(0, AI_CONF.DIGEST.PER_ARTICLE_EXCERPT),
  }));
  let gists = new Map<number, string>();
  try {
    const response = (await runWithTimeout(
      env.AI.run(AI_CONF.MODEL, {
        messages: [{ role: "user", content: buildGistPrompt(articles) }],
        max_tokens: AI_CONF.DIGEST.MAX_TOKENS,
      }),
      AI_CONF.TIMEOUT_MS,
    )) as { response?: string };
    gists = parseGists(response.response ?? "", articles.length);
  } catch {
    // AI down → fallback digest of titles + urls only, still useful
  }
  const base = await publicKbBase(env.DB, workspaceId, ws.slug, getConfig(env).APP_URL);
  const digest = composeDigest(articles, gists, base, AI_CONF.DIGEST.CHAR_CAP);
  await env.DB.prepare("UPDATE workspaces SET kb_digest=?1, kb_digest_at=?2 WHERE id=?3")
    .bind(digest, now(), workspaceId)
    .run();
}
```

- [x] **Step 5: the DO — `backend/src/kb-sync/runner.ts`** (full file; `regenerateDigest` from Step 4 lives here too):

```ts
import { AI_CONF, KB_SYNC } from "../common/const";
import { getConfig } from "../config/env.config";
import { now, uuidv7 } from "../common/id";
import { runWithTimeout } from "../ai/summary";
import { publicKbBase } from "../domains/host";
import {
  cooldownRemainingMs, deriveCollectionName, extractLinks, extractMainContent,
  htmlToMarkdown, humanizeMs, inScope, isBlockedResponse, nextBatch, type DocsSource,
} from "./crawl";
import { buildGistPrompt, composeDigest, parseGists, type DigestArticle } from "./digest";
import { upsertImportedArticle } from "./import.service";
import type { Env } from "../types";

// [regenerateDigest from Step 4 goes here]

type Job = {
  workspaceId: string;
  requestedBy: string;
  source: DocsSource;
  frontier: string[];
  visited: string[];
  imported: number;
  failed: number;
  blockedStreak: number;
  alarmRetries: number;
  sitemapTried: boolean;
};

/**
 * One instance per workspace (idFromName(workspaceId)). Single-threaded by the DO model, so
 * parallel Sync clicks serialize and the cooldown/running check below is race-free. The crawl
 * runs as an alarm loop — small batches, fresh subrequest budget each firing, progress persisted.
 */
export class KbSyncRunner {
  private ctx: DurableObjectState;
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/start" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const { workspaceId, userId, source } = (await request.json()) as {
      workspaceId: string;
      userId: string;
      source: DocsSource;
    };
    const ts = now();
    const row = await this.env.DB.prepare(
      "SELECT status, started_at as startedAt, last_synced_at as lastSyncedAt FROM kb_sync_sources WHERE workspace_id=?1",
    )
      .bind(workspaceId)
      .first<{ status: string; startedAt: number | null; lastSyncedAt: number | null }>();

    if (row?.status === KB_SYNC.STATUS.RUNNING && row.startedAt && ts - row.startedAt < KB_SYNC.STALE_RUNNING_MS) {
      return Response.json(
        { error: { name: "KB_SYNC_ALREADY_RUNNING", msg: "A sync is already in progress" } },
        { status: 409 },
      );
    }
    const remaining = cooldownRemainingMs(
      row?.lastSyncedAt ?? null,
      getConfig(this.env).KB_SYNC_COOLDOWN_MIN,
      ts,
    );
    if (remaining > 0) {
      return Response.json(
        { error: { name: "KB_SYNC_COOLDOWN", msg: `You can sync again in ${humanizeMs(remaining)}` } },
        { status: 409 },
      );
    }

    const job: Job = {
      workspaceId, requestedBy: userId, source,
      frontier: [source.startUrl], visited: [],
      imported: 0, failed: 0, blockedStreak: 0, alarmRetries: 0, sitemapTried: false,
    };
    await this.ctx.storage.put("job", job);
    await this.env.DB.prepare(
      `INSERT INTO kb_sync_sources
         (id, workspace_id, url, status, pages_found, pages_imported, pages_failed, error,
          requested_by, started_at, last_synced_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, 0, 0, NULL, ?5, ?6, NULL, ?6, ?6)
       ON CONFLICT(workspace_id) DO UPDATE SET
         url=?3, status=?4, pages_found=0, pages_imported=0, pages_failed=0, error=NULL,
         requested_by=?5, started_at=?6, updated_at=?6`,
    )
      .bind(uuidv7(), workspaceId, source.startUrl, KB_SYNC.STATUS.RUNNING, userId, ts)
      .run();
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<Job>("job");
    if (!job) return;
    try {
      await this.runBatch(job);
    } catch (e) {
      job.alarmRetries += 1;
      await this.ctx.storage.put("job", job);
      if (job.alarmRetries >= 3) {
        await this.finalize(job, KB_SYNC.STATUS.FAILED, `Sync crashed: ${String(e).slice(0, 300)}`);
        return;
      }
      throw e; // let the runtime's alarm retry take it from here
    }
  }

  private async runBatch(job: Job): Promise<void> {
    if (!job.sitemapTried) {
      job.sitemapTried = true;
      try {
        const res = await this.fetchPage(`${job.source.origin}/sitemap.xml`);
        if (res.ok) {
          const xml = await res.text();
          const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
          for (const loc of locs) {
            const clean = loc.replace(/\/+$/, "");
            if (inScope(clean, job.source) && !job.frontier.includes(clean) && !job.visited.includes(clean)) {
              job.frontier.push(clean);
            }
          }
        }
      } catch {
        // no sitemap — BFS discovers links instead
      }
    }

    const count = nextBatch(job.frontier, job.visited.length, job.imported);
    for (let i = 0; i < count; i++) {
      const url = job.frontier.shift();
      if (!url || job.visited.includes(url)) continue;
      job.visited.push(url);
      try {
        const res = await this.fetchPage(url);
        const bodySnippet = res.ok || res.status === 403 || res.status === 429 ? await res.text() : "";
        if (isBlockedResponse(res.status, (n) => res.headers.get(n), bodySnippet)) {
          job.failed += 1;
          job.blockedStreak += 1;
          if (job.blockedStreak >= KB_SYNC.BLOCKED_STREAK_LIMIT) {
            await this.finalize(job, KB_SYNC.STATUS.FAILED, KB_SYNC.BLOCKED_MSG);
            return;
          }
          continue;
        }
        job.blockedStreak = 0;
        if (!res.ok) {
          job.failed += 1;
          continue;
        }
        if (!(res.headers.get("content-type") ?? "").includes("text/html")) continue;
        const html = bodySnippet;
        if (html.length > KB_SYNC.MAX_HTML_BYTES) continue;
        const finalUrl = (res.url || url).replace(/\/+$/, "") || url;
        if (!inScope(finalUrl, job.source)) continue;

        for (const link of extractLinks(html, finalUrl)) {
          if (inScope(link, job.source) && !job.visited.includes(link) && !job.frontier.includes(link)) {
            job.frontier.push(link);
          }
        }

        const { title, contentHtml } = extractMainContent(html);
        const md = htmlToMarkdown(contentHtml);
        if (md.length < KB_SYNC.MIN_CONTENT_CHARS) continue;
        await upsertImportedArticle(this.env, {
          workspaceId: job.workspaceId,
          requestedBy: job.requestedBy,
          sourceUrl: finalUrl,
          title,
          bodyMd: md,
          collectionName: deriveCollectionName(finalUrl, job.source),
        });
        job.imported += 1;
      } catch {
        job.failed += 1;
      }
    }

    await this.writeProgress(job);
    if (nextBatch(job.frontier, job.visited.length, job.imported) === 0) {
      await this.finalize(job, KB_SYNC.STATUS.DONE, null);
      return;
    }
    await this.ctx.storage.put("job", job);
    await this.ctx.storage.setAlarm(Date.now() + 250);
  }

  private fetchPage(url: string): Promise<Response> {
    return fetch(url, {
      headers: { "User-Agent": KB_SYNC.USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(KB_SYNC.FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  }

  private async writeProgress(job: Job): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE kb_sync_sources SET pages_found=?1, pages_imported=?2, pages_failed=?3, updated_at=?4 WHERE workspace_id=?5",
    )
      .bind(job.visited.length, job.imported, job.failed, now(), job.workspaceId)
      .run();
  }

  private async finalize(job: Job, status: string, error: string | null): Promise<void> {
    if (status === KB_SYNC.STATUS.DONE) {
      try {
        await regenerateDigest(this.env, job.workspaceId);
      } catch (e) {
        console.error("digest generation failed", e);
      }
    }
    const ts = now();
    await this.env.DB.prepare(
      `UPDATE kb_sync_sources SET status=?1, error=?2, pages_found=?3, pages_imported=?4, pages_failed=?5,
         last_synced_at=CASE WHEN ?1='DONE' THEN ?6 ELSE last_synced_at END, updated_at=?6
       WHERE workspace_id=?7`,
    )
      .bind(status, error, job.visited.length, job.imported, job.failed, ts, job.workspaceId)
      .run();
    await this.ctx.storage.deleteAll();
  }
}
```

FAILED never sets `last_synced_at` → no cooldown after failure (spec rule).

- [x] **Step 6: `backend/src/kb-sync/sync.api.ts`:**

```ts
import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { CtxError, ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, requireAdmin, wsMiddleware } from "../middleware/auth";
import { getConfig } from "../config/env.config";
import { normalizeDocsUrl } from "./crawl";
import type { HonoEnv } from "../common/hono-env";

const SyncBody = z.object({ url: z.string().trim().min(4).max(500) });

const ROW_COLUMNS = `id, url, status, pages_found as pagesFound, pages_imported as pagesImported,
  pages_failed as pagesFailed, error, last_synced_at as lastSyncedAt, started_at as startedAt,
  created_at as createdAt`;

async function loadRow(db: D1Database, workspaceId: string) {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM kb_sync_sources WHERE workspace_id=?1`).bind(workspaceId).first();
}

export const kbSyncApi = new Hono<HonoEnv>();
kbSyncApi.use("*", authMiddleware, wsMiddleware);

kbSyncApi.get("/kb/sync", async (c) => {
  const { workspaceId } = c.get("member");
  const source = await loadRow(c.env.DB, workspaceId);
  return ok(c, { source: source ?? null, cooldownMin: getConfig(c.env).KB_SYNC_COOLDOWN_MIN });
});

kbSyncApi.post("/kb/sync", requireAdmin, validate(SyncBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const { url } = c.get("body") as z.infer<typeof SyncBody>;
  const source = normalizeDocsUrl(url);
  if (!source) throw ctxErr.kbSync.invalidUrl();

  const stub = c.env.KB_SYNC.get(c.env.KB_SYNC.idFromName(workspaceId));
  const res = await stub.fetch("https://do/start", {
    method: "POST",
    body: JSON.stringify({ workspaceId, userId, source }),
  });
  if (res.status === 409) {
    const { error } = (await res.json()) as { error: { name: string; msg: string } };
    throw new CtxError({ name: error.name, msg: error.msg });
  }
  if (!res.ok) throw new Error(`kb-sync /start failed: ${res.status}`);
  const row = await loadRow(c.env.DB, workspaceId);
  return ok(c, { source: row });
});
```

- [x] **Step 7: AI injection.** In `backend/src/ai/handler.ts`:
  - Change `buildHandlerPrompt(messages: MessageRow[], articles: KbArticle[])` to `buildHandlerPrompt(messages: MessageRow[], articles: KbArticle[], digest?: string | null)` and inside, before `const kb =`, add:
    ```ts
    const map = digest ? `Documentation map (everything available):\n${digest}\n\n` : "";
    ```
    and change the return's first line from `` `Knowledge base articles you can link to:\n${kb}\n\n` `` to `` `${map}Knowledge base articles you can link to:\n${kb}\n\n` ``.
  - In `runAiTurn`, change the workspace query to also select the digest: `"SELECT id, name, slug, kb_digest as kbDigest FROM workspaces WHERE id=?1"` (extend the `.first<...>` type with `kbDigest: string | null`).
  - Replace the article-URL construction: delete the line `const appUrl = getConfig(env).APP_URL.replace(/\/$/, "");` and instead, right before `articles = hits.map(...)`, add `const kbBase = await publicKbBase(env.DB, workspaceId, workspace.slug, getConfig(env).APP_URL);` (import `publicKbBase` from `../domains/host`), and change the mapped `url:` to `` url: `${kbBase}/a/${r.slug}` ``.
  - Pass the digest into the prompt: `buildHandlerPrompt(window, articles, workspace.kbDigest)`.
  - Also update the system prompt grounding line: in `systemPrompt(...)` change `"- Only state facts found in the knowledge-base articles provided."` to `"- Only state facts found in the knowledge-base articles provided. The documentation map shows everything that exists — when the customer's answer lives in a mapped article that isn't excerpted, share that article's URL."`.

  In `backend/src/ai/draft.ts`:
  - `buildDraftPrompt(messages, articles, digest?: string | null)` — same `map` prepend pattern.
  - In `suggestReply`, after the conversation existence check, load the digest: `const wsRow = await env.DB.prepare("SELECT kb_digest as kbDigest FROM workspaces WHERE id=?1").bind(workspaceId).first<{ kbDigest: string | null }>();` and pass `wsRow?.kbDigest` into `buildDraftPrompt`.

- [x] **Step 8: Injection unit tests** — `backend/test/ai-digest-injection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildHandlerPrompt } from "../src/ai/handler";
import { buildDraftPrompt } from "../src/ai/draft";

const MSGS = [{ senderType: "CONTACT", bodyText: "how do I install?" }];

describe("digest injection", () => {
  it("handler prompt prepends the documentation map when present, omits when absent", () => {
    const withDigest = buildHandlerPrompt(MSGS, [], "### Docs\n- [Install](https://x/a/install)");
    expect(withDigest.startsWith("Documentation map (everything available):")).toBe(true);
    expect(withDigest).toContain("- [Install](https://x/a/install)");
    const without = buildHandlerPrompt(MSGS, []);
    expect(without.startsWith("Knowledge base articles")).toBe(true);
  });
  it("draft prompt does the same", () => {
    const withDigest = buildDraftPrompt(MSGS, [], "### Docs\n- [Install](https://x/a/install)");
    expect(withDigest).toContain("Documentation map");
    expect(buildDraftPrompt(MSGS, [])).not.toContain("Documentation map");
  });
});
```

- [x] **Step 9: Mount + export.** In `backend/src/index.ts`: add `import { kbSyncApi } from "./kb-sync/sync.api";` and `export { KbSyncRunner } from "./kb-sync/runner";` (next to the other DO exports), and mount `app.route("/api/v1/ws/:wsId", kbSyncApi);` after the `kbApi` mount.

- [x] **Step 10: All tests green**: `cd backend && pnpm test`. Expected: every suite passes including the two new files.

- [x] **Step 11: Local end-to-end sanity (no external fetches).** Build + start dev: from repo root `pnpm --dir frontend build`, then `cd backend && npx wrangler dev` (background). Use curl:
  1. Login via debug flow (see `e2e/scripts/ws-check.mjs` pattern): `POST /api/v1/auth/magic-link` with `X-Debug-Auth: $DEBUG_AUTH_SECRET` (value in `backend/.dev.vars`) → `POST /api/v1/auth/verify` → accessToken; create a workspace.
  2. `POST /api/v1/ws/:wsId/kb/sync` with `{"url": "not a url"}` → expect `{"code":"KB_SYNC_INVALID_URL"...}`.
  3. `POST` with `{"url": "sp.hyugorix.com"}` → expect `KB_SYNC_INVALID_URL` (own-zone guard).
  4. `POST` with `{"url": "http://localhost:8787/kb"}` → expect `KB_SYNC_INVALID_URL` (localhost guard).
  5. `GET /api/v1/ws/:wsId/kb/sync` → `{"source":null,"cooldownMin":1}`.
  Kill wrangler dev afterwards. (A real crawl is NOT run locally — the target would be an external site; that happens once on prod in Task 5.)

- [x] **Step 12: Commit**: `git add -A && git commit -m "feat(kb-sync): KbSyncRunner DO, import upsert, sync API, digest wired into AI handler+drafts"`

---

### Task 5: KbSyncPanel UI + deploy + prod verification (blocked-site AND happy path)

**Files:**
- Create: `frontend/src/kb/KbSyncPanel.tsx`
- Create: `e2e/scripts/kb-sync-live-check.mjs`
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/kb/KbAdminPage.tsx`

**Interfaces (consumed):** `GET/POST /api/v1/ws/:wsId/kb/sync` from Task 4.

- [x] **Step 1: Types.** In `frontend/src/lib/types.ts` after `KbDomain` add:

```ts
export type KbSyncSource = {
  id: string;
  url: string;
  status: "RUNNING" | "DONE" | "FAILED";
  pagesFound: number;
  pagesImported: number;
  pagesFailed: number;
  error: string | null;
  lastSyncedAt: number | null;
  startedAt: number | null;
  createdAt: number;
};
```

- [x] **Step 2: `frontend/src/kb/KbSyncPanel.tsx`** (mirrors DomainPanel's visual language):

```tsx
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import type { KbSyncSource } from "../lib/types";

function remainingText(lastSyncedAt: number | null, cooldownMin: number): string | null {
  if (!lastSyncedAt) return null;
  const ms = lastSyncedAt + cooldownMin * 60_000 - Date.now();
  if (ms <= 0) return null;
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const CHIP: Record<KbSyncSource["status"], { label: string; className: string }> = {
  RUNNING: { label: "Syncing…", className: "bg-indigo-100 text-indigo-700" },
  DONE: { label: "Synced", className: "bg-emerald-100 text-emerald-700" },
  FAILED: { label: "Failed", className: "bg-red-100 text-red-700" },
};

/** Imports an existing public docs site into this KB: paste a URL, hit Sync, watch it fill.
 * Progress comes from polling the D1-backed status row (the DO write-throughs). */
export function KbSyncPanel({ wsId }: { wsId: string }) {
  const { showError } = useToast();
  const [source, setSource] = useState<KbSyncSource | null>(null);
  const [cooldownMin, setCooldownMin] = useState(1440);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ source: KbSyncSource | null; cooldownMin: number }>(`/api/v1/ws/${wsId}/kb/sync`);
      setSource(data.source);
      setCooldownMin(data.cooldownMin);
      setLoaded(true);
      return data.source;
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
      return null;
    }
  }, [wsId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 2s while a sync runs so the counters tick live.
  useEffect(() => {
    if (source?.status !== "RUNNING") return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [source?.status, load]);

  async function handleSync() {
    const value = (url || source?.url || "").trim();
    if (!value || saving) return;
    setSaving(true);
    try {
      const data = await api<{ source: KbSyncSource }>(`/api/v1/ws/${wsId}/kb/sync`, {
        method: "POST",
        body: { url: value },
      });
      setSource(data.source);
      setUrl("");
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;
  const cooldown = source?.status === "DONE" ? remainingText(source.lastSyncedAt, cooldownMin) : null;
  const running = source?.status === "RUNNING";

  return (
    <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span className="text-slate-400">📥</span>
        <span className="font-medium text-slate-700">Docs import</span>
        {source ? (
          <span className="flex items-center gap-1.5">
            <span className="max-w-[220px] truncate font-mono text-slate-600">{source.url}</span>
            <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${CHIP[source.status].className}`}>
              {running ? `Syncing… ${source.pagesImported} imported` : CHIP[source.status].label}
            </span>
            {source.status === "DONE" && (
              <span className="text-slate-400">
                {source.pagesImported} article{source.pagesImported === 1 ? "" : "s"}
              </span>
            )}
          </span>
        ) : (
          <span className="text-slate-400">not set up — import your existing docs site</span>
        )}
        <span className="ml-auto text-slate-400">{expanded ? "▴" : "▾"}</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 px-3 py-3">
          {running && (
            <p className="mb-2 text-[11px] text-indigo-700">
              Crawling… found {source!.pagesFound} · imported {source!.pagesImported} · failed {source!.pagesFailed}
            </p>
          )}
          {source?.status === "FAILED" && source.error && (
            <p className="mb-2 text-[11px] text-red-600">{source.error}</p>
          )}
          {source?.status === "DONE" && (
            <p className="mb-2 text-[11px] text-slate-500">
              Imported {source.pagesImported} of {source.pagesFound} pages
              {source.pagesFailed > 0 ? ` (${source.pagesFailed} failed)` : ""} ·{" "}
              {source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString() : ""}
            </p>
          )}
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSync()}
              placeholder={source?.url ?? "https://docs.yourcompany.com"}
              className="flex-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
            />
            <button
              onClick={handleSync}
              disabled={saving || running || !!cooldown || (!url.trim() && !source?.url)}
              title={cooldown ? `Next sync available in ${cooldown}` : undefined}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? "Starting…" : running ? "Syncing…" : "Sync now"}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            {cooldown
              ? `Next sync available in ${cooldown}.`
              : "We crawl up to 10 pages of your public docs and import them as published articles. "}
            {!cooldown && "Re-syncing updates previously imported articles; articles you wrote here are never touched."}
          </p>
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 3: Mount it.** In `frontend/src/kb/KbAdminPage.tsx` import `{ KbSyncPanel }` and change `{wsId && <DomainPanel wsId={wsId} />}` to:

```tsx
{wsId && <DomainPanel wsId={wsId} />}
{wsId && <KbSyncPanel wsId={wsId} />}
```

- [x] **Step 4: Build + deploy.** From repo root: `pnpm --dir frontend build`, then `cd backend && CI=true npx wrangler d1 migrations apply super-profile --remote && npx wrangler deploy`. Expected: migration 0005 applied remotely; deploy prints a version id.

- [x] **Step 5: Live check script** — `e2e/scripts/kb-sync-live-check.mjs` (modeled on ws-check.mjs; run BY HAND against prod, never from a test suite):

```js
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

const suffix = Date.now().toString(36);
const { debugToken } = await api("/api/v1/auth/magic-link", { method: "POST", body: { email: `sync-check-${suffix}@example.com` } });
const { accessToken } = await api("/api/v1/auth/verify", { method: "POST", body: { token: debugToken } });
const { workspace } = await api("/api/v1/workspaces", { method: "POST", body: { slug: `sync-check-${suffix}` }, token: accessToken });
console.log("workspace:", workspace.id);

// 1) Bot-protected site → must end FAILED with the bot-protection message, no cooldown armed.
await api(`/api/v1/ws/${workspace.id}/kb/sync`, { method: "POST", body: { url: "https://superprofile.bio/blog" }, token: accessToken });
let s;
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  ({ source: s } = await api(`/api/v1/ws/${workspace.id}/kb/sync`, { token: accessToken }));
  if (s.status !== "RUNNING") break;
  console.log("  blocked-path:", s.status, s.pagesFound, "found");
}
if (s.status !== "FAILED" || !/bot protection/i.test(s.error ?? "")) throw new Error(`expected bot-protection FAILED, got ${s.status}: ${s.error}`);
console.log("ok: bot-protected site fails honestly:", s.error);

// 2) Happy path — hono.dev/docs.
await api(`/api/v1/ws/${workspace.id}/kb/sync`, { method: "POST", body: { url: "https://hono.dev/docs" }, token: accessToken });
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
const { articles } = await api(`/api/v1/ws/${workspace.id}/kb/articles`, { token: accessToken });
const imported = articles.filter((a) => a.status === "PUBLISHED");
console.log(`ok: ${imported.length} published articles, e.g. "${imported[0]?.title}"`);
const pub = await api(`/api/v1/public/kb/${workspace.slug}`);
console.log("ok: public KB lists", (pub.collections ?? []).length, "collections");
console.log("\nALL CHECKS PASSED — workspace", workspace.slug, "(throwaway, can be ignored)");
```

NOTE: check the public KB endpoint shape first (`backend/src/kb/public.api.ts` `GET /:wsSlug`) and adjust the final assertion's field names to what it actually returns.

- [x] **Step 6: Run it against prod.** `cd e2e && BASE_URL=https://sp.hyugorix.com DEBUG_AUTH_SECRET=$(grep DEBUG_AUTH_SECRET ../backend/.dev.vars | cut -d= -f2) node scripts/kb-sync-live-check.mjs`
Expected output ends with `ALL CHECKS PASSED`. If the blocked-path check fails because Vercel changed behavior, capture the actual status/error into decision.md and continue — the happy path is the release gate.

- [x] **Step 7: Visual check.** Orchestrator (browser): open the throwaway workspace's KB page on prod, confirm the panel shows Synced + article count, cooldown text visible, Sync button disabled; digest exists: `cd backend && npx wrangler d1 execute super-profile --remote --command "SELECT length(kb_digest) FROM workspaces WHERE id='<wsId>'" --json`.

- [x] **Step 8: Commit + push**: `git add -A && git commit -m "feat(kb-sync): docs-import panel with live progress, cooldown and failure states" && git push origin main`

---

### Task 6: Canned responses (API + settings + composer + e2e)

**Files:**
- Create: `backend/src/canned/canned.api.ts`
- Create: `frontend/src/lib/canned.ts`
- Create: `frontend/src/settings/CannedSection.tsx`
- Create: `e2e/tests/canned.spec.ts`
- Test: `backend/test/canned-match.test.ts`
- Modify: `backend/src/index.ts`, `frontend/src/lib/types.ts`, `frontend/src/inbox/Composer.tsx`, `frontend/src/inbox/ConversationView.tsx`, `frontend/src/inbox/InboxPage.tsx`, `frontend/src/settings/SettingsPage.tsx`

**Interfaces:**
- `GET/POST /api/v1/ws/:wsId/canned`, `PATCH/DELETE /api/v1/ws/:wsId/canned/:id` (any member)
- `CannedResponse = { id: string; title: string; body: string; tags: string; createdAt: number }`
- `matchCanned(list, query, limit=8)` — filter by title/tags substring
- `Composer` new optional prop `canned?: CannedResponse[]`
- `ConversationView` new prop `canned: CannedResponse[]`

- [x] **Step 1: Failing test** — `backend/test/canned-match.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchCanned } from "../../frontend/src/lib/canned";

const LIST = [
  { title: "Refund policy", tags: "billing,refund", body: "b1" },
  { title: "Password reset", tags: "auth", body: "b2" },
  { title: "Shipping times", tags: "orders", body: "b3" },
];

describe("matchCanned", () => {
  it("empty query returns everything up to the limit", () => {
    expect(matchCanned(LIST, "")).toHaveLength(3);
    expect(matchCanned(LIST, "", 2)).toHaveLength(2);
  });
  it("matches title and tags, case-insensitive", () => {
    expect(matchCanned(LIST, "REFUND").map((r) => r.title)).toEqual(["Refund policy"]);
    expect(matchCanned(LIST, "auth").map((r) => r.title)).toEqual(["Password reset"]);
    expect(matchCanned(LIST, "zzz")).toHaveLength(0);
  });
});
```

- [x] **Step 2: Run to fail, implement `frontend/src/lib/canned.ts`:**

```ts
export function matchCanned<T extends { title: string; tags: string }>(list: T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  return list.filter((r) => r.title.toLowerCase().includes(q) || r.tags.toLowerCase().includes(q)).slice(0, limit);
}
```

Run `cd backend && pnpm test canned` — PASS. (Backend tests import frontend pure modules by relative path — same style as the sla test coming in Task 7; vitest transforms them fine.)

- [x] **Step 3: API** — `backend/src/canned/canned.api.ts` (table exists since migration 0001; no migration needed):

```ts
import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware } from "../middleware/auth";
import { now, uuidv7 } from "../common/id";
import type { HonoEnv } from "../common/hono-env";

const CannedBody = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(5000),
  tags: z.string().trim().max(200).optional(),
});
const CannedPatchBody = CannedBody.partial();

const COLUMNS = "id, title, body, tags, created_at as createdAt";

export const cannedApi = new Hono<HonoEnv>();
cannedApi.use("*", authMiddleware, wsMiddleware);

cannedApi.get("/canned", async (c) => {
  const { workspaceId } = c.get("member");
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM canned_responses WHERE workspace_id=?1 ORDER BY title COLLATE NOCASE`,
  )
    .bind(workspaceId)
    .all();
  return ok(c, { canned: results });
});

cannedApi.post("/canned", validate(CannedBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const { title, body, tags } = c.get("body") as z.infer<typeof CannedBody>;
  const id = uuidv7();
  await c.env.DB.prepare(
    "INSERT INTO canned_responses (id, workspace_id, title, body, tags, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, workspaceId, title, body, tags ?? "", userId, now())
    .run();
  return ok(c, { canned: { id, title, body, tags: tags ?? "", createdAt: now() } });
});

cannedApi.patch("/canned/:id", validate(CannedPatchBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const patch = c.get("body") as z.infer<typeof CannedPatchBody>;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) {
    binds.push(patch.title);
    sets.push(`title=?${binds.length}`);
  }
  if (patch.body !== undefined) {
    binds.push(patch.body);
    sets.push(`body=?${binds.length}`);
  }
  if (patch.tags !== undefined) {
    binds.push(patch.tags);
    sets.push(`tags=?${binds.length}`);
  }
  if (sets.length === 0) return ok(c);
  binds.push(id, workspaceId);
  const res = await c.env.DB.prepare(
    `UPDATE canned_responses SET ${sets.join(", ")} WHERE id=?${binds.length - 1} AND workspace_id=?${binds.length}`,
  )
    .bind(...binds)
    .run();
  if (res.meta.changes !== 1) throw ctxErr.canned.notFound();
  return ok(c);
});

cannedApi.delete("/canned/:id", async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("DELETE FROM canned_responses WHERE id=?1 AND workspace_id=?2")
    .bind(id, workspaceId)
    .run();
  if (res.meta.changes !== 1) throw ctxErr.canned.notFound();
  return ok(c);
});
```

Mount in `backend/src/index.ts`: `import { cannedApi } from "./canned/canned.api";` + `app.route("/api/v1/ws/:wsId", cannedApi);`

- [x] **Step 4: Frontend type.** In `frontend/src/lib/types.ts`: `export type CannedResponse = { id: string; title: string; body: string; tags: string; createdAt: number };`

- [x] **Step 5: Composer dropdown.** In `frontend/src/inbox/Composer.tsx`:
  - Add imports: `import { matchCanned } from "../lib/canned"; import type { CannedResponse } from "../lib/types";`
  - Add prop `canned?: CannedResponse[];` to the props type and destructure it.
  - Add state: `const [cannedIdx, setCannedIdx] = useState(0);`
  - Derive matches right before the `return`:
    ```tsx
    const cannedOpen = !!canned && canned.length > 0 && text.startsWith("/");
    const cannedMatches = cannedOpen ? matchCanned(canned!, text.slice(1)) : [];
    ```
  - In `handleKeyDown`, BEFORE the existing Enter branch:
    ```tsx
    if (cannedOpen && cannedMatches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setCannedIdx((i) => (i + 1) % cannedMatches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setCannedIdx((i) => (i - 1 + cannedMatches.length) % cannedMatches.length); return; }
      if (e.key === "Enter") { e.preventDefault(); setText(cannedMatches[Math.min(cannedIdx, cannedMatches.length - 1)].body); setCannedIdx(0); return; }
      if (e.key === "Escape") { e.preventDefault(); setText(""); setCannedIdx(0); return; }
    }
    ```
  - Render the dropdown INSIDE the outer div, right BEFORE the `<textarea>` — wrap both in `<div className="relative">`:
    ```tsx
    <div className="relative">
      {cannedOpen && cannedMatches.length > 0 && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
            Canned responses — ↑↓ then Enter
          </div>
          {cannedMatches.map((r, i) => (
            <button
              key={r.id}
              onMouseEnter={() => setCannedIdx(i)}
              onClick={() => { setText(r.body); setCannedIdx(0); }}
              className={`block w-full px-3 py-2 text-left ${i === Math.min(cannedIdx, cannedMatches.length - 1) ? "bg-indigo-50" : ""}`}
            >
              <div className="text-xs font-medium text-slate-800">{r.title}</div>
              <div className="truncate text-[11px] text-slate-500">{r.body}</div>
            </button>
          ))}
        </div>
      )}
      <textarea ... (unchanged) />
    </div>
    ```
  - Add a `⚡ Canned` button next to the other action buttons, only when `canned && canned.length > 0`:
    ```tsx
    {canned && canned.length > 0 && (
      <button
        onClick={() => setText("/")}
        disabled={disabled}
        title="Insert a canned response (or just type / in the reply box)"
        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
      >
        ⚡ Canned
      </button>
    )}
    ```
  - Also update the hint line: change `Enter to send, Shift+Enter for a new line` to `Enter to send · Shift+Enter new line · / canned replies` (only when `canned` is provided — use a ternary).
  The widget's `TicketView` passes no `canned` prop, so visitors never see any of this.

- [x] **Step 6: Wire the data.** In `frontend/src/inbox/InboxPage.tsx`: add `const [canned, setCanned] = useState<CannedResponse[]>([]);` (import the type), load it in the existing members effect:
  ```tsx
  useEffect(() => {
    if (!wsId) return;
    api<{ members: Member[] }>(`/api/v1/ws/${wsId}/members`).then((d) => setMembers(d.members)).catch(() => {});
    api<{ canned: CannedResponse[] }>(`/api/v1/ws/${wsId}/canned`).then((d) => setCanned(d.canned)).catch(() => {});
  }, [wsId]);
  ```
  Pass `canned={canned}` to `<ConversationView>`. In `ConversationView` add prop `canned: CannedResponse[]` and pass `canned={canned}` to `<Composer>`.

- [x] **Step 7: Settings section** — `frontend/src/settings/CannedSection.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";
import type { CannedResponse } from "../lib/types";

export function CannedSection({ wsId }: { wsId: string }) {
  const { showError } = useToast();
  const [items, setItems] = useState<CannedResponse[]>([]);
  const [editing, setEditing] = useState<CannedResponse | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ canned: CannedResponse[] }>(`/api/v1/ws/${wsId}/canned`);
      setItems(data.canned);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }, [wsId, showError]);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit(item: CannedResponse | "new") {
    setEditing(item);
    setTitle(item === "new" ? "" : item.title);
    setBody(item === "new" ? "" : item.body);
    setTags(item === "new" ? "" : item.tags);
  }

  async function handleSave() {
    if (!title.trim() || !body.trim() || busy) return;
    setBusy(true);
    try {
      if (editing && editing !== "new") {
        await api(`/api/v1/ws/${wsId}/canned/${editing.id}`, { method: "PATCH", body: { title, body, tags } });
      } else {
        await api(`/api/v1/ws/${wsId}/canned`, { method: "POST", body: { title, body, tags } });
      }
      setEditing(null);
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // Two-click confirm — no native dialogs (they block browser automation).
  async function handleDelete(id: string) {
    if (confirmingDeleteId !== id) {
      setConfirmingDeleteId(id);
      setTimeout(() => setConfirmingDeleteId((cur) => (cur === id ? null : cur)), 3000);
      return;
    }
    setConfirmingDeleteId(null);
    try {
      await api(`/api/v1/ws/${wsId}/canned/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Canned responses</h2>
          <p className="text-xs text-slate-400">Saved replies your team inserts with “/” in the composer.</p>
        </div>
        <button
          onClick={() => startEdit("new")}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
        >
          + New response
        </button>
      </div>

      {editing && (
        <div className="mb-3 space-y-2 rounded-lg border border-slate-200 bg-white p-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. Refund policy)"
            maxLength={120}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="The reply text that gets inserted…"
            rows={3}
            maxLength={5000}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
          />
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tags, comma-separated (e.g. billing,refund)"
            maxLength={200}
            className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(null)} className="rounded-md px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={busy || !title.trim() || !body.trim()}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {items.length > 0 ? (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {items.map((r) => (
            <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <button onClick={() => startEdit(r)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium text-slate-900">{r.title}</div>
                <div className="truncate text-xs text-slate-500">{r.body}</div>
                {r.tags && <div className="mt-0.5 text-[10px] text-indigo-500">{r.tags}</div>}
              </button>
              <button
                onClick={() => handleDelete(r.id)}
                className={`shrink-0 text-xs ${confirmingDeleteId === r.id ? "font-medium text-red-600" : "text-slate-400 hover:text-red-600"}`}
              >
                {confirmingDeleteId === r.id ? "Click again" : "Delete"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !editing && <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">No canned responses yet.</p>
      )}
    </section>
  );
}
```

In `frontend/src/settings/SettingsPage.tsx`: `import { CannedSection } from "./CannedSection";` and render `{wsId && <CannedSection wsId={wsId} />}` between the "Install the widget" and "Workspace" sections.

- [x] **Step 8: e2e** — `e2e/tests/canned.spec.ts` (localhost only):

```ts
import { test, expect } from "@playwright/test";

const DEBUG_SECRET = process.env.DEBUG_AUTH_SECRET ?? "";

test("canned responses: create in settings, insert via / in composer, send", async ({ page, baseURL }) => {
  test.skip(!DEBUG_SECRET, "DEBUG_AUTH_SECRET env var required");

  const email = `canned-spec-${Date.now()}@example.com`;
  const magicLinkRes = await page.request.post(`${baseURL}/api/v1/auth/magic-link`, {
    headers: { "X-Debug-Auth": DEBUG_SECRET },
    data: { email },
  });
  const debugToken = (await magicLinkRes.json()).data.debugToken as string;
  await page.goto(`/auth/verify?token=${debugToken}`);
  await expect(page.getByText("Create your workspace")).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder("Acme Corp").fill(`canned-spec-${Date.now().toString(36)}`);
  const [createRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/workspaces") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create workspace" }).click(),
  ]);
  const { workspace } = (await createRes.json()).data as { workspace: { id: string; widgetKey: string } };

  // Create the canned response in settings.
  await page.goto(`/w/${workspace.id}/settings`);
  await page.getByRole("button", { name: "+ New response" }).click();
  await page.getByPlaceholder("Title (e.g. Refund policy)").fill("Refund policy");
  await page.getByPlaceholder("The reply text that gets inserted…").fill("Refunds take 5-7 business days.");
  // Scope to the canned editor card — the profile section also has a "Save" button.
  await page
    .locator("div.rounded-lg.border", { has: page.getByPlaceholder("Title (e.g. Refund policy)") })
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByText("Refunds take 5-7 business days.")).toBeVisible();

  // Seed a conversation via the widget API.
  const boot = await page.request.post(`${baseURL}/api/v1/widget/boot`, { data: { widgetKey: workspace.widgetKey } });
  const token = (await boot.json()).data.token as string;
  await page.request.post(`${baseURL}/api/v1/widget/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { body: "I want a refund please" },
  });

  // Insert it in the inbox composer via "/".
  await page.goto(`/w/${workspace.id}`);
  await page.getByText("I want a refund please").first().click();
  const composer = page.locator("textarea");
  await composer.fill("/ref");
  await expect(page.getByText("Canned responses — ↑↓ then Enter")).toBeVisible();
  await page.getByRole("button", { name: /Refund policy/ }).click();
  await expect(composer).toHaveValue("Refunds take 5-7 business days.");
  await composer.press("Enter");
  await expect(page.locator(".bg-indigo-600", { hasText: "Refunds take 5-7 business days." })).toBeVisible({ timeout: 10_000 });
});
```

- [x] **Step 9: Run everything locally.** `cd backend && pnpm test` (all green) → from repo root `pnpm --dir frontend build` → start `wrangler dev` (background, with `backend/.dev.vars` present) → `cd e2e && BASE_URL=http://localhost:8787 DEBUG_AUTH_SECRET=<from .dev.vars> npx playwright test canned` → PASS. Kill wrangler dev.

- [x] **Step 10: Deploy + smoke.** `pnpm --dir frontend build && cd backend && npx wrangler deploy`. Prod smoke: repeat the settings-create step by API against prod (debug flow) or eyeball in browser. **Commit + push**: `git add -A && git commit -m "feat(canned): saved replies with / quick-insert in the composer" && git push origin main`

---

### Task 7: SLA tracking

**Files:**
- Create: `backend/migrations/0006_sla.sql`
- Create: `frontend/src/lib/sla.ts`
- Create: `frontend/src/settings/SlaSection.tsx`
- Test: `backend/test/sla.test.ts`
- Modify: `backend/src/realtime/hub.ts`, `backend/src/conversations/conversations.api.ts`, `backend/src/workspaces/workspaces.api.ts`, `backend/src/auth/auth.api.ts` (only if it selects workspace columns), `frontend/src/lib/types.ts`, `frontend/src/inbox/ConversationList.tsx`, `frontend/src/inbox/ConversationView.tsx`, `frontend/src/inbox/InboxPage.tsx`, `frontend/src/settings/SettingsPage.tsx`

**Interfaces:**
- `conversations.first_agent_reply_at`, `conversations.resolved_at` (stamped in the hub + resolve endpoint)
- `workspaces.sla_first_response_min`, `workspaces.sla_resolution_min` (NULL = off)
- `computeSla(conv, targets, nowMs)` → `{ firstResponse: SlaState | null, resolution: SlaState | null }` where `SlaState = { state: "MET"|"PENDING"|"BREACHED"; dueAt: number; tookMin?: number }`
- `Conversation` type gains `firstAgentReplyAt: number | null; resolvedAt: number | null`
- `Workspace` type gains `slaFirstResponseMin?: number | null; slaResolutionMin?: number | null`

- [x] **Step 1: Migration `backend/migrations/0006_sla.sql`:**

```sql
ALTER TABLE conversations ADD COLUMN first_agent_reply_at INTEGER;
ALTER TABLE conversations ADD COLUMN resolved_at INTEGER;
ALTER TABLE workspaces ADD COLUMN sla_first_response_min INTEGER;
ALTER TABLE workspaces ADD COLUMN sla_resolution_min INTEGER;
UPDATE conversations SET first_agent_reply_at =
  (SELECT MIN(created_at) FROM messages m
   WHERE m.conversation_id = conversations.id AND m.sender_type IN ('AGENT','AI'));
UPDATE conversations SET resolved_at = updated_at WHERE status = 'RESOLVED';
```

Apply locally: `cd backend && CI=true npx wrangler d1 migrations apply super-profile --local`

- [x] **Step 2: Failing tests** — `backend/test/sla.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeSla } from "../../frontend/src/lib/sla";

const T0 = 1_000_000;
const MIN = 60_000;
const TARGETS = { firstResponseMin: 5, resolutionMin: 60 };

function conv(overrides: Partial<{ createdAt: number; firstAgentReplyAt: number | null; resolvedAt: number | null; status: string }> = {}) {
  return { createdAt: T0, firstAgentReplyAt: null, resolvedAt: null, status: "OPEN", ...overrides };
}

describe("computeSla", () => {
  it("null targets → null metrics", () => {
    const r = computeSla(conv(), { firstResponseMin: null, resolutionMin: null }, T0);
    expect(r.firstResponse).toBeNull();
    expect(r.resolution).toBeNull();
  });
  it("pending before the deadline, breached after", () => {
    expect(computeSla(conv(), TARGETS, T0 + 4 * MIN).firstResponse!.state).toBe("PENDING");
    expect(computeSla(conv(), TARGETS, T0 + 6 * MIN).firstResponse!.state).toBe("BREACHED");
  });
  it("met on time vs met late", () => {
    const onTime = computeSla(conv({ firstAgentReplyAt: T0 + 3 * MIN }), TARGETS, T0 + 99 * MIN);
    expect(onTime.firstResponse).toMatchObject({ state: "MET", tookMin: 3 });
    const late = computeSla(conv({ firstAgentReplyAt: T0 + 9 * MIN }), TARGETS, T0 + 99 * MIN);
    expect(late.firstResponse!.state).toBe("BREACHED");
    expect(late.firstResponse!.tookMin).toBe(9);
  });
  it("resolution uses resolvedAt only when RESOLVED", () => {
    const open = computeSla(conv({ resolvedAt: T0 + 10 * MIN }), TARGETS, T0 + 30 * MIN);
    expect(open.resolution!.state).toBe("PENDING"); // stale resolvedAt from a reopen is ignored
    const resolved = computeSla(conv({ status: "RESOLVED", resolvedAt: T0 + 30 * MIN }), TARGETS, T0 + 99 * MIN);
    expect(resolved.resolution).toMatchObject({ state: "MET", tookMin: 30 });
  });
});
```

- [x] **Step 3: Run to fail, implement `frontend/src/lib/sla.ts`:**

```ts
export type SlaTargets = { firstResponseMin: number | null; resolutionMin: number | null };
export type SlaState = { state: "MET" | "PENDING" | "BREACHED"; dueAt: number; tookMin?: number };
type SlaConv = { createdAt: number; firstAgentReplyAt: number | null; resolvedAt: number | null; status: string };

function evalMetric(startAt: number, targetMin: number, metAt: number | null, nowMs: number): SlaState {
  const dueAt = startAt + targetMin * 60_000;
  if (metAt != null) {
    return { state: metAt <= dueAt ? "MET" : "BREACHED", dueAt, tookMin: Math.max(0, Math.round((metAt - startAt) / 60_000)) };
  }
  return { state: nowMs > dueAt ? "BREACHED" : "PENDING", dueAt };
}

/** Breach is computed on read from the stamped timestamps — no cron anywhere. */
export function computeSla(conv: SlaConv, targets: SlaTargets, nowMs: number) {
  return {
    firstResponse:
      targets.firstResponseMin == null ? null : evalMetric(conv.createdAt, targets.firstResponseMin, conv.firstAgentReplyAt, nowMs),
    resolution:
      targets.resolutionMin == null
        ? null
        : evalMetric(conv.createdAt, targets.resolutionMin, conv.status === "RESOLVED" ? conv.resolvedAt : null, nowMs),
  };
}
```

`cd backend && pnpm test sla` — PASS.

- [x] **Step 4: Stamp in the hub.** In `backend/src/realtime/hub.ts`:
  - Add to `CONVERSATION_COLUMNS` (after the `ai_handling…` line): `first_agent_reply_at as firstAgentReplyAt, resolved_at as resolvedAt,`
  - Add to `ConversationRow` type: `firstAgentReplyAt: number | null; resolvedAt: number | null;`
  - In `handleMessage`'s conversation UPDATE SQL, after the `ai_escalated=…` line add:
    ```sql
    first_agent_reply_at=CASE WHEN ?5 IN ('AGENT','AI') AND first_agent_reply_at IS NULL THEN ?1 ELSE first_agent_reply_at END,
    resolved_at=CASE WHEN ?3='OPEN' THEN NULL ELSE resolved_at END,
    ```
    (binds unchanged: ?1=ts, ?3=nextStatus, ?5=senderType — an AI reply counts as the first response; a reopening message clears the stale resolved_at.)

- [x] **Step 5: Stamp in the resolve/reopen endpoint.** In `backend/src/conversations/conversations.api.ts`:
  - Add to `CONVERSATION_LIST_COLUMNS`: `c.first_agent_reply_at as firstAgentReplyAt, c.resolved_at as resolvedAt,` and to `ConversationListRow`: `firstAgentReplyAt: number | null; resolvedAt: number | null;`
  - In the PATCH handler where `patch.status` is applied, extend the status branch:
    ```ts
    if (patch.status !== undefined && patch.status !== current.status) {
      binds.push(patch.status);
      sets.push(`status=?${binds.length}`);
      if (patch.status === CONVERSATION.STATUS.RESOLVED) {
        binds.push(ts);
        sets.push(`resolved_at=?${binds.length}`);
        systemMessages.push("Resolved");
      } else {
        sets.push("resolved_at=NULL");
        // …existing SNOOZED / OPEN systemMessages logic unchanged…
      }
    }
    ```

- [x] **Step 6: Workspace targets.** In `backend/src/workspaces/workspaces.api.ts`:
  - Extend `PatchWorkspaceBody` with:
    ```ts
    slaFirstResponseMin: z.number().int().min(1).max(10_080).nullable().optional(),
    slaResolutionMin: z.number().int().min(1).max(10_080).nullable().optional(),
    ```
  - In the PATCH handler add the two set-mappings (same pattern as widgetColor):
    ```ts
    if (patch.slaFirstResponseMin !== undefined) {
      sets.push(`sla_first_response_min=?${sets.length + 1}`);
      binds.push(patch.slaFirstResponseMin);
    }
    if (patch.slaResolutionMin !== undefined) {
      sets.push(`sla_resolution_min=?${sets.length + 1}`);
      binds.push(patch.slaResolutionMin);
    }
    ```
  - Add `w.sla_first_response_min as slaFirstResponseMin, w.sla_resolution_min as slaResolutionMin` to the GET `/` list SELECT, and `sla_first_response_min as slaFirstResponseMin, sla_resolution_min as slaResolutionMin` to the PATCH's final SELECT.
  - Check `backend/src/auth/auth.api.ts`: `grep -n "workspaces" backend/src/auth/auth.api.ts` — if `/me` selects workspace columns explicitly, add the same two columns there.

- [x] **Step 7: Frontend types + settings.** In `frontend/src/lib/types.ts`: add to `Workspace`: `slaFirstResponseMin?: number | null; slaResolutionMin?: number | null;` and to `Conversation`: `firstAgentReplyAt: number | null; resolvedAt: number | null;`.

  Create `frontend/src/settings/SlaSection.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/Toast";
import type { Workspace } from "../lib/types";

export function SlaSection({ ws }: { ws: Workspace }) {
  const { refetchMe } = useAuth();
  const { showError } = useToast();
  const [fr, setFr] = useState(ws.slaFirstResponseMin?.toString() ?? "");
  const [res, setRes] = useState(ws.slaResolutionMin?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/v1/ws/${ws.id}`, {
        method: "PATCH",
        body: {
          slaFirstResponseMin: fr.trim() ? Number(fr) : null,
          slaResolutionMin: res.trim() ? Number(res) : null,
        },
      });
      await refetchMe();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      showError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold text-slate-900">SLA targets</h2>
      <p className="mb-3 text-xs text-slate-400">
        Time targets in minutes — the inbox shows countdowns and breach flags. Leave blank to turn a target off.
      </p>
      <form onSubmit={handleSave} className="flex items-end gap-3">
        <label className="text-xs text-slate-500">
          First response (min)
          <input
            type="number" min={1} max={10080} value={fr} onChange={(e) => setFr(e.target.value)}
            placeholder="off" className="mt-1 block w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="text-xs text-slate-500">
          Resolution (min)
          <input
            type="number" min={1} max={10080} value={res} onChange={(e) => setRes(e.target.value)}
            placeholder="off" className="mt-1 block w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit" disabled={busy}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {saved ? "Saved!" : "Save"}
        </button>
      </form>
    </section>
  );
}
```

In `SettingsPage.tsx`: `import { SlaSection } from "./SlaSection";` and render `{isAdmin && ws && <SlaSection ws={ws} />}` after the CannedSection.

- [x] **Step 8: Inbox chips.** In `frontend/src/inbox/InboxPage.tsx`: derive targets and pass down:
  ```tsx
  const { user, workspaces } = useAuth();
  const ws = workspaces.find((w) => w.id === wsId);
  const slaTargets = { firstResponseMin: ws?.slaFirstResponseMin ?? null, resolutionMin: ws?.slaResolutionMin ?? null };
  ```
  Pass `slaTargets={slaTargets}` to BOTH `<ConversationList>` and `<ConversationView>`.

  In `frontend/src/inbox/ConversationList.tsx`: import `computeSla, type SlaTargets` from `../lib/sla`; add prop `slaTargets: SlaTargets`. Inside the row map, before the return:
  ```tsx
  const sla = c.status === "RESOLVED" ? null : computeSla(c, slaTargets, Date.now());
  const worst =
    sla && (sla.firstResponse?.state === "BREACHED" || sla.resolution?.state === "BREACHED")
      ? { label: "SLA breached", className: "bg-red-100 text-red-700" }
      : sla && (sla.firstResponse?.state === "PENDING" || sla.resolution?.state === "PENDING")
        ? (() => {
            const due = Math.min(
              sla.firstResponse?.state === "PENDING" ? sla.firstResponse.dueAt : Infinity,
              sla.resolution?.state === "PENDING" ? sla.resolution.dueAt : Infinity,
            );
            const min = Math.max(0, Math.ceil((due - Date.now()) / 60_000));
            return { label: `⏰ ${min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`}`, className: "bg-amber-100 text-amber-700" };
          })()
        : null;
  ```
  Render next to the existing capsule (before the unread dot):
  ```tsx
  {worst && (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium ${worst.className}`}>{worst.label}</span>
  )}
  ```

  In `frontend/src/inbox/ConversationView.tsx`: add prop `slaTargets: SlaTargets`; under the subject line in the header (`<div className="text-xs text-slate-500">…`), add:
  ```tsx
  {(() => {
    const sla = computeSla(conversation, slaTargets, Date.now());
    if (!sla.firstResponse && !sla.resolution) return null;
    const fmt = (s: NonNullable<typeof sla.firstResponse>, name: string) =>
      s.state === "MET"
        ? `${name} ${s.tookMin}m ✓`
        : s.state === "BREACHED"
          ? `${name} breached${s.tookMin != null ? ` (${s.tookMin}m)` : ""}`
          : `${name} due in ${Math.max(0, Math.ceil((s.dueAt - Date.now()) / 60_000))}m`;
    return (
      <div className="mt-0.5 flex gap-2 text-[10px]">
        {sla.firstResponse && (
          <span className={sla.firstResponse.state === "BREACHED" ? "text-red-600" : sla.firstResponse.state === "MET" ? "text-emerald-600" : "text-amber-600"}>
            {fmt(sla.firstResponse, "First response")}
          </span>
        )}
        {sla.resolution && (
          <span className={sla.resolution.state === "BREACHED" ? "text-red-600" : sla.resolution.state === "MET" ? "text-emerald-600" : "text-amber-600"}>
            {fmt(sla.resolution, "Resolution")}
          </span>
        )}
      </div>
    );
  })()}
  ```

- [x] **Step 9: Green + deploy.** `cd backend && pnpm test` all pass; `pnpm --dir frontend build` (repo root); `cd backend && CI=true npx wrangler d1 migrations apply super-profile --remote && npx wrangler deploy`.

- [x] **Step 10: Prod verify.** Via debug-auth API against prod: create throwaway ws; PATCH sla targets `{slaFirstResponseMin: 1, slaResolutionMin: 2}`; widget-boot + create conversation; GET conversations → confirm `firstAgentReplyAt: null`; wait ~70s; GET again and confirm the frontend math would show BREACHED (the API returns the raw timestamps — assert `Date.now() > createdAt + 60_000`); agent-reply via POST message; GET → `firstAgentReplyAt` is now set. Log the evidence. **Commit + push**: `git add -A && git commit -m "feat(sla): first-response/resolution targets with on-read breach chips" && git push origin main`

---

### Task 8: Contact timeline — capture pipeline (events table, widget pageviews, last seen)

**Files:**
- Create: `backend/migrations/0007_contact_events.sql`
- Modify: `backend/src/widget/widget.api.ts`, `frontend/public/widget.js`, `frontend/src/widget/WidgetApp.tsx`, `frontend/public/demo.html`

**Interfaces:**
- `POST /api/v1/widget/events` body `{type:"PAGE_VIEW", url, title?}` (widget-token auth) → `{}`
- postMessage contract: loader → iframe `{type:"sp:page", url, title}`
- Table `contact_events(id, workspace_id, contact_id, type, url, title, created_at)`

- [x] **Step 1: Migration `backend/migrations/0007_contact_events.sql`:**

```sql
CREATE TABLE contact_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  type TEXT NOT NULL CHECK (type IN ('PAGE_VIEW')),
  url TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_contact ON contact_events (contact_id, created_at DESC);
```

Apply locally.

- [x] **Step 2: Events endpoint.** In `backend/src/widget/widget.api.ts` add (import `CONTACT_EVENT` from const):

```ts
const EventBody = z.object({
  type: z.literal(CONTACT_EVENT.TYPE.PAGE_VIEW),
  url: z.string().min(1).max(2000),
  title: z.string().max(300).optional(),
});
const widgetEventLimit = rateLimit(widgetMsgKey, 30, 60);

widgetApi.post("/events", widgetAuthMiddleware, validate(EventBody, "json"), widgetEventLimit, async (c) => {
  const workspaceId = c.get("widgetWorkspaceId");
  const userId = c.get("widgetUserId");
  const { url, title } = c.get("body") as z.infer<typeof EventBody>;
  const contact = await c.env.DB.prepare("SELECT id FROM contacts WHERE workspace_id=?1 AND user_id=?2")
    .bind(workspaceId, userId)
    .first<{ id: string }>();
  if (!contact) return ok(c); // boot creates the contact; a missing row is a razor-thin race — drop the event
  const ts = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO contact_events (id, workspace_id, contact_id, type, url, title, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(uuidv7(), workspaceId, contact.id, CONTACT_EVENT.TYPE.PAGE_VIEW, url, title ?? null, ts),
    c.env.DB.prepare("UPDATE contacts SET last_seen_at=?1 WHERE id=?2").bind(ts, contact.id),
  ]);
  return ok(c);
});
```

- [x] **Step 3: Loader — eager iframe + page reporting.** In `frontend/public/widget.js`, replace the final line `document.body.appendChild(button);` with:

```js
  document.body.appendChild(button);

  // Eager iframe: boots the widget on page load so page views are tracked from the first
  // visit and the unread badge works before the widget is ever opened.
  var eagerFrame = ensureIframe();

  function postPage() {
    var f = ensureIframe();
    if (!f.contentWindow) return;
    f.contentWindow.postMessage({ type: "sp:page", url: window.location.href, title: document.title }, origin);
  }
  eagerFrame.addEventListener("load", postPage);
  var origPush = history.pushState;
  var origReplace = history.replaceState;
  history.pushState = function () { origPush.apply(this, arguments); postPage(); };
  history.replaceState = function () { origReplace.apply(this, arguments); postPage(); };
  window.addEventListener("popstate", postPage);
  window.addEventListener("hashchange", postPage);
```

(`ensureIframe` already guards against double-creation; `display:none` stays until opened.)

- [x] **Step 4: Iframe side.** In `frontend/src/widget/WidgetApp.tsx` add after the `totalUnread` postMessage effect:

```tsx
  // Page views arrive from the host-page loader via postMessage; the loader knows the page,
  // this iframe knows the identity (widget token). Queue until booted, throttle repeats.
  const pageQueueRef = useRef<{ url: string; title: string }[]>([]);
  const lastPageRef = useRef<{ url: string; at: number }>({ url: "", at: 0 });
  useEffect(() => {
    function flush() {
      if (!booted) return;
      while (pageQueueRef.current.length) {
        const p = pageQueueRef.current.shift()!;
        const t = Date.now();
        if (p.url === lastPageRef.current.url && t - lastPageRef.current.at < 30_000) continue;
        lastPageRef.current = { url: p.url, at: t };
        widgetApi("/api/v1/widget/events", {
          method: "POST",
          body: { type: "PAGE_VIEW", url: p.url, title: p.title || undefined },
        }).catch(() => {});
      }
    }
    function onMessage(e: MessageEvent) {
      const d = e.data as { type?: string; url?: string; title?: string } | null;
      if (!d || d.type !== "sp:page" || e.source !== window.parent) return;
      pageQueueRef.current.push({ url: String(d.url ?? "").slice(0, 2000), title: String(d.title ?? "").slice(0, 300) });
      flush();
    }
    window.addEventListener("message", onMessage);
    flush(); // drain anything that arrived before boot completed
    return () => window.removeEventListener("message", onMessage);
  }, [booted]);
```

- [x] **Step 5: demo.html fake pages.** In `frontend/public/demo.html`, inside `.hero` after the `<h1>`, add a tiny nav and swap logic:

```html
      <nav style="margin-bottom: 24px; display: flex; gap: 12px; justify-content: center">
        <a href="#home" style="color: #4f46e5">Home</a>
        <a href="#pricing" style="color: #4f46e5">Pricing</a>
        <a href="#features" style="color: #4f46e5">Features</a>
      </nav>
      <p id="page-blurb">Welcome to the Acme Corp demo storefront.</p>
```

and extend the bottom script (inside the IIFE, after the widget injection):

```js
        var blurbs = {
          "#home": ["Acme Corp — demo store", "Welcome to the Acme Corp demo storefront."],
          "#pricing": ["Pricing — Acme Corp", "Pro is $9/month. Enterprise is a conversation."],
          "#features": ["Features — Acme Corp", "Everything you expect, and a chat widget."],
        };
        function renderPage() {
          var page = blurbs[window.location.hash] || blurbs["#home"];
          document.title = page[0];
          document.getElementById("page-blurb").textContent = page[1];
        }
        window.addEventListener("hashchange", renderPage);
        renderPage();
```

- [x] **Step 6: Local check.** `pnpm --dir frontend build` then wrangler dev; open `http://localhost:8787/demo.html?key=<widgetKey of a local ws>` in a browser (orchestrator) or drive via Playwright ad hoc; click Pricing/Features; then `npx wrangler d1 execute super-profile --local --command "SELECT url, title FROM contact_events ORDER BY created_at DESC LIMIT 5"` → the visited hashes appear. Existing e2e must stay green — run `cd e2e && BASE_URL=http://localhost:8787 DEBUG_AUTH_SECRET=<v> npx playwright test` (the widget specs exercise the now-eager iframe; fix any selector fallout — the iframe now exists pre-open but stays hidden, so `frameLocator` calls that used to implicitly wait for creation still work).

- [x] **Step 7: Commit**: `git add -A && git commit -m "feat(timeline): page-view capture — eager widget iframe, sp:page bridge, contact_events"`

---

### Task 9: Contact timeline — read API + super-profile panel + e2e + deploy

**Files:**
- Create: `backend/src/contacts/contacts.api.ts`
- Create: `frontend/src/lib/time.ts`
- Create: `e2e/tests/timeline.spec.ts`
- Modify: `backend/src/index.ts`, `frontend/src/inbox/ContactPanel.tsx`, `frontend/src/inbox/ConversationView.tsx`, `frontend/src/inbox/InboxPage.tsx`, `frontend/src/inbox/ConversationList.tsx` (use shared relativeTime), `frontend/src/lib/types.ts`

**Interfaces:**
- `GET /api/v1/ws/:wsId/contacts/:contactId/timeline` → `{ contact: {id,name,email,lastSeenAt}, events: ContactEvent[], conversations: TimelineConversation[] }`
- `ContactEvent = { id: string; type: "PAGE_VIEW"; url: string; title: string | null; createdAt: number }`
- `TimelineConversation = { id; channel; status; subject; lastMessagePreview; lastMessageAt; messageCount }`
- `relativeTime(ts: number): string` in `frontend/src/lib/time.ts`
- `ContactPanel` new props: `{ wsId, contact, currentConversationId, onSelectConversation }`

- [x] **Step 1: `frontend/src/lib/time.ts`** — move `relativeTime` out of ConversationList verbatim, export it; ConversationList imports it (delete its local copy).

- [x] **Step 2: `backend/src/contacts/contacts.api.ts`:**

```ts
import { Hono } from "hono";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { authMiddleware, wsMiddleware } from "../middleware/auth";
import type { HonoEnv } from "../common/hono-env";

export const contactsApi = new Hono<HonoEnv>();
contactsApi.use("*", authMiddleware, wsMiddleware);

contactsApi.get("/contacts/:contactId/timeline", async (c) => {
  const { workspaceId } = c.get("member");
  const contactId = c.req.param("contactId");
  const contact = await c.env.DB.prepare(
    "SELECT id, name, email, last_seen_at as lastSeenAt FROM contacts WHERE id=?1 AND workspace_id=?2",
  )
    .bind(contactId, workspaceId)
    .first();
  if (!contact) throw ctxErr.contact.notFound();
  const [{ results: events }, { results: conversations }] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, type, url, title, created_at as createdAt FROM contact_events WHERE contact_id=?1 ORDER BY created_at DESC LIMIT 30",
    )
      .bind(contactId)
      .all(),
    c.env.DB.prepare(
      `SELECT id, channel, status, subject, last_message_preview as lastMessagePreview,
              last_message_at as lastMessageAt, message_count as messageCount
       FROM conversations WHERE workspace_id=?1 AND contact_id=?2 ORDER BY last_message_at DESC LIMIT 20`,
    )
      .bind(workspaceId, contactId)
      .all(),
  ]);
  return ok(c, { contact, events, conversations });
});
```

Mount: `app.route("/api/v1/ws/:wsId", contactsApi);` in index.ts.

- [x] **Step 3: Types.** In `frontend/src/lib/types.ts`:

```ts
export type ContactEvent = { id: string; type: "PAGE_VIEW"; url: string; title: string | null; createdAt: number };
export type TimelineConversation = {
  id: string; channel: Channel; status: ConversationStatus; subject: string | null;
  lastMessagePreview: string; lastMessageAt: number; messageCount: number;
};
export type ContactTimeline = {
  contact: { id: string; name: string | null; email: string | null; lastSeenAt: number | null };
  events: ContactEvent[];
  conversations: TimelineConversation[];
};
```

- [x] **Step 4: Rebuild `frontend/src/inbox/ContactPanel.tsx`:**

```tsx
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { relativeTime } from "../lib/time";
import type { Contact, ContactTimeline } from "../lib/types";

function pageLabel(url: string, title: string | null): string {
  if (title) return title;
  try {
    const u = new URL(url);
    return `${u.pathname}${u.hash}` || u.hostname;
  } catch {
    return url;
  }
}

/** The contact's "super profile": identity, presence, browsing trail and full history. */
export function ContactPanel({
  wsId,
  contact,
  currentConversationId,
  onSelectConversation,
}: {
  wsId: string;
  contact: Contact;
  currentConversationId: string;
  onSelectConversation: (id: string) => void;
}) {
  const [timeline, setTimeline] = useState<ContactTimeline | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ContactTimeline>(`/api/v1/ws/${wsId}/contacts/${contact.id}/timeline`)
      .then((data) => {
        if (!cancelled) setTimeline(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wsId, contact.id, currentConversationId]);

  const lastSeen = timeline?.contact.lastSeenAt;

  return (
    <div className="border-b border-slate-200 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Contact</h3>
      <div className="mt-2 text-sm font-medium text-slate-900">{contact.name ?? "Anonymous visitor"}</div>
      {contact.email && <div className="mt-0.5 text-xs text-slate-500">{contact.email}</div>}
      {lastSeen != null && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
          <span
            className={`h-1.5 w-1.5 rounded-full ${Date.now() - lastSeen < 2 * 60_000 ? "bg-emerald-500" : "bg-slate-300"}`}
          />
          Last seen {relativeTime(lastSeen)}
        </div>
      )}

      {timeline && timeline.events.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Recent activity</h4>
          <ul className="mt-1.5 space-y-1">
            {timeline.events.slice(0, 8).map((e) => (
              <li key={e.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate text-slate-600" title={e.url}>
                  👁 {pageLabel(e.url, e.title)}
                </span>
                <span className="shrink-0 text-slate-400">{relativeTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {timeline && timeline.conversations.length > 1 && (
        <div className="mt-4">
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Conversations ({timeline.conversations.length})
          </h4>
          <ul className="mt-1.5 space-y-1">
            {timeline.conversations.slice(0, 8).map((tc) => (
              <li key={tc.id}>
                <button
                  onClick={() => tc.id !== currentConversationId && onSelectConversation(tc.id)}
                  className={`w-full truncate rounded px-1.5 py-1 text-left text-[11px] ${
                    tc.id === currentConversationId
                      ? "bg-indigo-50 font-medium text-indigo-700"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <span className="mr-1">{tc.channel === "EMAIL" ? "✉️" : "💬"}</span>
                  {tc.subject || tc.lastMessagePreview || "Conversation"}
                  <span className="ml-1 text-slate-400">· {relativeTime(tc.lastMessageAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 5: Wire props.** `ConversationView` gains prop `onSelectConversation: (id: string) => void` and renders `<ContactPanel wsId={wsId} contact={conversation.contact} currentConversationId={conversationId} onSelectConversation={onSelectConversation} />`. `InboxPage` passes `onSelectConversation={setSelectedId}`.

- [x] **Step 6: e2e** — `e2e/tests/timeline.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

const DEBUG_SECRET = process.env.DEBUG_AUTH_SECRET ?? "";

test("timeline: widget pageviews and last-seen appear on the contact panel", async ({ page, context, baseURL }) => {
  test.skip(!DEBUG_SECRET, "DEBUG_AUTH_SECRET env var required");

  const email = `timeline-spec-${Date.now()}@example.com`;
  const magicLinkRes = await page.request.post(`${baseURL}/api/v1/auth/magic-link`, {
    headers: { "X-Debug-Auth": DEBUG_SECRET },
    data: { email },
  });
  const debugToken = (await magicLinkRes.json()).data.debugToken as string;
  await page.goto(`/auth/verify?token=${debugToken}`);
  await expect(page.getByText("Create your workspace")).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder("Acme Corp").fill(`timeline-${Date.now().toString(36)}`);
  const [createRes] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/workspaces") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create workspace" }).click(),
  ]);
  const { workspace } = (await createRes.json()).data as { workspace: { id: string; widgetKey: string } };

  // Visitor browses the demo store (eager iframe reports pageviews) and opens a ticket.
  const visitor = await context.newPage();
  await visitor.goto(`/demo.html?key=${workspace.widgetKey}`);
  await visitor.getByRole("link", { name: "Pricing" }).click();
  await visitor.getByRole("link", { name: "Features" }).click();
  await visitor.locator('button[aria-label="Open chat"]').click();
  const frame = visitor.frameLocator("iframe");
  await frame.getByText("+ New conversation").click();
  await frame.getByPlaceholder("How can we help?").fill("Hi, question about pricing");
  await frame.getByRole("button", { name: /Send|Start/ }).click();

  // Agent opens the conversation — the panel shows the browsing trail.
  await page.goto(`/w/${workspace.id}`);
  await page.getByText("Hi, question about pricing").first().click();
  await expect(page.getByText("Recent activity")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Pricing — Acme Corp/)).toBeVisible();
  await expect(page.getByText(/Last seen/)).toBeVisible();
});
```

NOTE: before writing the Send-button locator, check `frontend/src/widget/NewTicket.tsx` for the actual button label and placeholder text; adjust the spec to the real strings.

- [x] **Step 7: Full local run.** backend tests green; frontend build; wrangler dev; `npx playwright test timeline canned` PASS; full `npx playwright test` PASS (older specs must survive the eager iframe). Kill dev server.

- [x] **Step 8: Deploy + prod smoke.** Apply migration 0007 `--remote`, deploy, then browse the prod demo page with a real workspace key (orchestrator, in browser), click around, open the inbox, see the trail. **Commit + push**: `git add -A && git commit -m "feat(timeline): contact super-profile panel — activity trail, last seen, history" && git push origin main`

---

### Task 10: Analytics dashboard

**Files:**
- Create: `backend/src/analytics/compute.ts`
- Create: `backend/src/analytics/analytics.api.ts`
- Create: `frontend/src/analytics/AnalyticsPage.tsx`
- Test: `backend/test/analytics-compute.test.ts`
- Modify: `backend/src/index.ts`, `frontend/src/App.tsx`, `frontend/src/components/Shell.tsx`

**Interfaces:**
- `GET /api/v1/ws/:wsId/analytics?days=14` → `{ analytics: Analytics }` where

```ts
type Analytics = {
  days: number;
  totals: { conversations: number; open: number; resolved: number; resolutionRate: number | null };
  firstResponse: { medianMin: number | null; avgMin: number | null };
  resolution: { medianMin: number | null };
  channels: { chat: number; email: number };
  ai: { conversations: number; resolvedAlone: number; deflectionRate: number | null };
  volumeByDay: { day: string; count: number }[];   // exactly `days` entries, oldest first
  busiestHours: { hour: number; count: number }[]; // exactly 24 entries
  agents: { userId: string; name: string; replies: number; assigned: number; resolved: number }[];
};
```

- [x] **Step 1: Failing tests** — `backend/test/analytics-compute.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeAnalytics, median } from "../src/analytics/compute";

const MIN = 60_000;
const NOW = 20 * 24 * 3600 * 1000; // fixed "now"

function conv(over: Partial<Parameters<typeof computeAnalytics>[0][0]> = {}) {
  return {
    createdAt: NOW - 3 * 24 * 3600 * 1000, firstAgentReplyAt: null, resolvedAt: null,
    status: "OPEN", channel: "CHAT", assigneeId: null, aiMsgs: 0, agentMsgs: 0, ...over,
  };
}

describe("median", () => {
  it("handles empty, odd, even", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 9, 5])).toBe(5);
    expect(median([1, 3, 5, 9])).toBe(4);
  });
});

describe("computeAnalytics", () => {
  it("computes rates, medians, ai deflection and fills day/hour bins", () => {
    const convs = [
      conv({ status: "RESOLVED", firstAgentReplyAt: NOW - 3 * 24 * 3600 * 1000 + 4 * MIN, resolvedAt: NOW - 3 * 24 * 3600 * 1000 + 30 * MIN, agentMsgs: 2 }),
      conv({ status: "RESOLVED", aiMsgs: 3, agentMsgs: 0, resolvedAt: NOW - 2 * 24 * 3600 * 1000, channel: "EMAIL" }),
      conv({ aiMsgs: 1, agentMsgs: 1 }),
    ];
    const a = computeAnalytics(convs, [{ day: "1970-01-17", count: 4 }], [{ hour: 9, count: 7 }], [], 14, NOW);
    expect(a.totals.conversations).toBe(3);
    expect(a.totals.resolved).toBe(2);
    expect(a.totals.resolutionRate).toBeCloseTo(2 / 3);
    expect(a.firstResponse.medianMin).toBe(4);
    expect(a.resolution.medianMin).toBe(30);
    expect(a.channels).toEqual({ chat: 2, email: 1 });
    expect(a.ai.conversations).toBe(2);
    expect(a.ai.resolvedAlone).toBe(1);
    expect(a.ai.deflectionRate).toBeCloseTo(0.5);
    expect(a.volumeByDay).toHaveLength(14);
    expect(a.busiestHours).toHaveLength(24);
    expect(a.busiestHours[9].count).toBe(7);
    expect(a.volumeByDay.find((d) => d.day === "1970-01-17")?.count).toBe(4);
  });
  it("empty data is all nulls and zeros, never NaN", () => {
    const a = computeAnalytics([], [], [], [], 7, NOW);
    expect(a.totals.resolutionRate).toBeNull();
    expect(a.firstResponse.medianMin).toBeNull();
    expect(a.ai.deflectionRate).toBeNull();
    expect(a.volumeByDay).toHaveLength(7);
  });
});
```

- [x] **Step 2: Implement `backend/src/analytics/compute.ts`:**

```ts
export type AnalyticsConv = {
  createdAt: number;
  firstAgentReplyAt: number | null;
  resolvedAt: number | null;
  status: string;
  channel: string;
  assigneeId: string | null;
  aiMsgs: number;
  agentMsgs: number;
};
export type DayCount = { day: string; count: number };
export type HourCount = { hour: number; count: number };
export type AgentReplyRow = { userId: string; name: string; replies: number };

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function toMin(ms: number): number {
  return Math.round(ms / 60_000);
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function computeAnalytics(
  convs: AnalyticsConv[],
  msgByDay: DayCount[],
  msgByHour: HourCount[],
  agentReplies: AgentReplyRow[],
  days: number,
  nowMs: number,
) {
  const resolved = convs.filter((c) => c.status === "RESOLVED");
  const frTimes = convs
    .filter((c) => c.firstAgentReplyAt != null)
    .map((c) => toMin((c.firstAgentReplyAt as number) - c.createdAt));
  const resTimes = resolved
    .filter((c) => c.resolvedAt != null)
    .map((c) => toMin((c.resolvedAt as number) - c.createdAt));
  const aiConvs = convs.filter((c) => c.aiMsgs > 0);
  const resolvedAlone = aiConvs.filter((c) => c.status === "RESOLVED" && c.agentMsgs === 0);

  const dayMap = new Map(msgByDay.map((d) => [d.day, d.count]));
  const volumeByDay = Array.from({ length: days }, (_, i) => {
    const day = dayKey(nowMs - (days - 1 - i) * 24 * 3600 * 1000);
    return { day, count: dayMap.get(day) ?? 0 };
  });
  const hourMap = new Map(msgByHour.map((h) => [h.hour, h.count]));
  const busiestHours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: hourMap.get(hour) ?? 0 }));

  const byAssignee = new Map<string, { assigned: number; resolved: number }>();
  for (const c of convs) {
    if (!c.assigneeId) continue;
    const cur = byAssignee.get(c.assigneeId) ?? { assigned: 0, resolved: 0 };
    cur.assigned += 1;
    if (c.status === "RESOLVED") cur.resolved += 1;
    byAssignee.set(c.assigneeId, cur);
  }
  const agents = agentReplies.map((a) => ({
    ...a,
    assigned: byAssignee.get(a.userId)?.assigned ?? 0,
    resolved: byAssignee.get(a.userId)?.resolved ?? 0,
  }));

  return {
    days,
    totals: {
      conversations: convs.length,
      open: convs.filter((c) => c.status === "OPEN").length,
      resolved: resolved.length,
      resolutionRate: convs.length ? resolved.length / convs.length : null,
    },
    firstResponse: {
      medianMin: median(frTimes),
      avgMin: frTimes.length ? Math.round(frTimes.reduce((a, b) => a + b, 0) / frTimes.length) : null,
    },
    resolution: { medianMin: median(resTimes) },
    channels: {
      chat: convs.filter((c) => c.channel === "CHAT").length,
      email: convs.filter((c) => c.channel === "EMAIL").length,
    },
    ai: {
      conversations: aiConvs.length,
      resolvedAlone: resolvedAlone.length,
      deflectionRate: aiConvs.length ? resolvedAlone.length / aiConvs.length : null,
    },
    volumeByDay,
    busiestHours,
    agents,
  };
}
```

Run `pnpm test analytics` — PASS.

- [x] **Step 3: API** — `backend/src/analytics/analytics.api.ts`:

```ts
import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware } from "../middleware/auth";
import { now } from "../common/id";
import { computeAnalytics, type AgentReplyRow, type AnalyticsConv, type DayCount, type HourCount } from "./compute";
import type { HonoEnv } from "../common/hono-env";

const Query = z.object({ days: z.coerce.number().int().min(1).max(90).optional() });

export const analyticsApi = new Hono<HonoEnv>();
analyticsApi.use("*", authMiddleware, wsMiddleware);

analyticsApi.get("/analytics", validate(Query, "query"), async (c) => {
  const { workspaceId } = c.get("member");
  const { days = 14 } = c.get("body") as z.infer<typeof Query>;
  const nowMs = now();
  const since = nowMs - days * 24 * 3600 * 1000;

  const [convRes, dayRes, hourRes, agentRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT c.created_at as createdAt, c.first_agent_reply_at as firstAgentReplyAt,
              c.resolved_at as resolvedAt, c.status as status, c.channel as channel,
              c.assignee_id as assigneeId,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='AI') as aiMsgs,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='AGENT') as agentMsgs
       FROM conversations c WHERE c.workspace_id=?1 AND c.created_at>=?2 LIMIT 2000`,
    )
      .bind(workspaceId, since)
      .all<AnalyticsConv>(),
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') as day, COUNT(*) as count
       FROM messages WHERE workspace_id=?1 AND created_at>=?2 GROUP BY day`,
    )
      .bind(workspaceId, since)
      .all<DayCount>(),
    c.env.DB.prepare(
      `SELECT CAST(strftime('%H', created_at/1000, 'unixepoch') AS INTEGER) as hour, COUNT(*) as count
       FROM messages WHERE workspace_id=?1 AND created_at>=?2 GROUP BY hour`,
    )
      .bind(workspaceId, since)
      .all<HourCount>(),
    c.env.DB.prepare(
      `SELECT u.id as userId, COALESCE(u.name, u.email, 'Agent') as name, COUNT(m.id) as replies
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.workspace_id=?1 AND m.sender_type='AGENT' AND m.created_at>=?2
       GROUP BY u.id ORDER BY replies DESC LIMIT 20`,
    )
      .bind(workspaceId, since)
      .all<AgentReplyRow>(),
  ]);

  const analytics = computeAnalytics(convRes.results, dayRes.results, hourRes.results, agentRes.results, days, nowMs);
  return ok(c, { analytics });
});
```

Mount in index.ts: `app.route("/api/v1/ws/:wsId", analyticsApi);`

- [x] **Step 4: Page** — `frontend/src/analytics/AnalyticsPage.tsx` (CSS-only bars, no chart lib):

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { api, ApiError } from "../lib/api";
import { useToast } from "../components/Toast";

type Analytics = {
  days: number;
  totals: { conversations: number; open: number; resolved: number; resolutionRate: number | null };
  firstResponse: { medianMin: number | null; avgMin: number | null };
  resolution: { medianMin: number | null };
  channels: { chat: number; email: number };
  ai: { conversations: number; resolvedAlone: number; deflectionRate: number | null };
  volumeByDay: { day: string; count: number }[];
  busiestHours: { hour: number; count: number }[];
  agents: { userId: string; name: string; replies: number; assigned: number; resolved: number }[];
};

function fmtMin(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

function fmtPct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
    </div>
  );
}

export default function AnalyticsPage() {
  const { wsId } = useParams();
  const { showError } = useToast();
  const [days, setDays] = useState(14);
  const [data, setData] = useState<Analytics | null>(null);

  useEffect(() => {
    if (!wsId) return;
    api<{ analytics: Analytics }>(`/api/v1/ws/${wsId}/analytics?days=${days}`)
      .then((d) => setData(d.analytics))
      .catch((err) => showError(err instanceof ApiError ? err.message : "Something went wrong"));
  }, [wsId, days, showError]);

  if (!data) return <div className="p-6 text-sm text-slate-400">Loading analytics…</div>;

  const maxDay = Math.max(1, ...data.volumeByDay.map((d) => d.count));
  const maxHour = Math.max(1, ...data.busiestHours.map((h) => h.count));

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Analytics</h1>
        <div className="flex gap-1">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                days === d ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Conversations" value={String(data.totals.conversations)} hint={`${data.totals.open} open`} />
        <StatCard label="Median first response" value={fmtMin(data.firstResponse.medianMin)} hint={`avg ${fmtMin(data.firstResponse.avgMin)}`} />
        <StatCard label="Resolution rate" value={fmtPct(data.totals.resolutionRate)} hint={`${data.totals.resolved} resolved · median ${fmtMin(data.resolution.medianMin)}`} />
        <StatCard label="AI deflection" value={fmtPct(data.ai.deflectionRate)} hint={`${data.ai.resolvedAlone}/${data.ai.conversations} resolved by AI alone`} />
      </div>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Message volume — last {data.days} days</h2>
        {data.volumeByDay.every((d) => d.count === 0) ? (
          <p className="py-6 text-center text-xs text-slate-400">No messages in this window yet.</p>
        ) : (
          <div className="flex h-32 items-end gap-1">
            {data.volumeByDay.map((d) => (
              <div key={d.day} className="group relative flex-1">
                <div
                  className="w-full rounded-t bg-indigo-500 transition group-hover:bg-indigo-600"
                  style={{ height: `${Math.max(2, (d.count / maxDay) * 120)}px` }}
                  title={`${d.day}: ${d.count} messages`}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Busiest hours (UTC)</h2>
        <div className="flex gap-1">
          {data.busiestHours.map((h) => (
            <div key={h.hour} className="flex-1 text-center">
              <div
                className="mx-auto w-full rounded-sm bg-indigo-500"
                style={{ opacity: h.count === 0 ? 0.08 : 0.25 + 0.75 * (h.count / maxHour), height: "28px" }}
                title={`${h.hour}:00 — ${h.count} messages`}
              />
              {h.hour % 6 === 0 && <div className="mt-1 text-[9px] text-slate-400">{h.hour}</div>}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Agent performance</h2>
        {data.agents.length === 0 ? (
          <p className="py-4 text-center text-xs text-slate-400">No agent replies in this window yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                <th className="pb-2 font-medium">Agent</th>
                <th className="pb-2 font-medium">Replies</th>
                <th className="pb-2 font-medium">Assigned</th>
                <th className="pb-2 font-medium">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.userId} className="border-b border-slate-100">
                  <td className="py-2 font-medium text-slate-900">{a.name}</td>
                  <td className="py-2 text-slate-600">{a.replies}</td>
                  <td className="py-2 text-slate-600">{a.assigned}</td>
                  <td className="py-2 text-slate-600">{a.resolved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[10px] text-slate-400">
          Channel split: {data.channels.chat} chat · {data.channels.email} email
        </p>
      </section>
    </div>
  );
}
```

- [x] **Step 5: Route + nav.** In `frontend/src/App.tsx`: `import AnalyticsPage from "./analytics/AnalyticsPage";` + `<Route path="analytics" element={<AnalyticsPage />} />` inside the `/w/:wsId` route. In `frontend/src/components/Shell.tsx` add `{ to: "analytics", label: "Analytics" }` to `navItems` between Knowledge Base and Settings.

- [x] **Step 6: Green + deploy + verify.** Backend tests green; build; deploy; open `https://sp.hyugorix.com/w/<ban-gera wsId>/analytics` (read-only — safe on ban-gera) and confirm real numbers render. **Commit + push**: `git add -A && git commit -m "feat(analytics): dashboard — response times, volume, busiest hours, agent + AI deflection stats" && git push origin main`

---

### Task 11: Final sweep — full verification, MORNING.md, README, decision log

**Files:**
- Modify: `MORNING.md`, `README.md`, `decision.md`, this plan file (final checkboxes)

- [x] **Step 1: Full test suites.** `cd backend && pnpm test` (all green) and full local e2e: build frontend, wrangler dev, `cd e2e && BASE_URL=http://localhost:8787 DEBUG_AUTH_SECRET=<v> npx playwright test` — ALL specs pass (old + canned + timeline).

- [x] **Step 2: Prod smoke.** `cd e2e && BASE_URL=https://sp.hyugorix.com DEBUG_AUTH_SECRET=<prod value from .env> npx playwright test` — pass (these specs create throwaway workspaces; they never touch ban-gera). Manually confirm `https://docs.kaushikrb.com` still serves 200.

- [x] **Step 3: decision.md.** Append entries (Context/Options/Chosen/Why) for: AI replies count as first response; eager widget iframe (and the pre-open badge fix it brings); re-sync never deletes; bot-challenge fail-fast thresholds; analytics agent attribution = current assignee approximation; digest regenerates only on sync.

- [x] **Step 4: README.** Add the five features to the feature list with one-line descriptions, and a "Docs import" subsection: what it does, the 10-article/15-page caps, the cooldown env var, the bot-protection behavior, and that re-syncs upsert by source URL.

- [x] **Step 5: MORNING.md.** Write the wake-up report: what shipped (per feature: what/where/commit), the **60-second verify path** for each, and the **live demo script**:
  1. KB page (ban-gera) → Docs import panel → paste `https://superprofile.bio/blog` → Sync → honest bot-protection failure (no cooldown armed).
  2. Same panel → paste `https://hono.dev/docs` → Sync → watch counters tick → articles live on docs.kaushikrb.com.
  3. Widget demo page → browse Pricing/Features → open ticket → inbox shows the browsing trail + last seen.
  4. Composer: type `/` → canned response inserts. Settings: SLA targets set to 1–2 min → chips count down and flip red.
  5. Delegate to AI → the reply cites an imported Hono article by its docs.kaushikrb.com URL (digest at work).
  6. Analytics tab → live numbers incl. AI deflection.
  Note anything requiring the user's hands, and that ban-gera's first real sync consumes its daily cooldown (change `KB_SYNC_COOLDOWN_MIN` and redeploy to reset for rehearsals).

- [x] **Step 6: Final commit + push.** `git add -A && git commit -m "docs: morning report, README features, decision log for overnight v2" && git push origin main`
