import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../src/kb/search";

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
