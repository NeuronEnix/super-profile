import { uuidv7, now } from "../common/id";
import { CONVERSATION } from "../common/const";
import { truncatePreview, shouldReopen } from "../conversations/service";
import type { Env } from "../types";

export type MessageIn = {
  workspaceId: string;
  conversationId?: string;
  newConversation?: { contactId: string; channel: "CHAT" | "EMAIL"; subject: string | null };
  senderType: "CONTACT" | "AGENT" | "SYSTEM";
  senderId: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  emailMessageId?: string | null;
  emailInReplyTo?: string | null;
};

export type ConversationRow = {
  id: string;
  workspaceId: string;
  contactId: string;
  channel: "CHAT" | "EMAIL";
  status: "OPEN" | "SNOOZED" | "RESOLVED";
  assigneeId: string | null;
  subject: string | null;
  snoozedUntil: number | null;
  lastMessageAt: number;
  lastMessagePreview: string;
  messageCount: number;
  aiSummary: string | null;
  aiSummaryMsgCount: number;
  contactLastReadAt: number | null;
  agentLastReadAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type MessageRow = {
  id: string;
  conversationId: string;
  workspaceId: string;
  senderType: "CONTACT" | "AGENT" | "SYSTEM";
  senderId: string | null;
  bodyText: string;
  bodyHtml: string | null;
  emailMessageId: string | null;
  emailInReplyTo: string | null;
  createdAt: number;
};

export type MessageOut = { conversation: ConversationRow; message: MessageRow };

export function getHubStub(env: Env, workspaceId: string) {
  const id = env.WORKSPACE_HUB.idFromName(workspaceId);
  return env.WORKSPACE_HUB.get(id);
}

export async function sendMessage(env: Env, input: MessageIn): Promise<MessageOut> {
  const stub = getHubStub(env, input.workspaceId);
  const res = await stub.fetch("https://do/message", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`hub /message failed: ${res.status}`);
  return res.json();
}

export async function markRead(
  env: Env,
  workspaceId: string,
  conversationId: string,
  by: "AGENT" | "CONTACT",
): Promise<void> {
  const stub = getHubStub(env, workspaceId);
  const res = await stub.fetch("https://do/read", {
    method: "POST",
    body: JSON.stringify({ conversationId, by }),
  });
  if (!res.ok) throw new Error(`hub /read failed: ${res.status}`);
}

const CONVERSATION_COLUMNS = `
  id, workspace_id as workspaceId, contact_id as contactId, channel, status,
  assignee_id as assigneeId, subject, snoozed_until as snoozedUntil,
  last_message_at as lastMessageAt, last_message_preview as lastMessagePreview,
  message_count as messageCount, ai_summary as aiSummary, ai_summary_msg_count as aiSummaryMsgCount,
  contact_last_read_at as contactLastReadAt, agent_last_read_at as agentLastReadAt,
  created_at as createdAt, updated_at as updatedAt
`;

const MESSAGE_COLUMNS = `
  id, conversation_id as conversationId, workspace_id as workspaceId, sender_type as senderType,
  sender_id as senderId, body_text as bodyText, body_html as bodyHtml,
  email_message_id as emailMessageId, email_in_reply_to as emailInReplyTo, created_at as createdAt
`;

export class WorkspaceHub {
  private env: Env;

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/message" && request.method === "POST") {
        const input = (await request.json()) as MessageIn;
        const out = await this.handleMessage(input);
        return Response.json(out);
      }
      if (url.pathname === "/read" && request.method === "POST") {
        const input = (await request.json()) as { conversationId: string; by: "AGENT" | "CONTACT" };
        await this.handleRead(input);
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response("hub error", { status: 500 });
    }
  }

  private async loadConversation(id: string): Promise<ConversationRow> {
    const row = await this.env.DB.prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id=?1`)
      .bind(id)
      .first<ConversationRow>();
    if (!row) throw new Error(`conversation ${id} missing after write`);
    return row;
  }

  private async loadMessage(id: string): Promise<MessageRow> {
    const row = await this.env.DB.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id=?1`)
      .bind(id)
      .first<MessageRow>();
    if (!row) throw new Error(`message ${id} missing after write`);
    return row;
  }

  private async handleMessage(input: MessageIn): Promise<MessageOut> {
    const db = this.env.DB;
    const ts = now();
    let conversationId = input.conversationId;

    if (input.newConversation) {
      conversationId = uuidv7();
      const subject =
        input.newConversation.channel === "CHAT"
          ? input.bodyText.slice(0, 80)
          : input.newConversation.subject;
      await db
        .prepare(
          `INSERT INTO conversations
             (id, workspace_id, contact_id, channel, status, assignee_id, subject, snoozed_until,
              last_message_at, last_message_preview, message_count, ai_summary, ai_summary_msg_count,
              contact_last_read_at, agent_last_read_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL, ?7, '', 0, NULL, 0, NULL, NULL, ?7, ?7)`,
        )
        .bind(
          conversationId,
          input.workspaceId,
          input.newConversation.contactId,
          input.newConversation.channel,
          CONVERSATION.STATUS.OPEN,
          subject,
          ts,
        )
        .run();
    }

    if (!conversationId) throw new Error("MessageIn missing conversationId and newConversation");

    const current = await this.loadConversation(conversationId);
    const messageId = uuidv7();

    await db
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, workspace_id, sender_type, sender_id, body_text, body_html,
            email_message_id, email_in_reply_to, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        messageId,
        conversationId,
        input.workspaceId,
        input.senderType,
        input.senderId,
        input.bodyText,
        input.bodyHtml ?? null,
        input.emailMessageId ?? null,
        input.emailInReplyTo ?? null,
        ts,
      )
      .run();

    const reopen = shouldReopen(input.senderType, current.status);
    const nextStatus = reopen ? CONVERSATION.STATUS.OPEN : current.status;

    await db
      .prepare(
        `UPDATE conversations
         SET last_message_at=?1, last_message_preview=?2, message_count=message_count+1,
             status=?3, snoozed_until=CASE WHEN ?3='OPEN' THEN NULL ELSE snoozed_until END,
             updated_at=?1
         WHERE id=?4`,
      )
      .bind(ts, truncatePreview(input.bodyText), nextStatus, conversationId)
      .run();

    if (reopen) {
      const reopenMessageId = uuidv7();
      await db
        .prepare(
          `INSERT INTO messages
             (id, conversation_id, workspace_id, sender_type, sender_id, body_text, body_html,
              email_message_id, email_in_reply_to, created_at)
           VALUES (?1, ?2, ?3, 'SYSTEM', NULL, 'Conversation reopened', NULL, NULL, NULL, ?4)`,
        )
        .bind(reopenMessageId, conversationId, input.workspaceId, ts)
        .run();
      await db
        .prepare(
          `UPDATE conversations SET last_message_at=?1, last_message_preview='Conversation reopened',
             message_count=message_count+1, updated_at=?1 WHERE id=?2`,
        )
        .bind(ts, conversationId)
        .run();
    }

    const conversation = await this.loadConversation(conversationId);
    const message = await this.loadMessage(messageId);

    const out: MessageOut = { conversation, message };
    this.broadcast(out);
    return out;
  }

  private async handleRead(input: { conversationId: string; by: "AGENT" | "CONTACT" }): Promise<void> {
    const column = input.by === "AGENT" ? "agent_last_read_at" : "contact_last_read_at";
    await this.env.DB.prepare(`UPDATE conversations SET ${column}=?1 WHERE id=?2`)
      .bind(now(), input.conversationId)
      .run();
    this.broadcastRead(input.conversationId, input.by);
  }

  /** Task 5 hook: overridden behavior lands once WebSocket hibernation is wired up. */
  private broadcast(_out: MessageOut): void {}

  /** Task 5 hook: overridden behavior lands once WebSocket hibernation is wired up. */
  private broadcastRead(_conversationId: string, _by: "AGENT" | "CONTACT"): void {}
}
