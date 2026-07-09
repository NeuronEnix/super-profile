import { Hono } from "hono";
import type { Env } from "./types";

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

const app = new Hono<{ Bindings: Env }>();

app.get("/api/v1/health", (c) =>
  c.json({ code: "OK", msg: "OK", data: { ts: Date.now() } }),
);

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
