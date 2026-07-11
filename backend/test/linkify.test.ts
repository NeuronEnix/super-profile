import { describe, expect, it } from "vitest";
import { splitLinkified } from "../../frontend/src/lib/linkifyCore";

const links = (text: string) => splitLinkified(text).filter((p) => p.link).map((p) => p.value);

describe("splitLinkified", () => {
  it("strips trailing sentence punctuation from URLs (the AI writes URLs mid-sentence)", () => {
    expect(links("See https://docs.kaushikrb.com/a/cloudflare-workers-vite. Is there anything else?")).toEqual([
      "https://docs.kaushikrb.com/a/cloudflare-workers-vite",
    ]);
    expect(links("at https://x.com/a, then https://y.com/b.")).toEqual(["https://x.com/a", "https://y.com/b"]);
    expect(links("really? https://x.com/a?b=1!")).toEqual(["https://x.com/a?b=1"]);
  });

  it("keeps the punctuation as visible text", () => {
    const parts = splitLinkified("Read https://x.com/a.");
    expect(parts).toEqual([
      { link: false, value: "Read " },
      { link: true, value: "https://x.com/a" },
      { link: false, value: "." },
    ]);
  });

  it("closing parens: stripped when they wrap the URL, kept when part of it", () => {
    expect(links("(see https://x.com/a)")).toEqual(["https://x.com/a"]);
    expect(links("wiki https://x.com/Foo_(bar) rocks")).toEqual(["https://x.com/Foo_(bar)"]);
    expect(links("(wiki https://x.com/Foo_(bar))")).toEqual(["https://x.com/Foo_(bar)"]);
  });

  it("leaves plain text and non-http schemes untouched", () => {
    expect(splitLinkified("no links here.")).toEqual([{ link: false, value: "no links here." }]);
    expect(links("mailto:x@y.z is not linkified")).toEqual([]);
  });
});
