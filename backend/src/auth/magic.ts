import { ctxErr } from "../ctx/ctx.error";
import { sha256Hex } from "../common/id";

export function generateRawToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
}

export function hashToken(raw: string): Promise<string> {
  return sha256Hex(raw);
}

type ConsumableDb = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
};

/**
 * Atomically marks a token row used iff it exists, is unused, and unexpired — a
 * plain SELECT-then-UPDATE would race two verify calls for the same token into
 * both succeeding.
 */
export async function consumeToken(
  db: ConsumableDb,
  tokenHash: string,
  timestamp: number,
  table: string,
  usedColumn: string = "used_at",
): Promise<void> {
  const res = await db
    .prepare(
      `UPDATE ${table} SET ${usedColumn}=?1 WHERE token_hash=?2 AND ${usedColumn} IS NULL AND expires_at>?1`,
    )
    .bind(timestamp, tokenHash)
    .run();
  if (res.meta.changes !== 1) {
    const row = await db
      .prepare(`SELECT expires_at, ${usedColumn} as used_at FROM ${table} WHERE token_hash=?1`)
      .bind(tokenHash)
      .first<{ expires_at: number; used_at: number | null }>();
    throw !row ? ctxErr.auth.invalidToken() : ctxErr.auth.tokenExpired();
  }
}
