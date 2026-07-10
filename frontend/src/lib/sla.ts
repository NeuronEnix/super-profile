export type SlaTargets = { firstResponseMin: number | null; resolutionMin: number | null };
export type SlaState = { state: "MET" | "PENDING" | "BREACHED"; dueAt: number; tookMin?: number };
type SlaConv = { createdAt: number; firstAgentReplyAt: number | null; resolvedAt: number | null; status: string };

function evalMetric(startAt: number, targetMin: number, metAt: number | null, nowMs: number): SlaState {
  const dueAt = startAt + targetMin * 60_000;
  if (metAt != null) {
    return { state: metAt <= dueAt ? "MET" : "BREACHED", dueAt, tookMin: Math.max(0, Math.round((metAt - startAt) / 60_000)) };
  }
  return { state: nowMs > dueAt ? "BREACHED" : "PENDING", dueAt };
}

/** Breach is computed on read from the stamped timestamps — no cron anywhere. */
export function computeSla(conv: SlaConv, targets: SlaTargets, nowMs: number) {
  return {
    firstResponse:
      targets.firstResponseMin == null ? null : evalMetric(conv.createdAt, targets.firstResponseMin, conv.firstAgentReplyAt, nowMs),
    resolution:
      targets.resolutionMin == null
        ? null
        : evalMetric(conv.createdAt, targets.resolutionMin, conv.status === "RESOLVED" ? conv.resolvedAt : null, nowMs),
  };
}
