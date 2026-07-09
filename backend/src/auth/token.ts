import { sign, verify } from "hono/jwt";
import { ctxErr } from "../ctx/ctx.error";
import { AUTH } from "../common/const";
import { now } from "../common/id";
import type { Env } from "../types";

export type AccessPayload = { sub: string };
export type RefreshPayload = { sub: string };
export type WidgetPayload = { sub: string; ws: string; kind: "CONTACT" };

async function signJwt(payload: Record<string, unknown>, secret: string, ttlSec: number): Promise<string> {
  const iat = Math.floor(now() / 1000);
  return sign({ ...payload, iat, exp: iat + ttlSec }, secret, "HS256");
}

async function verifyJwt<T>(
  token: string,
  secret: string,
  onExpired: () => never,
  onInvalid: () => never,
): Promise<T> {
  try {
    const payload = await verify(token, secret, "HS256");
    return payload as T;
  } catch (e) {
    if (e instanceof Error && e.name === "JwtTokenExpired") onExpired();
    onInvalid();
  }
}

export function signAccessToken(env: Env, userId: string): Promise<string> {
  return signJwt({ sub: userId }, env.JWT_ACCESS_SECRET, AUTH.ACCESS_TOKEN_TTL_SEC);
}

export function verifyAccessToken(env: Env, jwt: string): Promise<AccessPayload> {
  return verifyJwt<AccessPayload>(
    jwt,
    env.JWT_ACCESS_SECRET,
    () => {
      throw ctxErr.auth.expiredAccessToken();
    },
    () => {
      throw ctxErr.auth.invalidAccessToken();
    },
  );
}

export function signRefreshToken(env: Env, userId: string): Promise<string> {
  return signJwt({ sub: userId }, env.JWT_REFRESH_SECRET, AUTH.REFRESH_TOKEN_TTL_SEC);
}

export function verifyRefreshToken(env: Env, jwt: string): Promise<RefreshPayload> {
  return verifyJwt<RefreshPayload>(
    jwt,
    env.JWT_REFRESH_SECRET,
    () => {
      throw ctxErr.auth.invalidRefreshToken();
    },
    () => {
      throw ctxErr.auth.invalidRefreshToken();
    },
  );
}

export function signWidgetToken(env: Env, userId: string, workspaceId: string): Promise<string> {
  return signJwt(
    { sub: userId, ws: workspaceId, kind: "CONTACT" },
    env.WIDGET_TOKEN_SECRET,
    AUTH.WIDGET_TOKEN_TTL_SEC,
  );
}

export function verifyWidgetToken(env: Env, jwt: string): Promise<WidgetPayload> {
  return verifyJwt<WidgetPayload>(
    jwt,
    env.WIDGET_TOKEN_SECRET,
    () => {
      throw ctxErr.widget.invalidToken();
    },
    () => {
      throw ctxErr.widget.invalidToken();
    },
  );
}
