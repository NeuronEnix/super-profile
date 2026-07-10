import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware } from "../middleware/auth";
import { now, uuidv7 } from "../common/id";
import type { HonoEnv } from "../common/hono-env";

const CannedBody = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(5000),
  tags: z.string().trim().max(200).optional(),
});
const CannedPatchBody = CannedBody.partial();

const COLUMNS = "id, title, body, tags, created_at as createdAt";

export const cannedApi = new Hono<HonoEnv>();
cannedApi.use("*", authMiddleware, wsMiddleware);

cannedApi.get("/canned", async (c) => {
  const { workspaceId } = c.get("member");
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM canned_responses WHERE workspace_id=?1 ORDER BY title COLLATE NOCASE`,
  )
    .bind(workspaceId)
    .all();
  return ok(c, { canned: results });
});

cannedApi.post("/canned", validate(CannedBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const { title, body, tags } = c.get("body") as z.infer<typeof CannedBody>;
  const id = uuidv7();
  await c.env.DB.prepare(
    "INSERT INTO canned_responses (id, workspace_id, title, body, tags, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, workspaceId, title, body, tags ?? "", userId, now())
    .run();
  return ok(c, { canned: { id, title, body, tags: tags ?? "", createdAt: now() } });
});

cannedApi.patch("/canned/:id", validate(CannedPatchBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const patch = c.get("body") as z.infer<typeof CannedPatchBody>;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) {
    binds.push(patch.title);
    sets.push(`title=?${binds.length}`);
  }
  if (patch.body !== undefined) {
    binds.push(patch.body);
    sets.push(`body=?${binds.length}`);
  }
  if (patch.tags !== undefined) {
    binds.push(patch.tags);
    sets.push(`tags=?${binds.length}`);
  }
  if (sets.length === 0) return ok(c);
  binds.push(id, workspaceId);
  const res = await c.env.DB.prepare(
    `UPDATE canned_responses SET ${sets.join(", ")} WHERE id=?${binds.length - 1} AND workspace_id=?${binds.length}`,
  )
    .bind(...binds)
    .run();
  if (res.meta.changes !== 1) throw ctxErr.canned.notFound();
  return ok(c);
});

cannedApi.delete("/canned/:id", async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("DELETE FROM canned_responses WHERE id=?1 AND workspace_id=?2")
    .bind(id, workspaceId)
    .run();
  if (res.meta.changes !== 1) throw ctxErr.canned.notFound();
  return ok(c);
});
