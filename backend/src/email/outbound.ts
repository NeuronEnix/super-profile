import { getSender } from "./sender";
import { escapeHtml } from "../common/html";
import { sendMessage } from "../realtime/hub";
import type { ConversationRow, MessageRow } from "../realtime/hub";
import type { Env } from "../types";

export type ReplyContext = {
  workspace: { id: string; name: string; slug: string };
  conversation: ConversationRow;
  contact: { email: string | null };
  message: MessageRow;
};

async function buildReferenceChain(env: Env, conversationId: string, limit = 10): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT email_message_id as id FROM messages
     WHERE conversation_id=?1 AND email_message_id IS NOT NULL
     ORDER BY id ASC`,
  )
    .bind(conversationId)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  return ids.slice(Math.max(0, ids.length - limit));
}

async function lastInboundMessageId(env: Env, conversationId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT email_message_id as id FROM messages
     WHERE conversation_id=?1 AND sender_type='CONTACT' AND email_message_id IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(conversationId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Sends the agent's EMAIL-channel reply via Resend; on failure, logs a SYSTEM message via the DO. */
export async function sendReply(env: Env, ctx: ReplyContext): Promise<void> {
  if (!ctx.contact.email) return;

  const ourMessageId = `<m-${ctx.message.id}@${env.SEND_DOMAIN}>`;
  const inReplyTo = await lastInboundMessageId(env, ctx.conversation.id);
  const references = await buildReferenceChain(env, ctx.conversation.id);

  try {
    await getSender(env).send({
      from: `"${ctx.workspace.name}" <${ctx.workspace.slug}@${env.SEND_DOMAIN}>`,
      to: ctx.contact.email,
      subject: `Re: ${ctx.conversation.subject ?? ""}`,
      replyTo: `${ctx.workspace.slug}+${ctx.conversation.id}@${env.INBOUND_DOMAIN}`,
      text: ctx.message.bodyText,
      html: `<p>${escapeHtml(ctx.message.bodyText).replace(/\n/g, "<br>")}</p>`,
      headers: {
        "Message-ID": ourMessageId,
        ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
        ...(references.length ? { References: references.join(" ") } : {}),
      },
    });
    await env.DB.prepare("UPDATE messages SET email_message_id=?1 WHERE id=?2")
      .bind(ourMessageId, ctx.message.id)
      .run();
  } catch (e) {
    console.error("outbound email send failed", e);
    await sendMessage(env, {
      workspaceId: ctx.workspace.id,
      conversationId: ctx.conversation.id,
      senderType: "SYSTEM",
      senderId: null,
      bodyText: "⚠ Email delivery failed",
    });
  }
}
