import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware } from "../middleware/auth";
import { getConversationSummary } from "./summary";
import { suggestReply } from "./draft";
import type { HonoEnv } from "../common/hono-env";

const SummaryQuery = z.object({ force: z.string().optional() });

export const aiApi = new Hono<HonoEnv>();
aiApi.use("*", authMiddleware, wsMiddleware);

aiApi.get("/conversations/:id/summary", validate(SummaryQuery, "query"), async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  const { force } = c.get("body") as z.infer<typeof SummaryQuery>;
  const result = await getConversationSummary(c.env, workspaceId, id, force === "1");
  return ok(c, result);
});

aiApi.post("/conversations/:id/suggest-reply", async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  const result = await suggestReply(c.env, workspaceId, id);
  return ok(c, result);
});
