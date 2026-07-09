import { now, uuidv7 } from "../common/id";

export type UserRow = { id: string; email: string | null; name: string | null };

/** Verified email = one global identity (magic link + inbound mail both land here). */
export async function upsertUserByEmail(db: D1Database, email: string): Promise<UserRow> {
  const existing = await db
    .prepare("SELECT id, email, name FROM users WHERE email=?1")
    .bind(email)
    .first<UserRow>();
  if (existing) return existing;
  const id = uuidv7();
  await db
    .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, NULL, ?3)")
    .bind(id, email, now())
    .run();
  return { id, email, name: null };
}
