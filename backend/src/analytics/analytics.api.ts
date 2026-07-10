import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware } from "../middleware/auth";
import { now } from "../common/id";
import { computeAnalytics, type AgentReplyRow, type AnalyticsConv, type DayCount, type HourCount } from "./compute";
import type { HonoEnv } from "../common/hono-env";

const Query = z.object({ days: z.coerce.number().int().min(1).max(90).optional() });

export const analyticsApi = new Hono<HonoEnv>();
analyticsApi.use("*", authMiddleware, wsMiddleware);

analyticsApi.get("/analytics", validate(Query, "query"), async (c) => {
  const { workspaceId } = c.get("member");
  const { days = 14 } = c.get("body") as z.infer<typeof Query>;
  const nowMs = now();
  const since = nowMs - days * 24 * 3600 * 1000;

  const [convRes, dayRes, hourRes, agentRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT c.created_at as createdAt, c.first_agent_reply_at as firstAgentReplyAt,
              c.resolved_at as resolvedAt, c.status as status, c.channel as channel,
              c.assignee_id as assigneeId,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='AI') as aiMsgs,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_type='AGENT') as agentMsgs
       FROM conversations c WHERE c.workspace_id=?1 AND c.created_at>=?2 LIMIT 2000`,
    )
      .bind(workspaceId, since)
      .all<AnalyticsConv>(),
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') as day, COUNT(*) as count
       FROM messages WHERE workspace_id=?1 AND created_at>=?2 GROUP BY day`,
    )
      .bind(workspaceId, since)
      .all<DayCount>(),
    c.env.DB.prepare(
      `SELECT CAST(strftime('%H', created_at/1000, 'unixepoch') AS INTEGER) as hour, COUNT(*) as count
       FROM messages WHERE workspace_id=?1 AND created_at>=?2 GROUP BY hour`,
    )
      .bind(workspaceId, since)
      .all<HourCount>(),
    c.env.DB.prepare(
      `SELECT u.id as userId, COALESCE(u.name, u.email, 'Agent') as name, COUNT(m.id) as replies
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.workspace_id=?1 AND m.sender_type='AGENT' AND m.created_at>=?2
       GROUP BY u.id ORDER BY replies DESC LIMIT 20`,
    )
      .bind(workspaceId, since)
      .all<AgentReplyRow>(),
  ]);

  const analytics = computeAnalytics(convRes.results, dayRes.results, hourRes.results, agentRes.results, days, nowMs);
  return ok(c, { analytics });
});
