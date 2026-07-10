import { describe, expect, it } from "vitest";
import { isValidSlug, isValidArticleSlug } from "../src/common/slug";

describe("isValidSlug (workspace handle rules)", () => {
  it("accepts lowercase letters", () => {
    expect(isValidSlug("acme")).toBe(true);
  });

  it("accepts digits when not the first character", () => {
    expect(isValidSlug("acme2")).toBe(true);
    expect(isValidSlug("a1b2")).toBe(true);
  });

  it("rejects a leading digit", () => {
    expect(isValidSlug("2acme")).toBe(false);
    expect(isValidSlug("123")).toBe(false);
  });

  it("accepts dots and hyphens in the middle", () => {
    expect(isValidSlug("ban-gera")).toBe(true);
    expect(isValidSlug("acme.support")).toBe(true);
    expect(isValidSlug("a.b-c1")).toBe(true);
  });

  it("rejects a trailing dot or hyphen", () => {
    expect(isValidSlug("acme-")).toBe(false);
    expect(isValidSlug("acme.")).toBe(false);
  });

  it("rejects a leading dot or hyphen", () => {
    expect(isValidSlug("-acme")).toBe(false);
    expect(isValidSlug(".acme")).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(isValidSlug("Acme")).toBe(false);
    expect(isValidSlug("ACME")).toBe(false);
  });

  it("rejects spaces and other symbols", () => {
    expect(isValidSlug("acme corp")).toBe(false);
    expect(isValidSlug("acme_corp")).toBe(false);
    expect(isValidSlug("acme@corp")).toBe(false);
  });

  it("accepts a single lowercase letter (format-wise)", () => {
    expect(isValidSlug("a")).toBe(true);
  });
});

describe("isValidArticleSlug (KB article slug rules)", () => {
  it("accepts lowercase letters, numbers and hyphens (5–100 chars)", () => {
    expect(isValidArticleSlug("getting-started")).toBe(true);
    expect(isValidArticleSlug("refund-policy-2024")).toBe(true);
    expect(isValidArticleSlug("hello")).toBe(true);
  });

  it("rejects fewer than 5 characters", () => {
    expect(isValidArticleSlug("faq")).toBe(false);
    expect(isValidArticleSlug("a-b")).toBe(false);
  });

  it("rejects more than 100 characters", () => {
    expect(isValidArticleSlug("a".repeat(101))).toBe(false);
    expect(isValidArticleSlug("a".repeat(100))).toBe(true);
  });

  it("rejects uppercase letters", () => {
    expect(isValidArticleSlug("Getting-Started")).toBe(false);
  });

  it("rejects leading, trailing or doubled hyphens", () => {
    expect(isValidArticleSlug("-hello")).toBe(false);
    expect(isValidArticleSlug("hello-")).toBe(false);
    expect(isValidArticleSlug("hel--lo")).toBe(false);
  });

  it("rejects non-alphanumeric symbols (dots, spaces, underscores)", () => {
    expect(isValidArticleSlug("hello.world")).toBe(false);
    expect(isValidArticleSlug("hello world")).toBe(false);
    expect(isValidArticleSlug("hello_world")).toBe(false);
  });
});
