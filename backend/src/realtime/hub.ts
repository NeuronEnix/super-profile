import { uuidv7, now } from "../common/id";
import { CONVERSATION, WS_EVENT } from "../common/const";
import { truncatePreview, shouldReopen } from "../conversations/service";
import type { Env } from "../types";

type SocketAttachment = { kind: "AGENT" | "CONTACT"; userId: string };
type ClientMessage =
  | { type: "TYPING"; conversationId: string; state: "START" | "STOP" }
  | { type: "READ"; conversationId: string }
  | { type: "PING" };

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

export async function notifyConversationUpdated(
  env: Env,
  workspaceId: string,
  conversationId: string,
): Promise<void> {
  const stub = getHubStub(env, workspaceId);
  const res = await stub.fetch("https://do/conversation-updated", {
    method: "POST",
    body: JSON.stringify({ conversationId }),
  });
  if (!res.ok) throw new Error(`hub /conversation-updated failed: ${res.status}`);
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
  private state: DurableObjectState;
  /** conversationId -> the contact's user_id. Lazily filled from D1, survives hibernation wake. */
  private convContact: Map<string, string> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/connect") {
        return this.handleConnect(request);
      }
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
      if (url.pathname === "/conversation-updated" && request.method === "POST") {
        const input = (await request.json()) as { conversationId: string };
        const conversation = await this.loadConversation(input.conversationId);
        await this.broadcastConversationUpdated(conversation);
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response("hub error", { status: 500 });
    }
  }

  private handleConnect(request: Request): Response {
    const kind = request.headers.get("x-kind");
    const userId = request.headers.get("x-user-id");
    if ((kind !== "AGENT" && kind !== "CONTACT") || !userId) {
      return new Response("missing x-kind/x-user-id", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const attachment: SocketAttachment = { kind, userId };
    server.serializeAttachment(attachment);
    if (kind === "AGENT") this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const attachment = this.readAttachment(ws);
    if (!attachment) return;
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed.type === "PING") {
      ws.send(JSON.stringify({ type: WS_EVENT.PONG }));
      return;
    }
    if (parsed.type === "TYPING") {
      await this.handleTyping(attachment, parsed.conversationId, parsed.state);
      return;
    }
    if (parsed.type === "READ") {
      await this.handleRead({ conversationId: parsed.conversationId, by: attachment.kind });
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const attachment = this.readAttachment(ws);
    if (attachment?.kind === "AGENT") this.broadcastPresence();
  }

  private readAttachment(ws: WebSocket): SocketAttachment | null {
    try {
      return (ws.deserializeAttachment() as SocketAttachment) ?? null;
    } catch {
      return null;
    }
  }

  private async getContactUserId(conversationId: string): Promise<string | null> {
    const cached = this.convContact.get(conversationId);
    if (cached) return cached;
    const row = await this.env.DB.prepare(
      `SELECT ct.user_id as userId FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id=?1`,
    )
      .bind(conversationId)
      .first<{ userId: string }>();
    if (!row) return null;
    this.convContact.set(conversationId, row.userId);
    return row.userId;
  }

  private async handleTyping(attachment: SocketAttachment, conversationId: string, state: "START" | "STOP") {
    const event = { type: WS_EVENT.TYPING, conversationId, from: attachment.kind, state };
    if (attachment.kind === "CONTACT") {
      this.emitToAgents(event);
    } else {
      const contactUserId = await this.getContactUserId(conversationId);
      this.emitToContact(event, contactUserId);
    }
  }

  private emitToAll(event: unknown, contactUserId: string | null) {
    const payload = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) {
      const attachment = this.readAttachment(ws);
      if (!attachment) continue;
      if (attachment.kind === "AGENT") ws.send(payload);
      else if (contactUserId && attachment.userId === contactUserId) ws.send(payload);
    }
  }

  private emitToAgents(event: unknown) {
    const payload = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) {
      if (this.readAttachment(ws)?.kind === "AGENT") ws.send(payload);
    }
  }

  private emitToContact(event: unknown, contactUserId: string | null) {
    if (!contactUserId) return;
    const payload = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) {
      const attachment = this.readAttachment(ws);
      if (attachment?.kind === "CONTACT" && attachment.userId === contactUserId) ws.send(payload);
    }
  }

  private broadcastToEveryone(event: unknown) {
    const payload = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) ws.send(payload);
  }

  private broadcastPresence() {
    let agentsOnline = 0;
    for (const ws of this.state.getWebSockets()) {
      if (this.readAttachment(ws)?.kind === "AGENT") agentsOnline++;
    }
    this.broadcastToEveryone({ type: WS_EVENT.PRESENCE, agentsOnline });
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

    let reopenMessageId: string | null = null;
    if (reopen) {
      reopenMessageId = uuidv7();
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
    await this.broadcast(out);

    if (reopenMessageId) {
      const reopenMessage = await this.loadMessage(reopenMessageId);
      await this.broadcast({ conversation, message: reopenMessage });
    }

    return out;
  }

  private async handleRead(input: { conversationId: string; by: "AGENT" | "CONTACT" }): Promise<void> {
    const column = input.by === "AGENT" ? "agent_last_read_at" : "contact_last_read_at";
    await this.env.DB.prepare(`UPDATE conversations SET ${column}=?1 WHERE id=?2`)
      .bind(now(), input.conversationId)
      .run();
    await this.broadcastRead(input.conversationId, input.by);
  }

  private async broadcast(out: MessageOut): Promise<void> {
    const contactUserId = await this.getContactUserId(out.conversation.id);
    this.emitToAll({ type: WS_EVENT.MESSAGE_CREATED, conversation: out.conversation, message: out.message }, contactUserId);
  }

  private async broadcastRead(conversationId: string, by: "AGENT" | "CONTACT"): Promise<void> {
    const contactUserId = await this.getContactUserId(conversationId);
    this.emitToAll({ type: WS_EVENT.READ_RECEIPT, conversationId, by, at: now() }, contactUserId);
  }

  private async broadcastConversationUpdated(conversation: ConversationRow): Promise<void> {
    const contactUserId = await this.getContactUserId(conversation.id);
    this.emitToAll({ type: WS_EVENT.CONVERSATION_UPDATED, conversation }, contactUserId);
  }
}
