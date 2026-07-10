import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware, requireAdmin } from "../middleware/auth";
import { ROLE } from "../common/const";
import { now, uuidv7 } from "../common/id";
import { SLUG_REGEX } from "../common/slug";
import type { HonoEnv } from "../common/hono-env";

// A workspace is identified by a single handle — it's the display name, the inbound-email prefix
// (<handle>@inbox.hyugorix.com) and the KB URL segment all at once. Validated to the slug format;
// globally unique (enforced below, no silent suffixing).
const CreateWorkspaceBody = z.object({
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(SLUG_REGEX, "Use lowercase letters, numbers, dots and hyphens; start with a letter, don't end with a dot or hyphen"),
});
// The workspace name is permanent once created — only presentational settings are editable here.
const PatchWorkspaceBody = z.object({
  widgetColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  slaFirstResponseMin: z.number().int().min(1).max(10_080).nullable().optional(),
  slaResolutionMin: z.number().int().min(1).max(10_080).nullable().optional(),
});

export const workspacesApi = new Hono<HonoEnv>();
workspacesApi.use("*", authMiddleware);

workspacesApi.post("/", validate(CreateWorkspaceBody, "json"), async (c) => {
  const { slug } = c.get("body") as z.infer<typeof CreateWorkspaceBody>;
  const userId = c.get("userId");
  // The handle is the workspace's identity and its display name; it's globally unique and permanent.
  if (await c.env.DB.prepare("SELECT 1 FROM workspaces WHERE slug=?1").bind(slug).first()) {
    throw ctxErr.workspace.slugTaken();
  }
  const workspaceId = uuidv7();
  const widgetKey = `wk_${uuidv7().replaceAll("-", "")}`;
  const ts = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO workspaces (id, name, slug, widget_key, widget_color, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(workspaceId, slug, slug, widgetKey, "#4f46e5", userId, ts),
    c.env.DB.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)",
    ).bind(workspaceId, userId, ROLE.ADMIN, ts),
  ]);
  return ok(c, {
    workspace: { id: workspaceId, name: slug, slug, widgetKey, widgetColor: "#4f46e5" },
  });
});

workspacesApi.get("/", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT w.id as id, w.name as name, w.slug as slug, w.widget_key as widgetKey,
            w.widget_color as widgetColor, w.sla_first_response_min as slaFirstResponseMin,
            w.sla_resolution_min as slaResolutionMin, m.role as role
     FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id=?1`,
  )
    .bind(userId)
    .all();
  return ok(c, { workspaces: results });
});

export const workspaceSettingsApi = new Hono<HonoEnv>();
workspaceSettingsApi.use("*", authMiddleware, wsMiddleware);

workspaceSettingsApi.patch("/", requireAdmin, validate(PatchWorkspaceBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const patch = c.get("body") as z.infer<typeof PatchWorkspaceBody>;
  const row = await c.env.DB.prepare("SELECT id FROM workspaces WHERE id=?1").bind(workspaceId).first();
  if (!row) throw ctxErr.workspace.notFound();

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.widgetColor !== undefined) {
    sets.push(`widget_color=?${sets.length + 1}`);
    binds.push(patch.widgetColor);
  }
  if (patch.slaFirstResponseMin !== undefined) {
    sets.push(`sla_first_response_min=?${sets.length + 1}`);
    binds.push(patch.slaFirstResponseMin);
  }
  if (patch.slaResolutionMin !== undefined) {
    sets.push(`sla_resolution_min=?${sets.length + 1}`);
    binds.push(patch.slaResolutionMin);
  }
  if (sets.length > 0) {
    binds.push(workspaceId);
    await c.env.DB.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id=?${sets.length + 1}`)
      .bind(...binds)
      .run();
  }
  const updated = await c.env.DB.prepare(
    `SELECT id, name, slug, widget_key as widgetKey, widget_color as widgetColor,
            sla_first_response_min as slaFirstResponseMin, sla_resolution_min as slaResolutionMin
     FROM workspaces WHERE id=?1`,
  )
    .bind(workspaceId)
    .first();
  return ok(c, { workspace: updated });
});
