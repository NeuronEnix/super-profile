import { Hono } from "hono";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ok, registerErrorHandler } from "../src/common/envelope";
import { ctxErr } from "../src/ctx/ctx.error";

function buildApp() {
  const app = new Hono();
  registerErrorHandler(app);
  app.get("/ok", (c) => ok(c, { hello: "world" }));
  app.get("/ok-empty", (c) => ok(c));
  app.get("/ctx-error", () => {
    throw ctxErr.workspace.notFound();
  });
  app.get("/zod-error", () => {
    z.object({ name: z.string() }).parse({});
    return new Response();
  });
  app.get("/unknown-error", () => {
    throw new Error("boom");
  });
  return app;
}

describe("envelope", () => {
  it("ok() returns 200 with code OK and the given data", async () => {
    const res = await buildApp().request("/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "OK", msg: "OK", data: { hello: "world" } });
  });

  it("ok() defaults data to an empty object", async () => {
    const res = await buildApp().request("/ok-empty");
    expect(await res.json()).toEqual({ code: "OK", msg: "OK", data: {} });
  });

  it("maps CtxError to a 400 envelope with the error's name/msg/data", async () => {
    const res = await buildApp().request("/ctx-error");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "WORKSPACE_NOT_FOUND", msg: "Workspace not found", data: {} });
  });

  it("maps ZodError to a 400 INVALID_REQUEST_DATA envelope", async () => {
    const res = await buildApp().request("/zod-error");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; data: object };
    expect(body.code).toBe("INVALID_REQUEST_DATA");
    expect(body.data).toEqual({});
  });

  it("maps unknown errors to a 500 UNKNOWN_ERROR envelope", async () => {
    const res = await buildApp().request("/unknown-error");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: "UNKNOWN_ERROR", msg: "Something went wrong", data: {} });
  });
});
