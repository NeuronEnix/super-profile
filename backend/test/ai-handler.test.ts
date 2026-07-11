import { describe, expect, it } from "vitest";
import { buildHandlerPrompt, isEscalateResponse, parseResolveResponse, wantsHuman } from "../src/ai/handler";

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

describe("parseResolveResponse", () => {
  it("parses the token with a goodbye", () => {
    expect(parseResolveResponse("RESOLVE: You're all set, have a great day!")).toEqual({
      resolve: true,
      farewell: "You're all set, have a great day!",
    });
    expect(parseResolveResponse("resolve — glad that worked, closing this now.")).toEqual({
      resolve: true,
      farewell: "glad that worked, closing this now.",
    });
  });

  it("bare token falls back to a default farewell", () => {
    const r = parseResolveResponse("  RESOLVE  ");
    expect(r.resolve).toBe(true);
    expect(r.farewell.length).toBeGreaterThan(10);
  });

  it("empty goodbye after the separator also falls back", () => {
    expect(parseResolveResponse("RESOLVE:").farewell.length).toBeGreaterThan(10);
  });

  it("never matches normal replies that merely start with the word", () => {
    expect(parseResolveResponse("Resolve this by going to Settings > Billing.").resolve).toBe(false);
    expect(parseResolveResponse("Resolved your issue — check the billing page.").resolve).toBe(false);
    expect(parseResolveResponse("You can resolve it from the dashboard.").resolve).toBe(false);
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

  it("offers both control tokens in the closing instruction", () => {
    const prompt = buildHandlerPrompt([], []);
    expect(prompt).toContain("ESCALATE");
    expect(prompt).toContain("RESOLVE:");
  });
});
