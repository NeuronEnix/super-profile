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
import { isAppHost, lookupKbDomain, normalizeHost } from "./domains/host";
import { domainsApi } from "./domains/domains.api";

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

// Cloudflare-for-SaaS custom domains: the zone-wide `*/*` route hands this Worker ALL proxied
// traffic on the zone — our own app host, customer docs domains, and anything else that happens
// to be proxied. Recognized customer domains get the public KB only (its API + the SPA shell);
// hosts we don't recognize are handed back to their real origin untouched.
app.use("*", async (c, next) => {
  const host = normalizeHost(c.req.header("host"));
  if (isAppHost(host, c.env.APP_URL)) return next();
  const domain = await lookupKbDomain(c.env.DB, host);
  if (!domain) {
    try {
      return await fetch(c.req.raw);
    } catch {
      return c.text("Not found", 404);
    }
  }
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") && !path.startsWith("/api/v1/public/")) {
    throw ctxErr.general.notFound();
  }
  return next();
});

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
app.route("/api/v1/ws/:wsId", domainsApi);

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
