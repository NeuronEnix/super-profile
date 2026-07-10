import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/common/html";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x&y'z")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;y&#39;z&quot;)&lt;/script&gt;",
    );
  });

  it("escapes & first so entities are not double-mangled", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });
});
