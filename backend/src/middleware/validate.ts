import type { Context, Next } from "hono";
import type { ZodSchema } from "zod";
import type { HonoEnv } from "../common/hono-env";

type Source = "json" | "query" | "param";

export function validate(schema: ZodSchema, source: Source = "json") {
  return async (c: Context<HonoEnv>, next: Next) => {
    const raw =
      source === "json" ? await c.req.json().catch(() => ({})) :
      source === "query" ? c.req.query() :
      c.req.param();
    const parsed = schema.parse(raw);
    c.set("body", parsed);
    await next();
  };
}
