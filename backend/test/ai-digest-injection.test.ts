import { describe, expect, it } from "vitest";
import { buildHandlerPrompt } from "../src/ai/handler";
import { buildDraftPrompt } from "../src/ai/draft";

const MSGS = [{ senderType: "CONTACT", bodyText: "how do I install?" }];

describe("digest injection", () => {
  it("handler prompt prepends the documentation map when present, omits when absent", () => {
    const withDigest = buildHandlerPrompt(MSGS, [], "### Docs\n- [Install](https://x/a/install)");
    expect(withDigest.startsWith("Documentation map (everything available):")).toBe(true);
    expect(withDigest).toContain("- [Install](https://x/a/install)");
    const without = buildHandlerPrompt(MSGS, []);
    expect(without.startsWith("Knowledge base articles")).toBe(true);
  });
  it("draft prompt does the same", () => {
    const withDigest = buildDraftPrompt(MSGS, [], "### Docs\n- [Install](https://x/a/install)");
    expect(withDigest).toContain("Documentation map");
    expect(buildDraftPrompt(MSGS, [])).not.toContain("Documentation map");
  });
});
