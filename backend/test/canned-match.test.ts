import { describe, expect, it } from "vitest";
import { matchCanned } from "../../frontend/src/lib/canned";

const LIST = [
  { title: "Refund policy", tags: "billing,refund", body: "b1" },
  { title: "Password reset", tags: "auth", body: "b2" },
  { title: "Shipping times", tags: "orders", body: "b3" },
];

describe("matchCanned", () => {
  it("empty query returns everything up to the limit", () => {
    expect(matchCanned(LIST, "")).toHaveLength(3);
    expect(matchCanned(LIST, "", 2)).toHaveLength(2);
  });
  it("matches title and tags, case-insensitive", () => {
    expect(matchCanned(LIST, "REFUND").map((r) => r.title)).toEqual(["Refund policy"]);
    expect(matchCanned(LIST, "auth").map((r) => r.title)).toEqual(["Password reset"]);
    expect(matchCanned(LIST, "zzz")).toHaveLength(0);
  });
});
