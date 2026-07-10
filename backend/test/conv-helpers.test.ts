import { describe, expect, it } from "vitest";
import {
  decodeConversationCursor,
  encodeConversationCursor,
  isAssignedToOther,
  shouldReopen,
  truncatePreview,
} from "../src/conversations/service";

const ME = "agent-1";
const OTHER = "agent-2";

describe("truncatePreview", () => {
  it("leaves short text untouched", () => {
    expect(truncatePreview("hello")).toBe("hello");
  });

  it("truncates to 120 chars by default", () => {
    const long = "x".repeat(200);
    expect(truncatePreview(long)).toHaveLength(120);
  });

  it("respects a custom max", () => {
    expect(truncatePreview("hello world", 5)).toBe("hello");
  });
});

describe("shouldReopen", () => {
  it("reopens when a CONTACT messages a SNOOZED conversation", () => {
    expect(shouldReopen("CONTACT", "SNOOZED")).toBe(true);
  });

  it("reopens when a CONTACT messages a RESOLVED conversation", () => {
    expect(shouldReopen("CONTACT", "RESOLVED")).toBe(true);
  });

  it("does not reopen an already-OPEN conversation", () => {
    expect(shouldReopen("CONTACT", "OPEN")).toBe(false);
  });

  it("does not reopen for AGENT or SYSTEM senders", () => {
    expect(shouldReopen("AGENT", "SNOOZED")).toBe(false);
    expect(shouldReopen("SYSTEM", "RESOLVED")).toBe(false);
  });
});

describe("isAssignedToOther (composer lock)", () => {
  it("locks an OPEN conversation assigned to another agent", () => {
    expect(isAssignedToOther("OPEN", OTHER, ME)).toBe(true);
  });

  it("locks a SNOOZED conversation assigned to another agent", () => {
    expect(isAssignedToOther("SNOOZED", OTHER, ME)).toBe(true);
  });

  it("does NOT lock when unassigned (anyone can claim it)", () => {
    expect(isAssignedToOther("OPEN", null, ME)).toBe(false);
  });

  it("does NOT lock when the viewer is the assignee", () => {
    expect(isAssignedToOther("OPEN", ME, ME)).toBe(false);
  });

  it("does NOT lock a RESOLVED conversation even if still assigned (open to all)", () => {
    expect(isAssignedToOther("RESOLVED", OTHER, ME)).toBe(false);
  });
});

describe("conversation cursor encode/decode", () => {
  it("round-trips", () => {
    const cursor = encodeConversationCursor(1700000000000, "019f-abc");
    expect(decodeConversationCursor(cursor)).toEqual({ lastMessageAt: 1700000000000, id: "019f-abc" });
  });

  it("returns null for garbage input", () => {
    expect(decodeConversationCursor("not-base64-json!!")).toBeNull();
  });

  it("returns null for well-formed base64 that isn't the right shape", () => {
    const cursor = btoa(JSON.stringify({ not: "a tuple" }));
    expect(decodeConversationCursor(cursor)).toBeNull();
  });
});
