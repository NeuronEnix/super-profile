import { Hono } from "hono";
import type { Env } from "./types";
import type { HonoEnv } from "./common/hono-env";
import { ok, registerErrorHandler } from "./common/envelope";
import { ctxErr } from "./ctx/ctx.error";
import { logger } from "./middleware/logger";
import { authApi } from "./auth/auth.api";

export class WorkspaceHub {
  constructor(_state: DurableObjectState, _env: Env) {}
  async fetch(): Promise<Response> {
    return new Response("ok");
  }
}

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

// Any /api/v1/* path that didn't match a real route is a genuine 404 — must not
// fall through to the SPA asset fallback below.
app.all("/api/v1/*", () => {
  throw ctxErr.general.notFound();
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
