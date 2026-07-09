import type { Context, Hono } from "hono";
import { ZodError } from "zod";
import { CtxError } from "../ctx/ctx.error";

export function ok<T extends object>(c: Context, data?: T) {
  return c.json({ code: "OK", msg: "OK", data: data ?? {} }, 200);
}

export function registerErrorHandler(app: Hono<any>) {
  app.onError((err, c) => {
    if (err instanceof CtxError) {
      return c.json({ code: err.name, msg: err.message, data: err.data }, 400);
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const msg = issue ? `${issue.path.join(".")} ${issue.message}`.trim() : "Invalid request data";
      return c.json({ code: "INVALID_REQUEST_DATA", msg, data: {} }, 400);
    }
    console.error(err);
    return c.json({ code: "UNKNOWN_ERROR", msg: "Something went wrong", data: {} }, 500);
  });
}
