import { describe, expect, it, vi } from "vitest";
import { resolveThreadConversationId, stripSubjectPrefix } from "../src/email/inbound";

describe("stripSubjectPrefix", () => {
  it("strips a single Re: prefix", () => {
    expect(stripSubjectPrefix("Re: Order question")).toBe("Order question");
  });

  it("strips repeated Re: Fwd: chains", () => {
    expect(stripSubjectPrefix("Re: Fwd: Re: Order question")).toBe("Order question");
  });

  it("leaves a bare subject untouched", () => {
    expect(stripSubjectPrefix("Order question")).toBe("Order question");
  });

  it("is case-insensitive and tolerates extra spacing", () => {
    expect(stripSubjectPrefix("  RE:   Order question")).toBe("Order question");
  });
});

describe("resolveThreadConversationId", () => {
  it("prefers a valid plus-address conversation id over headers", () => {
    const validate = vi.fn().mockResolvedValue(true);
    const find = vi.fn();
    return resolveThreadConversationId(
      { conversationId: "conv-1", inReplyTo: "<m-2@x>", references: [] },
      { validateConversationInWorkspace: validate, findConversationByMessageIds: find },
    ).then((result) => {
      expect(result).toBe("conv-1");
      expect(find).not.toHaveBeenCalled();
    });
  });

  it("falls back to In-Reply-To header match when the plus-address is invalid", async () => {
    const validate = vi.fn().mockResolvedValue(false);
    const find = vi.fn().mockResolvedValue("conv-from-header");
    const result = await resolveThreadConversationId(
      { conversationId: "conv-stale", inReplyTo: "<m-2@x>", references: [] },
      { validateConversationInWorkspace: validate, findConversationByMessageIds: find },
    );
    expect(result).toBe("conv-from-header");
    expect(find).toHaveBeenCalledWith(["<m-2@x>"]);
  });

  it("falls back through References when In-Reply-To alone doesn't match", async () => {
    const find = vi.fn().mockResolvedValue("conv-2");
    const result = await resolveThreadConversationId(
      { conversationId: null, inReplyTo: "<m-1@x>", references: ["<m-0@x>", "<m-1@x>"] },
      { validateConversationInWorkspace: vi.fn(), findConversationByMessageIds: find },
    );
    expect(result).toBe("conv-2");
    expect(find).toHaveBeenCalledWith(["<m-1@x>", "<m-0@x>", "<m-1@x>"]);
  });

  it("returns null when nothing matches (new conversation)", async () => {
    const result = await resolveThreadConversationId(
      { conversationId: null, inReplyTo: null, references: [] },
      { validateConversationInWorkspace: vi.fn(), findConversationByMessageIds: vi.fn() },
    );
    expect(result).toBeNull();
  });
});
