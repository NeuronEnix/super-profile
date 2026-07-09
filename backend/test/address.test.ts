import { describe, expect, it } from "vitest";
import { parseInboundAddress } from "../src/email/inbound";

const DOMAIN = "inbox.hyugorix.com";

describe("parseInboundAddress", () => {
  it("parses a plain slug address", () => {
    expect(parseInboundAddress("acme@inbox.hyugorix.com", DOMAIN)).toEqual({
      wsSlug: "acme",
      conversationId: null,
    });
  });

  it("parses a plus-addressed conversation id", () => {
    expect(parseInboundAddress("acme+conv-123@inbox.hyugorix.com", DOMAIN)).toEqual({
      wsSlug: "acme",
      conversationId: "conv-123",
    });
  });

  it("is case-insensitive", () => {
    expect(parseInboundAddress("ACME@INBOX.HYUGORIX.COM", DOMAIN)).toEqual({
      wsSlug: "acme",
      conversationId: null,
    });
  });

  it("extracts the address out of a display-name header value", () => {
    expect(parseInboundAddress("Acme Support <acme@inbox.hyugorix.com>", DOMAIN)).toEqual({
      wsSlug: "acme",
      conversationId: null,
    });
  });

  it("ignores addresses on other domains", () => {
    expect(parseInboundAddress("acme@example.com", DOMAIN)).toBeNull();
  });

  it("returns null for malformed input with no @", () => {
    expect(parseInboundAddress("not-an-email", DOMAIN)).toBeNull();
  });
});
