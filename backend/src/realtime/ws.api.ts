import { Hono } from "hono";
import { ctxErr } from "../ctx/ctx.error";
import { verifyAccessToken, verifyWidgetToken } from "../auth/token";
import { getHubStub } from "./hub";
import type { HonoEnv } from "../common/hono-env";

function forwardToHub(rawHeaders: Headers, kind: "AGENT" | "CONTACT", userId: string): Request {
  const headers = new Headers(rawHeaders);
  headers.set("x-kind", kind);
  headers.set("x-user-id", userId);
  return new Request("https://do/connect", { headers });
}

export const wsConnectApi = new Hono<HonoEnv>();

wsConnectApi.get("/dashboard", async (c) => {
  const wsId = c.req.query("wsId");
  const token = c.req.query("token");
  if (!wsId || !token) throw ctxErr.auth.invalidAccessToken();

  const { sub } = await verifyAccessToken(c.env, token);
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM workspace_members WHERE workspace_id=?1 AND user_id=?2",
  )
    .bind(wsId, sub)
    .first();
  if (!member) throw ctxErr.workspace.notMember();

  const stub = getHubStub(c.env, wsId);
  return stub.fetch(forwardToHub(c.req.raw.headers, "AGENT", sub));
});

wsConnectApi.get("/widget", async (c) => {
  const token = c.req.query("token");
  if (!token) throw ctxErr.widget.invalidToken();

  const { sub, ws } = await verifyWidgetToken(c.env, token);
  const stub = getHubStub(c.env, ws);
  return stub.fetch(forwardToHub(c.req.raw.headers, "CONTACT", sub));
});
