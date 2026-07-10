import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { CtxError, ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, requireAdmin, wsMiddleware } from "../middleware/auth";
import { getConfig } from "../config/env.config";
import { normalizeDocsUrl } from "./crawl";
import type { HonoEnv } from "../common/hono-env";

const SyncBody = z.object({ url: z.string().trim().min(4).max(500) });

const ROW_COLUMNS = `id, url, status, pages_found as pagesFound, pages_imported as pagesImported,
  pages_failed as pagesFailed, error, last_synced_at as lastSyncedAt, started_at as startedAt,
  created_at as createdAt`;

async function loadRow(db: D1Database, workspaceId: string) {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM kb_sync_sources WHERE workspace_id=?1`).bind(workspaceId).first();
}

export const kbSyncApi = new Hono<HonoEnv>();
kbSyncApi.use("*", authMiddleware, wsMiddleware);

kbSyncApi.get("/kb/sync", async (c) => {
  const { workspaceId } = c.get("member");
  const source = await loadRow(c.env.DB, workspaceId);
  return ok(c, { source: source ?? null, cooldownMin: getConfig(c.env).KB_SYNC_COOLDOWN_MIN });
});

kbSyncApi.post("/kb/sync", requireAdmin, validate(SyncBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const { url } = c.get("body") as z.infer<typeof SyncBody>;
  const source = normalizeDocsUrl(url);
  if (!source) throw ctxErr.kbSync.invalidUrl();

  const stub = c.env.KB_SYNC.get(c.env.KB_SYNC.idFromName(workspaceId));
  const res = await stub.fetch("https://do/start", {
    method: "POST",
    body: JSON.stringify({ workspaceId, userId, source }),
  });
  if (res.status === 409) {
    const { error } = (await res.json()) as { error: { name: string; msg: string } };
    throw new CtxError({ name: error.name, msg: error.msg });
  }
  if (!res.ok) throw new Error(`kb-sync /start failed: ${res.status}`);
  const row = await loadRow(c.env.DB, workspaceId);
  return ok(c, { source: row });
});
