import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware } from "../middleware/auth";
import { CHANNEL, CONVERSATION } from "../common/const";
import { now } from "../common/id";
import { sendMessage, markRead, notifyConversationUpdated } from "../realtime/hub";
import { sendReply } from "../email/outbound";
import { runAiTurn } from "../ai/handler";
import { encodeConversationCursor, decodeConversationCursor } from "./service";
import type { HonoEnv } from "../common/hono-env";

const ListQuery = z.object({
  channel: z.enum([CHANNEL.CHAT, CHANNEL.EMAIL]).optional(),
  status: z.enum([CONVERSATION.STATUS.OPEN, CONVERSATION.STATUS.SNOOZED, CONVERSATION.STATUS.RESOLVED]).optional(),
  assigneeId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const MessagesQuery = z.object({
  cursor: z.string().optional(),
  afterId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const PostMessageBody = z.object({ body: z.string().min(1).max(20_000) });

const PatchConversationBody = z.object({
  status: z.enum([CONVERSATION.STATUS.OPEN, CONVERSATION.STATUS.SNOOZED, CONVERSATION.STATUS.RESOLVED]).optional(),
  assigneeId: z.string().nullable().optional(),
  snoozedUntil: z.number().nullable().optional(),
});

const CONVERSATION_LIST_COLUMNS = `
  c.id as id, c.workspace_id as workspaceId, c.contact_id as contactId, c.channel as channel,
  c.status as status, c.assignee_id as assigneeId, c.subject as subject,
  c.snoozed_until as snoozedUntil, c.last_message_at as lastMessageAt,
  c.last_message_preview as lastMessagePreview, c.message_count as messageCount,
  c.ai_handling as aiHandling, c.ai_escalated as aiEscalated,
  c.agent_last_read_at as agentLastReadAt, c.contact_last_read_at as contactLastReadAt,
  c.created_at as createdAt, c.updated_at as updatedAt,
  ct.id as contactRowId, ct.name as contactName, ct.email as contactEmail
`;

type ConversationListRow = {
  id: string;
  workspaceId: string;
  contactId: string;
  channel: string;
  status: string;
  assigneeId: string | null;
  subject: string | null;
  snoozedUntil: number | null;
  lastMessageAt: number;
  lastMessagePreview: string;
  messageCount: number;
  aiHandling: number;
  aiEscalated: number;
  agentLastReadAt: number | null;
  contactLastReadAt: number | null;
  createdAt: number;
  updatedAt: number;
  contactRowId: string;
  contactName: string | null;
  contactEmail: string | null;
};

function toListItem(row: ConversationListRow) {
  const { contactRowId, contactName, contactEmail, ...conversation } = row;
  return {
    ...conversation,
    unread: row.agentLastReadAt === null || row.agentLastReadAt < row.lastMessageAt,
    contact: { id: contactRowId, name: contactName, email: contactEmail },
  };
}

export const conversationsApi = new Hono<HonoEnv>();
conversationsApi.use("*", authMiddleware, wsMiddleware);

conversationsApi.get("/conversations", validate(ListQuery, "query"), async (c) => {
  const { workspaceId } = c.get("member");
  const q = c.get("body") as z.infer<typeof ListQuery>;
  const limit = q.limit ?? 25;
  const ts = now();

  await c.env.DB.prepare(
    `UPDATE conversations SET status='OPEN', snoozed_until=NULL, updated_at=?1
     WHERE workspace_id=?2 AND status='SNOOZED' AND snoozed_until IS NOT NULL AND snoozed_until<?1`,
  )
    .bind(ts, workspaceId)
    .run();

  const clauses = ["c.workspace_id=?1"];
  const binds: unknown[] = [workspaceId];
  if (q.channel) {
    binds.push(q.channel);
    clauses.push(`c.channel=?${binds.length}`);
  }
  if (q.status) {
    binds.push(q.status);
    clauses.push(`c.status=?${binds.length}`);
  }
  if (q.assigneeId === "unassigned") {
    clauses.push("c.assignee_id IS NULL");
  } else if (q.assigneeId) {
    binds.push(q.assigneeId);
    clauses.push(`c.assignee_id=?${binds.length}`);
  }
  if (q.cursor) {
    const decoded = decodeConversationCursor(q.cursor);
    if (decoded) {
      binds.push(decoded.lastMessageAt, decoded.id);
      clauses.push(`(c.last_message_at < ?${binds.length - 1} OR (c.last_message_at = ?${binds.length - 1} AND c.id < ?${binds.length}))`);
    }
  }
  binds.push(limit);

  const { results } = await c.env.DB.prepare(
    `SELECT ${CONVERSATION_LIST_COLUMNS} FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?${binds.length}`,
  )
    .bind(...binds)
    .all<ConversationListRow>();

  const items = results.map(toListItem);
  const last = results[results.length - 1];
  const nextCursor = last && results.length === limit ? encodeConversationCursor(last.lastMessageAt, last.id) : null;
  return ok(c, { conversations: items, nextCursor });
});

conversationsApi.get("/conversations/:id", async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  const row = await c.env.DB.prepare(
    `SELECT ${CONVERSATION_LIST_COLUMNS} FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.id=?1 AND c.workspace_id=?2`,
  )
    .bind(id, workspaceId)
    .first<ConversationListRow>();
  if (!row) throw ctxErr.conversation.notFound();
  return ok(c, { conversation: toListItem(row) });
});

conversationsApi.get("/conversations/:id/messages", validate(MessagesQuery, "query"), async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  const q = c.get("body") as z.infer<typeof MessagesQuery>;
  const limit = q.limit ?? 50;

  const conv = await c.env.DB.prepare("SELECT id FROM conversations WHERE id=?1 AND workspace_id=?2")
    .bind(id, workspaceId)
    .first();
  if (!conv) throw ctxErr.conversation.notFound();

  const cols =
    "id, conversation_id as conversationId, workspace_id as workspaceId, sender_type as senderType, sender_id as senderId, body_text as bodyText, body_html as bodyHtml, email_message_id as emailMessageId, email_in_reply_to as emailInReplyTo, created_at as createdAt";

  if (q.afterId) {
    const { results } = await c.env.DB.prepare(
      `SELECT ${cols} FROM messages WHERE conversation_id=?1 AND id>?2 ORDER BY id ASC LIMIT ?3`,
    )
      .bind(id, q.afterId, limit)
      .all();
    return ok(c, { messages: results });
  }
  if (q.cursor) {
    const { results } = await c.env.DB.prepare(
      `SELECT ${cols} FROM messages WHERE conversation_id=?1 AND id<?2 ORDER BY id DESC LIMIT ?3`,
    )
      .bind(id, q.cursor, limit)
      .all();
    return ok(c, { messages: results.reverse() });
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ${cols} FROM messages WHERE conversation_id=?1 ORDER BY id DESC LIMIT ?2`,
  )
    .bind(id, limit)
    .all();
  return ok(c, { messages: results.reverse() });
});

conversationsApi.post("/conversations/:id/messages", validate(PostMessageBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  const { body } = c.get("body") as z.infer<typeof PostMessageBody>;

  const conv = await c.env.DB.prepare("SELECT id FROM conversations WHERE id=?1 AND workspace_id=?2")
    .bind(id, workspaceId)
    .first();
  if (!conv) throw ctxErr.conversation.notFound();

  const out = await sendMessage(c.env, {
    workspaceId,
    conversationId: id,
    senderType: "AGENT",
    senderId: userId,
    bodyText: body,
  });

  if (out.conversation.channel === CHANNEL.EMAIL) {
    const [workspace, contact] = await Promise.all([
      c.env.DB.prepare("SELECT id, name, slug FROM workspaces WHERE id=?1").bind(workspaceId).first<{
        id: string;
        name: string;
        slug: string;
      }>(),
      c.env.DB.prepare("SELECT email FROM contacts WHERE id=?1").bind(out.conversation.contactId).first<{
        email: string | null;
      }>(),
    ]);
    if (workspace && contact) {
      c.executionCtx.waitUntil(
        sendReply(c.env, { workspace, conversation: out.conversation, contact, message: out.message }),
      );
    }
  }

  return ok(c, out);
});

conversationsApi.patch("/conversations/:id", validate(PatchConversationBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  const patch = c.get("body") as z.infer<typeof PatchConversationBody>;

  const current = await c.env.DB.prepare(
    "SELECT status, assignee_id as assigneeId, ai_handling as aiHandling FROM conversations WHERE id=?1 AND workspace_id=?2",
  )
    .bind(id, workspaceId)
    .first<{ status: string; assigneeId: string | null; aiHandling: number }>();
  if (!current) throw ctxErr.conversation.notFound();

  if (patch.assigneeId) {
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM workspace_members WHERE workspace_id=?1 AND user_id=?2",
    )
      .bind(workspaceId, patch.assigneeId)
      .first();
    if (!member) throw ctxErr.workspace.notMember({ msg: "Assignee is not a member of this workspace" });
  }

  const ts = now();
  const sets: string[] = [];
  const binds: unknown[] = [];
  const systemMessages: string[] = [];

  if (patch.assigneeId !== undefined && patch.assigneeId !== current.assigneeId) {
    binds.push(patch.assigneeId);
    sets.push(`assignee_id=?${binds.length}`);
    if (patch.assigneeId === null) {
      systemMessages.push("Unassigned");
    } else {
      const assignee = await c.env.DB.prepare("SELECT name, email FROM users WHERE id=?1")
        .bind(patch.assigneeId)
        .first<{ name: string | null; email: string | null }>();
      systemMessages.push(`Assigned to ${assignee?.name ?? assignee?.email ?? "a teammate"}`);
    }
  }
  if (patch.status !== undefined && patch.status !== current.status) {
    binds.push(patch.status);
    sets.push(`status=?${binds.length}`);
    if (patch.status === CONVERSATION.STATUS.RESOLVED) systemMessages.push("Resolved");
    else if (patch.status === CONVERSATION.STATUS.SNOOZED) {
      systemMessages.push(
        patch.snoozedUntil ? `Snoozed until ${new Date(patch.snoozedUntil).toISOString()}` : "Snoozed",
      );
    } else if (patch.status === CONVERSATION.STATUS.OPEN) systemMessages.push("Reopened");
  }
  // Resolving releases the assignment: a closed conversation is open to the whole team, and
  // whoever reopens it (below) claims it fresh. Skip when the caller set assignee itself.
  if (
    patch.status === CONVERSATION.STATUS.RESOLVED &&
    patch.assigneeId === undefined &&
    current.assigneeId !== null
  ) {
    sets.push("assignee_id=NULL");
  }
  // Reopening an unassigned conversation (the state resolving leaves it in) auto-assigns it to
  // whoever reopened it — mirroring the auto-claim that happens when an agent reopens by replying.
  if (
    patch.status === CONVERSATION.STATUS.OPEN &&
    patch.assigneeId === undefined &&
    current.assigneeId === null
  ) {
    binds.push(userId);
    sets.push(`assignee_id=?${binds.length}`);
    const me = await c.env.DB.prepare("SELECT name, email FROM users WHERE id=?1")
      .bind(userId)
      .first<{ name: string | null; email: string | null }>();
    systemMessages.push(`Assigned to ${me?.name ?? me?.email ?? "you"}`);
  }
  if (patch.snoozedUntil !== undefined) {
    binds.push(patch.snoozedUntil);
    sets.push(`snoozed_until=?${binds.length}`);
  }
  // Reassigning or resolving is a human intervention — it always ends AI handling and clears
  // the escalation flag (the conversation is no longer waiting on anyone).
  if (
    (patch.assigneeId !== undefined && patch.assigneeId !== current.assigneeId) ||
    patch.status === CONVERSATION.STATUS.RESOLVED
  ) {
    sets.push("ai_handling=0", "ai_escalated=0");
  }

  if (sets.length > 0) {
    binds.push(ts);
    sets.push(`updated_at=?${binds.length}`);
    binds.push(id, workspaceId);
    await c.env.DB.prepare(
      `UPDATE conversations SET ${sets.join(", ")} WHERE id=?${binds.length - 1} AND workspace_id=?${binds.length}`,
    )
      .bind(...binds)
      .run();
  }

  for (const text of systemMessages) {
    await sendMessage(c.env, { workspaceId, conversationId: id, senderType: "SYSTEM", senderId: null, bodyText: text });
  }
  if (sets.length > 0) {
    await notifyConversationUpdated(c.env, workspaceId, id);
  }

  const updated = await c.env.DB.prepare(
    `SELECT ${CONVERSATION_LIST_COLUMNS} FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id=?1`,
  )
    .bind(id)
    .first<ConversationListRow>();
  return ok(c, { conversation: updated ? toListItem(updated) : null });
});

/** Hand the conversation to the AI. Only the current assignee can delegate — they stay the
 * assignee (they're the human the AI escalates back to). */
conversationsApi.post("/conversations/:id/ai/delegate", async (c) => {
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();

  const current = await c.env.DB.prepare(
    "SELECT status, assignee_id as assigneeId, ai_handling as aiHandling FROM conversations WHERE id=?1 AND workspace_id=?2",
  )
    .bind(id, workspaceId)
    .first<{ status: string; assigneeId: string | null; aiHandling: number }>();
  if (!current) throw ctxErr.conversation.notFound();
  if (current.status === CONVERSATION.STATUS.RESOLVED)
    throw ctxErr.ai.notAssignee({ msg: "Reopen the conversation before delegating to AI" });
  if (current.assigneeId !== userId) throw ctxErr.ai.notAssignee();

  if (!current.aiHandling) {
    await c.env.DB.prepare(
      "UPDATE conversations SET ai_handling=1, ai_escalated=0, updated_at=?1 WHERE id=?2 AND workspace_id=?3",
    )
      .bind(now(), id, workspaceId)
      .run();
    await sendMessage(c.env, {
      workspaceId,
      conversationId: id,
      senderType: "SYSTEM",
      senderId: null,
      bodyText: "Delegated to AI",
    });
    await notifyConversationUpdated(c.env, workspaceId, id);
    // First AI turn runs after the response — the delegating agent sees the reply arrive live.
    c.executionCtx.waitUntil(runAiTurn(c.env, workspaceId, id, { firstTurn: true }));
  }

  const updated = await c.env.DB.prepare(
    `SELECT ${CONVERSATION_LIST_COLUMNS} FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id=?1`,
  )
    .bind(id)
    .first<ConversationListRow>();
  return ok(c, { conversation: updated ? toListItem(updated) : null });
});

/** Take the conversation back from the AI (also clears the escalated flag). */
conversationsApi.post("/conversations/:id/ai/takeover", async (c) => {
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();

  const current = await c.env.DB.prepare(
    "SELECT assignee_id as assigneeId, ai_handling as aiHandling, ai_escalated as aiEscalated FROM conversations WHERE id=?1 AND workspace_id=?2",
  )
    .bind(id, workspaceId)
    .first<{ assigneeId: string | null; aiHandling: number; aiEscalated: number }>();
  if (!current) throw ctxErr.conversation.notFound();
  if (current.assigneeId !== userId) throw ctxErr.ai.notAssignee();

  if (current.aiHandling || current.aiEscalated) {
    await c.env.DB.prepare(
      "UPDATE conversations SET ai_handling=0, ai_escalated=0, updated_at=?1 WHERE id=?2 AND workspace_id=?3",
    )
      .bind(now(), id, workspaceId)
      .run();
    if (current.aiHandling) {
      const me = await c.env.DB.prepare("SELECT name, email FROM users WHERE id=?1")
        .bind(userId)
        .first<{ name: string | null; email: string | null }>();
      await sendMessage(c.env, {
        workspaceId,
        conversationId: id,
        senderType: "SYSTEM",
        senderId: null,
        bodyText: `${me?.name ?? me?.email ?? "An agent"} took over from AI`,
      });
    }
    await notifyConversationUpdated(c.env, workspaceId, id);
  }

  const updated = await c.env.DB.prepare(
    `SELECT ${CONVERSATION_LIST_COLUMNS} FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id=?1`,
  )
    .bind(id)
    .first<ConversationListRow>();
  return ok(c, { conversation: updated ? toListItem(updated) : null });
});

conversationsApi.post("/conversations/:id/read", async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  if (!id) throw ctxErr.conversation.notFound();
  const conv = await c.env.DB.prepare("SELECT id FROM conversations WHERE id=?1 AND workspace_id=?2")
    .bind(id, workspaceId)
    .first();
  if (!conv) throw ctxErr.conversation.notFound();
  await markRead(c.env, workspaceId, id, "AGENT");
  return ok(c);
});
