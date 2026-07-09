import type { Context, Next } from "hono";
import type { ZodSchema } from "zod";

type Source = "json" | "query" | "param";

export function validate(schema: ZodSchema, source: Source = "json") {
  return async (c: Context, next: Next) => {
    const raw =
      source === "json" ? await c.req.json().catch(() => ({})) :
      source === "query" ? c.req.query() :
      c.req.param();
    const parsed = schema.parse(raw);
    c.set("body", parsed);
    await next();
  };
}
