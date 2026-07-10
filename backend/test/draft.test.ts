import { describe, expect, it } from "vitest";
import { buildDraftPrompt, buildKbQuery } from "../src/ai/draft";

describe("buildKbQuery", () => {
  it("uses only contact messages", () => {
    const q = buildKbQuery([
      { senderType: "CONTACT", bodyText: "how do I download my invoice" },
      { senderType: "AGENT", bodyText: "let me check the billing dashboard" },
      { senderType: "SYSTEM", bodyText: "Assigned to Kaushik" },
    ]);
    expect(q).toBe("how do I download my invoice");
  });

  it("takes the last 3 contact messages, newest first", () => {
    const q = buildKbQuery([
      { senderType: "CONTACT", bodyText: "one" },
      { senderType: "CONTACT", bodyText: "two" },
      { senderType: "CONTACT", bodyText: "three" },
      { senderType: "CONTACT", bodyText: "four" },
    ]);
    expect(q).toBe("four three two");
  });

  it("returns empty string when there are no contact messages", () => {
    expect(buildKbQuery([{ senderType: "AGENT", bodyText: "hello" }])).toBe("");
    expect(buildKbQuery([])).toBe("");
  });

  it("collapses whitespace and clips to the query budget", () => {
    const q = buildKbQuery([{ senderType: "CONTACT", bodyText: `a  b\n\nc ${"x".repeat(300)}` }]);
    expect(q.startsWith("a b c ")).toBe(true);
    expect(q.length).toBeLessThanOrEqual(200);
  });
});

describe("buildDraftPrompt", () => {
  it("numbers KB excerpts and includes the transcript with sender tags", () => {
    const prompt = buildDraftPrompt(
      [
        { senderType: "CONTACT", bodyText: "Where is my invoice?" },
        { senderType: "AGENT", bodyText: "Checking now." },
      ],
      [{ title: "Invoices", excerpt: "Go to Billing > Invoices." }],
    );
    expect(prompt).toContain("[1] Invoices\nGo to Billing > Invoices.");
    expect(prompt).toContain("[CONTACT] Where is my invoice?");
    expect(prompt).toContain("[AGENT] Checking now.");
    expect(prompt).toContain("Draft the agent's next reply");
  });

  it("tells the model not to invent facts when no articles matched", () => {
    const prompt = buildDraftPrompt([{ senderType: "CONTACT", bodyText: "hi" }], []);
    expect(prompt).toContain("(none found — do not invent facts)");
  });

  it("clips long messages to 500 chars in the transcript", () => {
    const prompt = buildDraftPrompt([{ senderType: "CONTACT", bodyText: "y".repeat(900) }], []);
    expect(prompt).toContain(`[CONTACT] ${"y".repeat(500)}`);
    expect(prompt).not.toContain("y".repeat(501));
  });
});
