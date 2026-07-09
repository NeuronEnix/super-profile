import { uuidv7 } from "../common/id";

export type ContactRow = { id: string; name: string | null; email: string | null };

/** A user's profile within a workspace — one users row, N contacts (one per contacted workspace). */
export async function resolveContact(
  db: D1Database,
  workspaceId: string,
  userId: string,
  email: string | undefined | null,
  name: string | undefined | null,
  ts: number,
): Promise<ContactRow> {
  const existing = await db
    .prepare("SELECT id, name, email FROM contacts WHERE workspace_id=?1 AND user_id=?2")
    .bind(workspaceId, userId)
    .first<ContactRow>();
  if (!existing) {
    const contactId = uuidv7();
    await db
      .prepare(
        "INSERT INTO contacts (id, workspace_id, user_id, email, name, last_seen_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
      )
      .bind(contactId, workspaceId, userId, email ?? null, name ?? null, ts)
      .run();
    return { id: contactId, name: name ?? null, email: email ?? null };
  }
  const nextEmail = existing.email ?? email ?? null;
  const nextName = existing.name ?? name ?? null;
  await db
    .prepare("UPDATE contacts SET email=?1, name=?2, last_seen_at=?3 WHERE id=?4")
    .bind(nextEmail, nextName, ts, existing.id)
    .run();
  return { id: existing.id, name: nextName, email: nextEmail };
}
