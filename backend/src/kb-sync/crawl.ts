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
  const rawTitle = (root.querySelector("h1")?.text.trim() || root.querySelector("title")?.text.trim() || "")
    // zero-width chars — VitePress and friends embed U+200B anchors inside headings
    .replace(/[​‌‍﻿]/g, "")
    .trim();
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
  // The page title becomes the article title — drop the leading h1 so the body markdown
  // (and the excerpt derived from it) doesn't open by repeating it.
  container.querySelector("h1")?.remove();
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
  // .text (not .rawText) so HTML entities like &quot; and &amp; are decoded in the markdown
  if (node.nodeType === NodeType.TEXT_NODE) return node.text.replace(/\s+/g, " ");
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

// node-html-parser's default blockTextElements = { script, noscript, style, pre: true } treats
// <pre> contents as opaque (any key present — true OR false — stops it from parsing children;
// only OMITTING the key parses normally). Omit "pre" so <pre><code> becomes real elements below.
const MARKDOWN_PARSE_OPTIONS = { blockTextElements: { script: true, noscript: true, style: true } };

export function htmlToMarkdown(html: string): string {
  const root = parse(html, MARKDOWN_PARSE_OPTIONS);
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

/**
 * A finished crawl that imported nothing is a failure, never a silent "DONE · 0 articles" —
 * a fully-blocked site yields a single challenged fetch (no links), so the blocked-streak
 * abort can't fire and this final classification is what surfaces the honest error instead.
 * FAILED also means the cooldown never arms, so the user can retry immediately.
 */
export function finalOutcome(
  imported: number,
  blockedTotal: number,
): { status: "DONE"; error: null } | { status: "FAILED"; error: string } {
  if (imported > 0) return { status: "DONE", error: null };
  return { status: "FAILED", error: blockedTotal > 0 ? KB_SYNC.BLOCKED_MSG : KB_SYNC.NO_CONTENT_MSG };
}

/** How many frontier URLs to process in this alarm firing (0 = crawl is finished). */
export function nextBatch(frontier: string[], visitedCount: number, importedCount: number): number {
  if (importedCount >= KB_SYNC.ARTICLE_CAP) return 0;
  const pageRoom = Math.max(0, KB_SYNC.PAGE_CAP - visitedCount);
  return Math.min(frontier.length, KB_SYNC.BATCH_SIZE, pageRoom);
}
