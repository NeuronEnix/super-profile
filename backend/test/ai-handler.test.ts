import { describe, expect, it } from "vitest";
import { buildHandlerPrompt, isEscalateResponse, wantsHuman } from "../src/ai/handler";

describe("wantsHuman", () => {
  it("matches explicit requests for a human", () => {
    expect(wantsHuman("escalate to human")).toBe(true);
    expect(wantsHuman("Escalate to a human please")).toBe(true);
    expect(wantsHuman("I want to talk to a human")).toBe(true);
    expect(wantsHuman("can I speak with an agent?")).toBe(true);
    expect(wantsHuman("give me a real person")).toBe(true);
    expect(wantsHuman("you're not a bot are you")).toBe(true);
  });

  it("does not match ordinary support text", () => {
    expect(wantsHuman("my refund is late")).toBe(false);
    expect(wantsHuman("the human resources page is broken")).toBe(false);
    expect(wantsHuman("how do I escalate a ticket in your product?")).toBe(false);
  });
});

describe("isEscalateResponse", () => {
  it("matches the bare token and light variations", () => {
    expect(isEscalateResponse("ESCALATE")).toBe(true);
    expect(isEscalateResponse("  escalate.  ")).toBe(true);
    expect(isEscalateResponse("Escalate — I can't help")).toBe(true);
  });

  it("does not match a normal reply that mentions escalation", () => {
    expect(isEscalateResponse("You can escalate from the billing page.")).toBe(false);
    expect(isEscalateResponse("Sure, here's how it works")).toBe(false);
  });
});

describe("buildHandlerPrompt", () => {
  it("includes article URLs and relabels senders", () => {
    const prompt = buildHandlerPrompt(
      [
        { senderType: "CONTACT", bodyText: "Where is my invoice?" },
        { senderType: "AI", bodyText: "Check the billing page." },
        { senderType: "AGENT", bodyText: "Delegating now." },
      ],
      [{ title: "Invoices", url: "https://sp.example/kb/acme/a/invoices", excerpt: "Billing > Invoices." }],
    );
    expect(prompt).toContain("URL: https://sp.example/kb/acme/a/invoices");
    expect(prompt).toContain("[CUSTOMER] Where is my invoice?");
    expect(prompt).toContain("[YOU] Check the billing page.");
    expect(prompt).toContain("[AGENT] Delegating now.");
  });

  it("marks the KB as empty rather than omitting the section", () => {
    expect(buildHandlerPrompt([], [])).toContain("(none available)");
  });
});
