import { describe, expect, it } from "vitest";
import { computeAnalytics, median } from "../src/analytics/compute";

const MIN = 60_000;
const NOW = 20 * 24 * 3600 * 1000; // fixed "now"

function conv(over: Partial<Parameters<typeof computeAnalytics>[0][0]> = {}) {
  return {
    createdAt: NOW - 3 * 24 * 3600 * 1000, firstAgentReplyAt: null, resolvedAt: null,
    status: "OPEN", channel: "CHAT", assigneeId: null, aiMsgs: 0, agentMsgs: 0, ...over,
  };
}

describe("median", () => {
  it("handles empty, odd, even", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 9, 5])).toBe(5);
    expect(median([1, 3, 5, 9])).toBe(4);
  });
});

describe("computeAnalytics", () => {
  it("computes rates, medians, ai deflection and fills day/hour bins", () => {
    const convs = [
      conv({ status: "RESOLVED", firstAgentReplyAt: NOW - 3 * 24 * 3600 * 1000 + 4 * MIN, resolvedAt: NOW - 3 * 24 * 3600 * 1000 + 30 * MIN, agentMsgs: 2 }),
      conv({ status: "RESOLVED", aiMsgs: 3, agentMsgs: 0, resolvedAt: NOW - 2 * 24 * 3600 * 1000, channel: "EMAIL" }),
      conv({ aiMsgs: 1, agentMsgs: 1 }),
    ];
    const a = computeAnalytics(convs, [{ day: "1970-01-17", count: 4 }], [{ hour: 9, count: 7 }], [], 14, NOW);
    expect(a.totals.conversations).toBe(3);
    expect(a.totals.resolved).toBe(2);
    expect(a.totals.resolutionRate).toBeCloseTo(2 / 3);
    expect(a.firstResponse.medianMin).toBe(4);
    expect(a.resolution.medianMin).toBe(30);
    expect(a.channels).toEqual({ chat: 2, email: 1 });
    expect(a.ai.conversations).toBe(2);
    expect(a.ai.resolvedAlone).toBe(1);
    expect(a.ai.deflectionRate).toBeCloseTo(0.5);
    expect(a.volumeByDay).toHaveLength(14);
    expect(a.busiestHours).toHaveLength(24);
    expect(a.busiestHours[9].count).toBe(7);
    expect(a.volumeByDay.find((d) => d.day === "1970-01-17")?.count).toBe(4);
  });
  it("empty data is all nulls and zeros, never NaN", () => {
    const a = computeAnalytics([], [], [], [], 7, NOW);
    expect(a.totals.resolutionRate).toBeNull();
    expect(a.firstResponse.medianMin).toBeNull();
    expect(a.ai.deflectionRate).toBeNull();
    expect(a.volumeByDay).toHaveLength(7);
  });
});
