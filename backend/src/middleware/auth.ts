import type { Context, Next } from "hono";
import { ctxErr } from "../ctx/ctx.error";
import { ROLE } from "../common/const";
import { verifyAccessToken } from "../auth/token";
import type { HonoEnv, Member } from "../common/hono-env";

export async function authMiddleware(c: Context<HonoEnv>, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) throw ctxErr.auth.invalidAccessToken();
  const jwt = header.slice("Bearer ".length);
  const { sub } = await verifyAccessToken(c.env, jwt);
  c.set("userId", sub);
  await next();
}

export async function wsMiddleware(c: Context<HonoEnv>, next: Next) {
  const userId = c.get("userId");
  const workspaceId = c.req.param("wsId");
  if (!workspaceId) throw ctxErr.workspace.notFound();
  const row = await c.env.DB.prepare(
    "SELECT role FROM workspace_members WHERE workspace_id=?1 AND user_id=?2",
  )
    .bind(workspaceId, userId)
    .first<{ role: string }>();
  if (!row) throw ctxErr.workspace.notMember();
  const member: Member = { role: row.role as Member["role"], workspaceId };
  c.set("member", member);
  await next();
}

export async function requireAdmin(c: Context<HonoEnv>, next: Next) {
  const member = c.get("member");
  if (member.role !== ROLE.ADMIN) throw ctxErr.workspace.adminRequired();
  await next();
}
