import { describe, expect, it } from "vitest";
import { ftsQuery, stripMarkdown } from "../src/kb/search";

describe("ftsQuery", () => {
  it("turns words into an OR-of-prefixes query", () => {
    expect(ftsQuery("reset password")).toBe("reset* OR password*");
  });

  it("strips punctuation that would be an FTS5 syntax error", () => {
    expect(ftsQuery("is the refund done ?")).toBe("is* OR the* OR refund* OR done*");
    expect(ftsQuery('charged $49 twice, why?!')).toBe("charged* OR 49* OR twice* OR why*");
    expect(ftsQuery('"quoted" (parens) col:on')).toBe("quoted* OR parens* OR col* OR on*");
  });

  it("lowercases terms", () => {
    expect(ftsQuery("Refund NOW")).toBe("refund* OR now*");
  });

  it("returns null when nothing searchable remains", () => {
    expect(ftsQuery("  ")).toBeNull();
    expect(ftsQuery("?!$")).toBeNull();
  });
});

describe("stripMarkdown", () => {
  it("strips headings, emphasis, links, and list markers", () => {
    const md = "# Title\n\nSome **bold** and _italic_ text with a [link](https://x.com) and a list:\n- one\n- two";
    const text = stripMarkdown(md);
    expect(text).not.toContain("#");
    expect(text).not.toContain("*");
    expect(text).not.toContain("[");
    expect(text).toContain("Title");
    expect(text).toContain("bold");
    expect(text).toContain("link");
  });

  it("removes fenced code blocks entirely", () => {
    const md = "Before\n```js\nconst x = 1;\n```\nAfter";
    const text = stripMarkdown(md);
    expect(text).not.toContain("const x");
    expect(text).toContain("Before");
    expect(text).toContain("After");
  });

  it("collapses whitespace", () => {
    expect(stripMarkdown("a   b\n\n\nc")).toBe("a b c");
  });
});
