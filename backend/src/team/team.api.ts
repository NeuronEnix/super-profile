import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware, requireAdmin } from "../middleware/auth";
import { ROLE, AUTH } from "../common/const";
import { now, uuidv7 } from "../common/id";
import { generateRawToken, hashToken } from "../auth/magic";
import { escapeHtml } from "../common/html";
import { getSender } from "../email/sender";
import { getConfig } from "../config/env.config";
import type { HonoEnv } from "../common/hono-env";

const InviteBody = z.object({ email: z.string().email(), role: z.enum([ROLE.ADMIN, ROLE.AGENT]) });
const PatchMemberBody = z.object({ role: z.enum([ROLE.ADMIN, ROLE.AGENT]) });

async function assertNotLastAdmin(db: D1Database, workspaceId: string, userId: string, msg: string) {
  const target = await db
    .prepare("SELECT role FROM workspace_members WHERE workspace_id=?1 AND user_id=?2")
    .bind(workspaceId, userId)
    .first<{ role: string }>();
  if (target?.role !== ROLE.ADMIN) return;
  const { count } = (await db
    .prepare("SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id=?1 AND role=?2")
    .bind(workspaceId, ROLE.ADMIN)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count <= 1) throw ctxErr.auth.notAuthorized({ msg });
}

export const teamApi = new Hono<HonoEnv>();
teamApi.use("*", authMiddleware, wsMiddleware);

teamApi.post("/invites", requireAdmin, validate(InviteBody, "json"), async (c) => {
  const { email, role } = c.get("body") as z.infer<typeof InviteBody>;
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const config = getConfig(c.env);

  const existingMember = await c.env.DB.prepare(
    `SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id=?1 AND u.email=?2`,
  )
    .bind(workspaceId, email)
    .first();
  if (existingMember) throw ctxErr.invite.alreadyMember();

  const raw = generateRawToken();
  const tokenHash = await hashToken(raw);
  const ts = now();
  const inviteId = uuidv7();
  await c.env.DB.prepare(
    "INSERT INTO invites (id, workspace_id, email, role, token_hash, expires_at, accepted_at, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)",
  )
    .bind(inviteId, workspaceId, email, role, tokenHash, ts + AUTH.INVITE_TTL_SEC * 1000, userId, ts)
    .run();

  // Authenticated test callers get the token echoed and NO email sent (same rationale as
  // /auth/magic-link — don't burn Resend quota / bounce mail at fake test addresses).
  const debugHeader = c.req.header("X-Debug-Auth");
  if (debugHeader && debugHeader === c.env.DEBUG_AUTH_SECRET) {
    return ok(c, {
      invite: { id: inviteId, email, role, expiresAt: ts + AUTH.INVITE_TTL_SEC * 1000 },
      debugToken: raw,
    });
  }

  const workspace = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id=?1").bind(workspaceId).first<{ name: string }>();
  const wsName = workspace?.name ?? "a workspace";
  const link = `${config.APP_URL}/invite?token=${raw}`;
  await getSender(c.env).send({
    from: `Hyugorix <no-reply@${config.SEND_DOMAIN}>`,
    to: email,
    subject: `You've been invited to join ${wsName} on Hyugorix`,
    text: `You've been invited to join ${wsName} on Hyugorix as ${role}.\n\n${link}\n\nThis invite expires in 7 days.`,
    html: `<p>You've been invited to join <strong>${escapeHtml(wsName)}</strong> on Hyugorix as ${role}.</p><p><a href="${link}">${link}</a></p><p>This invite expires in 7 days.</p>`,
  });

  return ok(c, { invite: { id: inviteId, email, role, expiresAt: ts + AUTH.INVITE_TTL_SEC * 1000 } });
});

teamApi.get("/invites", requireAdmin, async (c) => {
  const { workspaceId } = c.get("member");
  const { results } = await c.env.DB.prepare(
    "SELECT id, email, role, expires_at as expiresAt, accepted_at as acceptedAt, created_at as createdAt FROM invites WHERE workspace_id=?1 ORDER BY created_at DESC",
  )
    .bind(workspaceId)
    .all();
  return ok(c, { invites: results });
});

teamApi.delete("/invites/:id", requireAdmin, async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("DELETE FROM invites WHERE id=?1 AND workspace_id=?2").bind(id, workspaceId).run();
  if (res.meta.changes !== 1) throw ctxErr.invite.notFound();
  return ok(c);
});

teamApi.get("/members", async (c) => {
  const { workspaceId } = c.get("member");
  const { results } = await c.env.DB.prepare(
    `SELECT u.id as userId, u.name as name, u.email as email, m.role as role
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id=?1 ORDER BY m.created_at ASC`,
  )
    .bind(workspaceId)
    .all();
  return ok(c, { members: results });
});

teamApi.patch("/members/:userId", requireAdmin, validate(PatchMemberBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const targetUserId = c.req.param("userId");
  if (!targetUserId) throw ctxErr.user.notFound();
  const { role } = c.get("body") as z.infer<typeof PatchMemberBody>;
  if (role !== ROLE.ADMIN) {
    await assertNotLastAdmin(c.env.DB, workspaceId, targetUserId, "Workspace needs at least one admin");
  }
  const res = await c.env.DB.prepare(
    "UPDATE workspace_members SET role=?1 WHERE workspace_id=?2 AND user_id=?3",
  )
    .bind(role, workspaceId, targetUserId)
    .run();
  if (res.meta.changes !== 1) throw ctxErr.user.notFound();
  return ok(c);
});

teamApi.delete("/members/:userId", requireAdmin, async (c) => {
  const { workspaceId } = c.get("member");
  const targetUserId = c.req.param("userId");
  if (!targetUserId) throw ctxErr.user.notFound();
  await assertNotLastAdmin(c.env.DB, workspaceId, targetUserId, "Workspace needs at least one admin");
  const res = await c.env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=?1 AND user_id=?2")
    .bind(workspaceId, targetUserId)
    .run();
  if (res.meta.changes !== 1) throw ctxErr.user.notFound();
  return ok(c);
});
