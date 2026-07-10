import { describe, expect, it } from "vitest";
import { isValidSlug } from "../src/common/slug";

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
