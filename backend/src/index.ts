import { Hono } from "hono";
import { cors } from "hono/cors";
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
import { aiApi } from "./ai/ai.api";

export { WorkspaceHub } from "./realtime/hub";
export { RateLimiter } from "./ratelimit/limiter";

const app = new Hono<HonoEnv>();

app.use("*", logger);
registerErrorHandler(app);

// Widget and public KB endpoints carry no ambient credentials (bearer tokens only, no cookies),
// so they're safe to open up cross-origin — the widget is embedded on arbitrary customer sites
// and the public KB is meant to be fetched from anywhere. Every other route stays same-origin
// only (no CORS headers at all), since the dashboard API relies on the refresh cookie.
const openCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: false,
});
app.use("/api/v1/widget/*", openCors);
app.use("/api/v1/public/*", openCors);

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
app.route("/api/v1/ws/:wsId", aiApi);

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
