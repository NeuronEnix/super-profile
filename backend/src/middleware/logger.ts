import type { Context, Next } from "hono";
import { uuidv7 } from "../common/id";
import type { HonoEnv } from "../common/hono-env";

export async function logger(c: Context<HonoEnv>, next: Next) {
  const reqId = uuidv7();
  c.set("reqId", reqId);
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(
    JSON.stringify({ reqId, method: c.req.method, path: c.req.path, status: c.res.status, ms }),
  );
}
