import { Hono } from "hono";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { authMiddleware, wsMiddleware } from "../middleware/auth";
import type { HonoEnv } from "../common/hono-env";

export const contactsApi = new Hono<HonoEnv>();
contactsApi.use("*", authMiddleware, wsMiddleware);

contactsApi.get("/contacts/:contactId/timeline", async (c) => {
  const { workspaceId } = c.get("member");
  const contactId = c.req.param("contactId");
  const contact = await c.env.DB.prepare(
    "SELECT id, name, email, last_seen_at as lastSeenAt FROM contacts WHERE id=?1 AND workspace_id=?2",
  )
    .bind(contactId, workspaceId)
    .first();
  if (!contact) throw ctxErr.contact.notFound();
  const [{ results: events }, { results: conversations }] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, type, url, title, created_at as createdAt FROM contact_events WHERE contact_id=?1 ORDER BY created_at DESC LIMIT 30",
    )
      .bind(contactId)
      .all(),
    c.env.DB.prepare(
      `SELECT id, channel, status, subject, last_message_preview as lastMessagePreview,
              last_message_at as lastMessageAt, message_count as messageCount
       FROM conversations WHERE workspace_id=?1 AND contact_id=?2 ORDER BY last_message_at DESC LIMIT 20`,
    )
      .bind(workspaceId, contactId)
      .all(),
  ]);
  return ok(c, { contact, events, conversations });
});
