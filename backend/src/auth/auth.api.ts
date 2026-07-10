import { Hono, type Context } from "hono";
import { z } from "zod";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { AUTH, RATE_LIMIT } from "../common/const";
import { now, uuidv7 } from "../common/id";
import { generateRawToken, hashToken, consumeToken } from "./magic";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./token";
import { getSender } from "../email/sender";
import { getConfig } from "../config/env.config";
import { upsertUserByEmail, type UserRow } from "../users/users.service";
import type { HonoEnv } from "../common/hono-env";

const MagicLinkBody = z.object({ email: z.string().email() });
const VerifyBody = z.object({ token: z.string().min(1) });
const UpdateMeBody = z.object({ name: z.string().trim().min(1).max(80) });

function refreshCookieOpts() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "Strict" as const,
    path: AUTH.REFRESH_COOKIE_PATH,
    maxAge: AUTH.REFRESH_TOKEN_TTL_SEC,
  };
}

export const authApi = new Hono<HonoEnv>();

const magicLinkEmailKey = (c: Context<HonoEnv>) => `ml:email:${(c.get("body") as z.infer<typeof MagicLinkBody>).email}`;
const magicLinkIpKey = (c: Context<HonoEnv>) => `ml:ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`;

authApi.post(
  "/magic-link",
  validate(MagicLinkBody, "json"),
  rateLimit(magicLinkEmailKey, RATE_LIMIT.MAGIC_LINK.PER_EMAIL, RATE_LIMIT.MAGIC_LINK.WINDOW_SEC),
  rateLimit(magicLinkIpKey, RATE_LIMIT.MAGIC_LINK.PER_IP, RATE_LIMIT.MAGIC_LINK.WINDOW_SEC),
  async (c) => {
    const { email } = c.get("body") as z.infer<typeof MagicLinkBody>;
    const config = getConfig(c.env);
    const raw = generateRawToken();
    const tokenHash = await hashToken(raw);
    const ts = now();
    await c.env.DB.prepare(
      "INSERT INTO magic_link_tokens (id, email, token_hash, expires_at, used_at, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
    )
      .bind(uuidv7(), email, tokenHash, ts + AUTH.MAGIC_LINK_TTL_SEC * 1000, ts)
      .run();

    // Authenticated test callers get the raw token echoed back and NO email is sent — every
    // automated run otherwise burns real Resend quota on fake addresses (and bounces hurt the
    // sending domain's reputation). Without the header, behavior is byte-identical to prod.
    const debugHeader = c.req.header("X-Debug-Auth");
    if (debugHeader && debugHeader === c.env.DEBUG_AUTH_SECRET) {
      return ok(c, { debugToken: raw });
    }

    const link = `${config.APP_URL}/auth/verify?token=${raw}`;
    await getSender(c.env).send({
      from: `SuperProfile <no-reply@${config.SEND_DOMAIN}>`,
      to: email,
      subject: "Sign in to SuperProfile",
      text: `Sign in to SuperProfile:\n\n${link}\n\nThis link expires in 10 minutes.`,
      html: `<p>Sign in to SuperProfile:</p><p><a href="${link}">${link}</a></p><p>This link expires in 10 minutes.</p>`,
    });
    return ok(c);
  },
);

authApi.post("/verify", validate(VerifyBody, "json"), async (c) => {
  const { token } = c.get("body") as z.infer<typeof VerifyBody>;
  const tokenHash = await hashToken(token);
  const ts = now();
  const tokenRow = await c.env.DB.prepare("SELECT email FROM magic_link_tokens WHERE token_hash=?1")
    .bind(tokenHash)
    .first<{ email: string }>();
  await consumeToken(c.env.DB, tokenHash, ts, "magic_link_tokens");
  if (!tokenRow) throw ctxErr.auth.invalidToken();

  const user = await upsertUserByEmail(c.env.DB, tokenRow.email);
  const accessToken = await signAccessToken(c.env, user.id);
  const refreshToken = await signRefreshToken(c.env, user.id);
  setCookie(c, AUTH.REFRESH_COOKIE, refreshToken, refreshCookieOpts());
  return ok(c, { accessToken, user });
});

authApi.post("/refresh", async (c) => {
  const cookie = getCookie(c, AUTH.REFRESH_COOKIE);
  if (!cookie) throw ctxErr.auth.invalidRefreshToken();
  const { sub } = await verifyRefreshToken(c.env, cookie);
  const accessToken = await signAccessToken(c.env, sub);
  const refreshToken = await signRefreshToken(c.env, sub);
  setCookie(c, AUTH.REFRESH_COOKIE, refreshToken, refreshCookieOpts());
  return ok(c, { accessToken });
});

authApi.post("/logout", async (c) => {
  deleteCookie(c, AUTH.REFRESH_COOKIE, { path: AUTH.REFRESH_COOKIE_PATH });
  return ok(c);
});

const InviteAcceptBody = z.object({ token: z.string().min(1) });

authApi.post("/invite-accept", authMiddleware, validate(InviteAcceptBody, "json"), async (c) => {
  const { token } = c.get("body") as z.infer<typeof InviteAcceptBody>;
  const userId = c.get("userId");
  const tokenHash = await hashToken(token);
  const ts = now();

  const invite = await c.env.DB.prepare(
    "SELECT workspace_id as workspaceId, email, role FROM invites WHERE token_hash=?1",
  )
    .bind(tokenHash)
    .first<{ workspaceId: string; email: string; role: string }>();
  if (!invite) throw ctxErr.invite.notFound();

  // The email check must run BEFORE the one-time consume — otherwise a wrong-account click
  // burns the token and the rightful invitee can never accept.
  const user = await c.env.DB.prepare("SELECT email FROM users WHERE id=?1").bind(userId).first<{ email: string | null }>();
  if (!user?.email || user.email !== invite.email) {
    throw ctxErr.auth.notAuthorized({ msg: "This invite is for a different email address" });
  }
  await consumeToken(c.env.DB, tokenHash, ts, "invites", "accepted_at");

  await c.env.DB.prepare(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role=excluded.role",
  )
    .bind(invite.workspaceId, userId, invite.role, ts)
    .run();

  const workspace = await c.env.DB.prepare(
    "SELECT id, name, slug FROM workspaces WHERE id=?1",
  )
    .bind(invite.workspaceId)
    .first();
  return ok(c, { workspace });
});

authApi.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const user = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE id=?1")
    .bind(userId)
    .first<UserRow>();
  if (!user) throw ctxErr.user.notFound();
  const { results } = await c.env.DB.prepare(
    `SELECT w.id as id, w.name as name, w.slug as slug, w.widget_key as widgetKey,
            w.widget_color as widgetColor, w.sla_first_response_min as slaFirstResponseMin,
            w.sla_resolution_min as slaResolutionMin, m.role as role
     FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id=?1`,
  )
    .bind(userId)
    .all<{
      id: string;
      name: string;
      slug: string;
      widgetKey: string;
      widgetColor: string;
      slaFirstResponseMin: number | null;
      slaResolutionMin: number | null;
      role: string;
    }>();
  return ok(c, { user, workspaces: results });
});

// Let a signed-in user set their own display name (shown to teammates on assigned conversations).
authApi.patch("/me", authMiddleware, validate(UpdateMeBody, "json"), async (c) => {
  const userId = c.get("userId");
  const { name } = c.get("body") as z.infer<typeof UpdateMeBody>;
  await c.env.DB.prepare("UPDATE users SET name=?1 WHERE id=?2").bind(name, userId).run();
  const user = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE id=?1")
    .bind(userId)
    .first<UserRow>();
  if (!user) throw ctxErr.user.notFound();
  return ok(c, { user });
});
