import type { Context, Next } from "hono";
import { ctxErr } from "../ctx/ctx.error";
import { FLAG } from "../common/const";
import type { HonoEnv } from "../common/hono-env";

/** Single shared DO instance — it holds a Map<key, number[]> internally, so one object serves every key. */
function limiterStub(env: HonoEnv["Bindings"]) {
  const id = env.RATE_LIMITER.idFromName("global");
  return env.RATE_LIMITER.get(id);
}

export function rateLimit(keyFn: (c: Context<HonoEnv>) => string, limit: number, windowSec: number) {
  return async (c: Context<HonoEnv>, next: Next) => {
    if (!FLAG.RATE_LIMIT_ENABLED) {
      await next();
      return;
    }
    const key = keyFn(c);
    const res = await limiterStub(c.env).fetch("https://rate-limiter/check", {
      method: "POST",
      body: JSON.stringify({ key, limit, windowSec }),
    });
    const { allowed } = await res.json<{ allowed: boolean }>();
    if (!allowed) throw ctxErr.rateLimit.exceeded();
    await next();
  };
}
