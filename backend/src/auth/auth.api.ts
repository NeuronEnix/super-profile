import { Hono } from "hono";
import { z } from "zod";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware } from "../middleware/auth";
import { AUTH } from "../common/const";
import { now, uuidv7 } from "../common/id";
import { generateRawToken, hashToken, consumeToken } from "./magic";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./token";
import { getSender } from "../email/sender";
import { getConfig } from "../config/env.config";
import type { HonoEnv } from "../common/hono-env";

const MagicLinkBody = z.object({ email: z.string().email() });
const VerifyBody = z.object({ token: z.string().min(1) });

type UserRow = { id: string; email: string | null; name: string | null };

function refreshCookieOpts() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "Strict" as const,
    path: AUTH.REFRESH_COOKIE_PATH,
    maxAge: AUTH.REFRESH_TOKEN_TTL_SEC,
  };
}

async function upsertUserByEmail(db: D1Database, email: string): Promise<UserRow> {
  const existing = await db.prepare("SELECT id, email, name FROM users WHERE email=?1").bind(email).first<UserRow>();
  if (existing) return existing;
  const id = uuidv7();
  await db
    .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, NULL, ?3)")
    .bind(id, email, now())
    .run();
  return { id, email, name: null };
}

export const authApi = new Hono<HonoEnv>();

authApi.post("/magic-link", validate(MagicLinkBody, "json"), async (c) => {
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

  const link = `${config.APP_URL}/auth/verify?token=${raw}`;
  await getSender(c.env).send({
    from: `SuperProfile <no-reply@${config.SEND_DOMAIN}>`,
    to: email,
    subject: "Sign in to SuperProfile",
    text: `Sign in to SuperProfile:\n\n${link}\n\nThis link expires in 10 minutes.`,
    html: `<p>Sign in to SuperProfile:</p><p><a href="${link}">${link}</a></p><p>This link expires in 10 minutes.</p>`,
  });

  const debugHeader = c.req.header("X-Debug-Auth");
  if (debugHeader && debugHeader === c.env.DEBUG_AUTH_SECRET) {
    return ok(c, { debugToken: raw });
  }
  return ok(c);
});

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

authApi.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const user = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE id=?1")
    .bind(userId)
    .first<UserRow>();
  if (!user) throw ctxErr.user.notFound();
  const { results } = await c.env.DB.prepare(
    `SELECT w.id as id, w.name as name, w.slug as slug, m.role as role
     FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id=?1`,
  )
    .bind(userId)
    .all<{ id: string; name: string; slug: string; role: string }>();
  return ok(c, { user, workspaces: results });
});
