import type { Context, Next } from "hono";
import { ctxErr } from "../ctx/ctx.error";
import { verifyWidgetToken } from "../auth/token";
import type { HonoEnv } from "../common/hono-env";

export async function widgetAuthMiddleware(c: Context<HonoEnv>, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) throw ctxErr.widget.invalidToken();
  const jwt = header.slice("Bearer ".length);
  const { sub, ws } = await verifyWidgetToken(c.env, jwt);
  c.set("widgetUserId", sub);
  c.set("widgetWorkspaceId", ws);
  await next();
}
