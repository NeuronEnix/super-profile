import { Hono, type Context } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { widgetAuthMiddleware } from "../middleware/widget-auth";
import { rateLimit } from "../middleware/rate-limit";
import { now, uuidv7 } from "../common/id";
import { RATE_LIMIT } from "../common/const";
import { signWidgetToken } from "../auth/token";
import { sendMessage, markRead } from "../realtime/hub";
import { resolveContact } from "../contacts/contacts.service";
import { searchArticles } from "../kb/search";
import type { HonoEnv } from "../common/hono-env";

const widgetMsgKey = (c: Context<HonoEnv>) => `widget:${c.get("widgetUserId")}`;
const widgetMsgLimit = rateLimit(widgetMsgKey, RATE_LIMIT.WIDGET_MSG.PER_USER, RATE_LIMIT.WIDGET_MSG.WINDOW_SEC);

const BootBody = z.object({
  widgetKey: z.string().min(1),
  userId: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().min(1).max(120).optional(),
});

const MessagesQuery = z.object({ afterId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
const PostMessageBody = z.object({ body: z.string().min(1).max(20_000) });
const CreateConversationBody = z.object({
  body: z.string().min(1).max(20_000),
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
});
const SuggestQuery = z.object({ q: z.string().min(1).max(200) });

const CONVERSATION_COLS =
  "id, workspace_id as workspaceId, contact_id as contactId, channel, status, subject, last_message_at as lastMessageAt, last_message_preview as lastMessagePreview, message_count as messageCount, contact_last_read_at as contactLastReadAt, created_at as createdAt, updated_at as updatedAt";

const MESSAGE_COLS =
  "id, conversation_id as conversationId, workspace_id as workspaceId, sender_type as senderType, sender_id as senderId, body_text as bodyText, body_html as bodyHtml, created_at as createdAt";

async function resolveWidgetUserId(db: D1Database, proposedId: string | undefined, ts: number): Promise<string> {
  if (proposedId) {
    const existing = await db.prepare("SELECT id FROM users WHERE id=?1").bind(proposedId).first();
    if (existing) {
      await db.prepare("UPDATE users SET last_seen_at=?1 WHERE id=?2").bind(ts, proposedId).run();
      return proposedId;
    }
  }
  const freshId = uuidv7();
  await db
    .prepare("INSERT INTO users (id, email, name, last_seen_at, created_at) VALUES (?1, NULL, NULL, ?2, ?2)")
    .bind(freshId, ts)
    .run();
  return freshId;
}

async function assertOwnedConversation(db: D1Database, conversationId: string, workspaceId: string, userId: string) {
  const row = await db
    .prepare(
      `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.id=?1 AND c.workspace_id=?2 AND ct.user_id=?3`,
    )
    .bind(conversationId, workspaceId, userId)
    .first();
  if (!row) throw ctxErr.conversation.notFound();
}

export const widgetApi = new Hono<HonoEnv>();

widgetApi.post("/boot", validate(BootBody, "json"), async (c) => {
  const { widgetKey, userId, email, name } = c.get("body") as z.infer<typeof BootBody>;
  const workspace = await c.env.DB.prepare(
    "SELECT id, name, slug, widget_color as widgetColor FROM workspaces WHERE widget_key=?1",
  )
    .bind(widgetKey)
    .first<{ id: string; name: string; slug: string; widgetColor: string }>();
  if (!workspace) throw ctxErr.widget.invalidKey();

  const ts = now();
  const resolvedUserId = await resolveWidgetUserId(c.env.DB, userId, ts);
  const contact = await resolveContact(c.env.DB, workspace.id, resolvedUserId, email, name, ts);
  const token = await signWidgetToken(c.env, resolvedUserId, workspace.id);

  const { results } = await c.env.DB.prepare(
    `SELECT ${CONVERSATION_COLS} FROM conversations WHERE workspace_id=?1 AND contact_id=?2 ORDER BY last_message_at DESC LIMIT 50`,
  )
    .bind(workspace.id, contact.id)
    .all();

  return ok(c, {
    userId: resolvedUserId,
    token,
    contact,
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, widgetColor: workspace.widgetColor },
    conversations: results,
  });
});

widgetApi.use("/conversations/*", widgetAuthMiddleware);

widgetApi.get("/conversations/:id/messages", validate(MessagesQuery, "query"), async (c) => {
  const workspaceId = c.get("widgetWorkspaceId");
  const userId = c.get("widgetUserId");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  const q = c.get("body") as z.infer<typeof MessagesQuery>;
  const limit = q.limit ?? 50;
  await assertOwnedConversation(c.env.DB, id, workspaceId, userId);

  if (q.afterId) {
    const { results } = await c.env.DB.prepare(
      `SELECT ${MESSAGE_COLS} FROM messages WHERE conversation_id=?1 AND id>?2 ORDER BY id ASC LIMIT ?3`,
    )
      .bind(id, q.afterId, limit)
      .all();
    return ok(c, { messages: results });
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ${MESSAGE_COLS} FROM messages WHERE conversation_id=?1 ORDER BY id DESC LIMIT ?2`,
  )
    .bind(id, limit)
    .all();
  return ok(c, { messages: results.reverse() });
});

widgetApi.post("/conversations", widgetAuthMiddleware, validate(CreateConversationBody, "json"), widgetMsgLimit, async (c) => {
  const workspaceId = c.get("widgetWorkspaceId");
  const userId = c.get("widgetUserId");
  const { body, name, email } = c.get("body") as z.infer<typeof CreateConversationBody>;

  // Visitor-typed name/email are unverified — stored on the contact for display only, and only
  // if the email isn't already held by another contact in this workspace.
  const contact = await resolveContact(c.env.DB, workspaceId, userId, email, name, now(), { verifiedEmail: false });

  const out = await sendMessage(c.env, {
    workspaceId,
    newConversation: { contactId: contact.id, channel: "CHAT", subject: null },
    senderType: "CONTACT",
    senderId: userId,
    bodyText: body,
  });
  return ok(c, out);
});

widgetApi.post("/conversations/:id/messages", validate(PostMessageBody, "json"), widgetMsgLimit, async (c) => {
  const workspaceId = c.get("widgetWorkspaceId");
  const userId = c.get("widgetUserId");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  const { body } = c.get("body") as z.infer<typeof PostMessageBody>;
  await assertOwnedConversation(c.env.DB, id, workspaceId, userId);

  const out = await sendMessage(c.env, {
    workspaceId,
    conversationId: id,
    senderType: "CONTACT",
    senderId: userId,
    bodyText: body,
  });
  return ok(c, out);
});

widgetApi.post("/conversations/:id/read", async (c) => {
  const workspaceId = c.get("widgetWorkspaceId");
  const userId = c.get("widgetUserId");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  await assertOwnedConversation(c.env.DB, id, workspaceId, userId);
  await markRead(c.env, workspaceId, id, "CONTACT");
  return ok(c);
});

widgetApi.get("/suggest", widgetAuthMiddleware, validate(SuggestQuery, "query"), async (c) => {
  const workspaceId = c.get("widgetWorkspaceId");
  const { q } = c.get("body") as z.infer<typeof SuggestQuery>;
  const hits = await searchArticles(c.env.DB, workspaceId, q, 3);
  return ok(c, { results: hits });
});
