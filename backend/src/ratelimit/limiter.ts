import type { Env } from "../types";

/**
 * Pure sliding-window check: drop timestamps older than the window, then decide whether
 * one more request fits under `limit`. Exported so the window math is unit-testable with
 * injected timestamps instead of real wall-clock time.
 */
export function slideWindow(
  times: number[],
  nowMs: number,
  windowMs: number,
  limit: number,
): { allowed: boolean; times: number[] } {
  const cutoff = nowMs - windowMs;
  const pruned = times.filter((t) => t > cutoff);
  if (pruned.length >= limit) {
    return { allowed: false, times: pruned };
  }
  pruned.push(nowMs);
  return { allowed: true, times: pruned };
}

type CheckBody = { key: string; limit: number; windowSec: number };

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/check" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const { key, limit, windowSec } = await request.json<CheckBody>();
    const result = slideWindow(this.hits.get(key) ?? [], Date.now(), windowSec * 1000, limit);
    this.hits.set(key, result.times);
    return Response.json({ allowed: result.allowed });
  }
}
