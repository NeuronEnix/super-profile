import { describe, expect, it } from "vitest";
import { slideWindow } from "../src/ratelimit/limiter";

describe("slideWindow", () => {
  it("allows requests under the limit and appends the new timestamp", () => {
    const result = slideWindow([1000, 2000], 3000, 10_000, 5);
    expect(result.allowed).toBe(true);
    expect(result.times).toEqual([1000, 2000, 3000]);
  });

  it("rejects once the limit is reached within the window", () => {
    const result = slideWindow([1000, 2000, 3000], 3500, 10_000, 3);
    expect(result.allowed).toBe(false);
    expect(result.times).toEqual([1000, 2000, 3000]);
  });

  it("prunes timestamps that have fallen outside the window before counting", () => {
    // window is 1000ms; only the 9500 timestamp is still within (now - window, now]
    const result = slideWindow([1000, 2000, 9500], 10_000, 1000, 2);
    expect(result.allowed).toBe(true);
    expect(result.times).toEqual([9500, 10_000]);
  });

  it("rejects when pruning still leaves the window at capacity", () => {
    // cutoff = 10000 - 1000 = 9000; only 9000 itself is pruned (not > cutoff), leaving 2 at capacity
    const result = slideWindow([9000, 9500, 9900], 10_000, 1000, 2);
    expect(result.allowed).toBe(false);
    expect(result.times).toEqual([9500, 9900]);
  });

  it("treats a timestamp exactly at the cutoff boundary as expired", () => {
    // cutoff = now - windowMs = 9000; a timestamp AT 9000 is not > cutoff, so it's pruned
    const result = slideWindow([9000], 10_000, 1000, 1);
    expect(result.allowed).toBe(true);
    expect(result.times).toEqual([10_000]);
  });
});
