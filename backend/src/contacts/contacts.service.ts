import { uuidv7 } from "../common/id";

export type ContactRow = { id: string; name: string | null; email: string | null };

/**
 * contacts has UNIQUE(workspace_id, email). Before adopting an email onto a contact row, make
 * sure no OTHER contact in the workspace already holds it — otherwise the INSERT/UPDATE throws
 * and the whole request 500s (very reachable: a visitor types an email in the widget that
 * already arrived via the email channel, or vice versa).
 *
 * Resolution follows the identity rules: a VERIFIED email (inbound mail — the sender provably
 * owns the address) steals the address from an unverified holder; an UNVERIFIED email (typed
 * into the widget, display-only) is silently dropped instead.
 */
async function claimableEmail(
  db: D1Database,
  workspaceId: string,
  ownContactId: string | null,
  email: string,
  verifiedEmail: boolean,
): Promise<string | null> {
  const holder = await db
    .prepare("SELECT id FROM contacts WHERE workspace_id=?1 AND email=?2")
    .bind(workspaceId, email)
    .first<{ id: string }>();
  if (!holder || holder.id === ownContactId) return email;
  if (!verifiedEmail) return null;
  await db.prepare("UPDATE contacts SET email=NULL WHERE id=?1").bind(holder.id).run();
  return email;
}

/** A user's profile within a workspace — one users row, N contacts (one per contacted workspace). */
export async function resolveContact(
  db: D1Database,
  workspaceId: string,
  userId: string,
  email: string | undefined | null,
  name: string | undefined | null,
  ts: number,
  opts: { verifiedEmail: boolean } = { verifiedEmail: false },
): Promise<ContactRow> {
  const existing = await db
    .prepare("SELECT id, name, email FROM contacts WHERE workspace_id=?1 AND user_id=?2")
    .bind(workspaceId, userId)
    .first<ContactRow>();

  if (!existing) {
    const contactId = uuidv7();
    const safeEmail = email ? await claimableEmail(db, workspaceId, null, email, opts.verifiedEmail) : null;
    await db
      .prepare(
        "INSERT INTO contacts (id, workspace_id, user_id, email, name, last_seen_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
      )
      .bind(contactId, workspaceId, userId, safeEmail, name ?? null, ts)
      .run();
    return { id: contactId, name: name ?? null, email: safeEmail };
  }

  let nextEmail = existing.email;
  if (!nextEmail && email) {
    nextEmail = await claimableEmail(db, workspaceId, existing.id, email, opts.verifiedEmail);
  }
  const nextName = existing.name ?? name ?? null;
  await db
    .prepare("UPDATE contacts SET email=?1, name=?2, last_seen_at=?3 WHERE id=?4")
    .bind(nextEmail, nextName, ts, existing.id)
    .run();
  return { id: existing.id, name: nextName, email: nextEmail };
}
