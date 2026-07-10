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
