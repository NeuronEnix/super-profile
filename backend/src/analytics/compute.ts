export type AnalyticsConv = {
  createdAt: number;
  firstAgentReplyAt: number | null;
  resolvedAt: number | null;
  status: string;
  channel: string;
  assigneeId: string | null;
  aiMsgs: number;
  agentMsgs: number;
};
export type DayCount = { day: string; count: number };
export type HourCount = { hour: number; count: number };
export type AgentReplyRow = { userId: string; name: string; replies: number };

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function toMin(ms: number): number {
  return Math.round(ms / 60_000);
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function computeAnalytics(
  convs: AnalyticsConv[],
  msgByDay: DayCount[],
  msgByHour: HourCount[],
  agentReplies: AgentReplyRow[],
  days: number,
  nowMs: number,
) {
  const resolved = convs.filter((c) => c.status === "RESOLVED");
  const frTimes = convs
    .filter((c) => c.firstAgentReplyAt != null)
    .map((c) => toMin((c.firstAgentReplyAt as number) - c.createdAt));
  // Resolution median only covers conversations a human agent actually engaged with —
  // conversations the AI resolved alone are reported separately via ai.deflectionRate.
  const resTimes = resolved
    .filter((c) => c.resolvedAt != null && c.firstAgentReplyAt != null)
    .map((c) => toMin((c.resolvedAt as number) - c.createdAt));
  const aiConvs = convs.filter((c) => c.aiMsgs > 0);
  const resolvedAlone = aiConvs.filter((c) => c.status === "RESOLVED" && c.agentMsgs === 0);

  const dayMap = new Map(msgByDay.map((d) => [d.day, d.count]));
  const volumeByDay = Array.from({ length: days }, (_, i) => {
    const day = dayKey(nowMs - (days - 1 - i) * 24 * 3600 * 1000);
    return { day, count: dayMap.get(day) ?? 0 };
  });
  const hourMap = new Map(msgByHour.map((h) => [h.hour, h.count]));
  const busiestHours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: hourMap.get(hour) ?? 0 }));

  const byAssignee = new Map<string, { assigned: number; resolved: number }>();
  for (const c of convs) {
    if (!c.assigneeId) continue;
    const cur = byAssignee.get(c.assigneeId) ?? { assigned: 0, resolved: 0 };
    cur.assigned += 1;
    if (c.status === "RESOLVED") cur.resolved += 1;
    byAssignee.set(c.assigneeId, cur);
  }
  const agents = agentReplies.map((a) => ({
    ...a,
    assigned: byAssignee.get(a.userId)?.assigned ?? 0,
    resolved: byAssignee.get(a.userId)?.resolved ?? 0,
  }));

  return {
    days,
    totals: {
      conversations: convs.length,
      open: convs.filter((c) => c.status === "OPEN").length,
      resolved: resolved.length,
      resolutionRate: convs.length ? resolved.length / convs.length : null,
    },
    firstResponse: {
      medianMin: median(frTimes),
      avgMin: frTimes.length ? Math.round(frTimes.reduce((a, b) => a + b, 0) / frTimes.length) : null,
    },
    resolution: { medianMin: median(resTimes) },
    channels: {
      chat: convs.filter((c) => c.channel === "CHAT").length,
      email: convs.filter((c) => c.channel === "EMAIL").length,
    },
    ai: {
      conversations: aiConvs.length,
      resolvedAlone: resolvedAlone.length,
      deflectionRate: aiConvs.length ? resolvedAlone.length / aiConvs.length : null,
    },
    volumeByDay,
    busiestHours,
    agents,
  };
}
