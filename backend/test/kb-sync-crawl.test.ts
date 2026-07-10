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
