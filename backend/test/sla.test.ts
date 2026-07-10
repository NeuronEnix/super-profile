import { describe, expect, it } from "vitest";
import { computeSla } from "../../frontend/src/lib/sla";

const T0 = 1_000_000;
const MIN = 60_000;
const TARGETS = { firstResponseMin: 5, resolutionMin: 60 };

function conv(overrides: Partial<{ createdAt: number; firstAgentReplyAt: number | null; resolvedAt: number | null; status: string }> = {}) {
  return { createdAt: T0, firstAgentReplyAt: null, resolvedAt: null, status: "OPEN", ...overrides };
}

describe("computeSla", () => {
  it("null targets → null metrics", () => {
    const r = computeSla(conv(), { firstResponseMin: null, resolutionMin: null }, T0);
    expect(r.firstResponse).toBeNull();
    expect(r.resolution).toBeNull();
  });
  it("pending before the deadline, breached after", () => {
    expect(computeSla(conv(), TARGETS, T0 + 4 * MIN).firstResponse!.state).toBe("PENDING");
    expect(computeSla(conv(), TARGETS, T0 + 6 * MIN).firstResponse!.state).toBe("BREACHED");
  });
  it("met on time vs met late", () => {
    const onTime = computeSla(conv({ firstAgentReplyAt: T0 + 3 * MIN }), TARGETS, T0 + 99 * MIN);
    expect(onTime.firstResponse).toMatchObject({ state: "MET", tookMin: 3 });
    const late = computeSla(conv({ firstAgentReplyAt: T0 + 9 * MIN }), TARGETS, T0 + 99 * MIN);
    expect(late.firstResponse!.state).toBe("BREACHED");
    expect(late.firstResponse!.tookMin).toBe(9);
  });
  it("resolution uses resolvedAt only when RESOLVED", () => {
    const open = computeSla(conv({ resolvedAt: T0 + 10 * MIN }), TARGETS, T0 + 30 * MIN);
    expect(open.resolution!.state).toBe("PENDING"); // stale resolvedAt from a reopen is ignored
    const resolved = computeSla(conv({ status: "RESOLVED", resolvedAt: T0 + 30 * MIN }), TARGETS, T0 + 99 * MIN);
    expect(resolved.resolution).toMatchObject({ state: "MET", tookMin: 30 });
  });
});
