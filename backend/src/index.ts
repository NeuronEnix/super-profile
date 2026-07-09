import { Hono } from "hono";
import type { Env } from "./types";
import type { HonoEnv } from "./common/hono-env";
import { ok, registerErrorHandler } from "./common/envelope";
import { ctxErr } from "./ctx/ctx.error";
import { logger } from "./middleware/logger";
import { authApi } from "./auth/auth.api";
import { workspacesApi, workspaceSettingsApi } from "./workspaces/workspaces.api";
import { teamApi } from "./team/team.api";
import { conversationsApi } from "./conversations/conversations.api";
import { widgetApi } from "./widget/widget.api";
import { wsConnectApi } from "./realtime/ws.api";
import { emailApi } from "./email/email.api";
import { handleEmailWorker } from "./email/email.worker";
import { kbApi } from "./kb/kb.api";
import { kbPublicApi } from "./kb/public.api";

export { WorkspaceHub } from "./realtime/hub";

export class RateLimiter {
  constructor(_state: DurableObjectState, _env: Env) {}
  async fetch(): Promise<Response> {
    return new Response("ok");
  }
}

const app = new Hono<HonoEnv>();

app.use("*", logger);
registerErrorHandler(app);

app.get("/api/v1/health", (c) => ok(c, { ts: Date.now() }));

app.route("/api/v1/auth", authApi);
app.route("/api/v1/workspaces", workspacesApi);
app.route("/api/v1/ws/:wsId", workspaceSettingsApi);
app.route("/api/v1/ws/:wsId", teamApi);
app.route("/api/v1/ws/:wsId", conversationsApi);
app.route("/api/v1/widget", widgetApi);
app.route("/api/v1/ws-connect", wsConnectApi);
app.route("/api/v1/email", emailApi);
app.route("/api/v1/ws/:wsId", kbApi);
app.route("/api/v1/public/kb", kbPublicApi);

// Any /api/v1/* path that didn't match a real route is a genuine 404 — must not
// fall through to the SPA asset fallback below.
app.all("/api/v1/*", () => {
  throw ctxErr.general.notFound();
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  email: handleEmailWorker,
};
