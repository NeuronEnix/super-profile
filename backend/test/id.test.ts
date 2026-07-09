import { describe, expect, it } from "vitest";
import { uuidv7 } from "../src/common/id";

describe("uuidv7", () => {
  it("matches the UUID v7 format (version+variant nibbles set)", () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("generates 1000 unique ids whose lexicographic sort is timestamp-monotonic", () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(1000);
    const timestampOf = (id: string) => parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    const sorted = [...ids].sort();
    const timestamps = sorted.map(timestampOf);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
  });
});
