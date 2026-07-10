import { now } from "../common/id";
import { upsertUserByEmail } from "../users/users.service";
import { resolveContact } from "../contacts/contacts.service";
import { sendMessage, type MessageOut } from "../realtime/hub";
import type { Env } from "../types";

export function parseInboundAddress(
  to: string,
  inboundDomain: string,
): { wsSlug: string; conversationId: string | null } | null {
  const bracketed = to.match(/<([^<>]+)>/);
  const email = (bracketed ? bracketed[1] : to).trim().toLowerCase();
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return null;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (domain !== inboundDomain.toLowerCase()) return null;
  const plusIndex = local.indexOf("+");
  if (plusIndex === -1) return { wsSlug: local, conversationId: null };
  return { wsSlug: local.slice(0, plusIndex), conversationId: local.slice(plusIndex + 1) };
}

export function stripSubjectPrefix(subject: string): string {
  let s = subject.trim();
  while (/^(re|fwd?)\s*:\s*/i.test(s)) {
    s = s.replace(/^(re|fwd?)\s*:\s*/i, "").trim();
  }
  return s;
}

export type ThreadLookup = {
  validateConversationInWorkspace: (conversationId: string) => Promise<boolean>;
  findConversationByMessageIds: (messageIds: string[]) => Promise<string | null>;
};

/** Plus-address wins; else In-Reply-To/References header match; else null (new conversation). */
export async function resolveThreadConversationId(
  input: { conversationId: string | null; inReplyTo: string | null; references: string[] },
  lookup: ThreadLookup,
): Promise<string | null> {
  if (input.conversationId) {
    const valid = await lookup.validateConversationInWorkspace(input.conversationId);
    if (valid) return input.conversationId;
  }
  const candidates = [input.inReplyTo, ...input.references].filter((x): x is string => !!x);
  if (candidates.length === 0) return null;
  return lookup.findConversationByMessageIds(candidates);
}

export type InboundEmailInput = {
  to: string;
  from: string;
  fromName: string | null;
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string;
  html: string | null;
};

export type InboundResult = MessageOut | { duplicate: true } | null;

export async function ingestInboundEmail(env: Env, parsed: InboundEmailInput): Promise<InboundResult> {
  const addr = parseInboundAddress(parsed.to, env.INBOUND_DOMAIN);
  if (!addr) {
    console.log(JSON.stringify({ inbound_drop: true, reason: "address_no_match", to: parsed.to }));
    return null;
  }

  const workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE slug=?1")
    .bind(addr.wsSlug)
    .first<{ id: string }>();
  if (!workspace) {
    console.log(JSON.stringify({ inbound_drop: true, reason: "unknown_workspace", slug: addr.wsSlug }));
    return null;
  }

  // Webhook transports retry deliveries — the same Message-ID arriving twice must not create a
  // duplicate message. Treated as success (idempotent), not an error.
  if (parsed.messageId) {
    const dupe = await env.DB.prepare(
      "SELECT 1 FROM messages WHERE workspace_id=?1 AND email_message_id=?2 LIMIT 1",
    )
      .bind(workspace.id, parsed.messageId)
      .first();
    if (dupe) {
      console.log(JSON.stringify({ inbound_drop: true, reason: "duplicate_message_id", messageId: parsed.messageId }));
      return { duplicate: true };
    }
  }

  const ts = now();
  const user = await upsertUserByEmail(env.DB, parsed.from);
  // Inbound mail proves the sender owns this address — verified identity per the identity rules.
  const contact = await resolveContact(env.DB, workspace.id, user.id, parsed.from, parsed.fromName, ts, {
    verifiedEmail: true,
  });

  const conversationId = await resolveThreadConversationId(
    { conversationId: addr.conversationId, inReplyTo: parsed.inReplyTo, references: parsed.references },
    {
      validateConversationInWorkspace: async (id) => {
        const row = await env.DB.prepare("SELECT 1 FROM conversations WHERE id=?1 AND workspace_id=?2")
          .bind(id, workspace.id)
          .first();
        return !!row;
      },
      findConversationByMessageIds: async (ids) => {
        const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
        const row = await env.DB.prepare(
          `SELECT conversation_id as conversationId FROM messages WHERE workspace_id=?1 AND email_message_id IN (${placeholders}) LIMIT 1`,
        )
          .bind(workspace.id, ...ids)
          .first<{ conversationId: string }>();
        return row?.conversationId ?? null;
      },
    },
  );

  return sendMessage(env, {
    workspaceId: workspace.id,
    ...(conversationId
      ? { conversationId }
      : {
          newConversation: {
            contactId: contact.id,
            channel: "EMAIL",
            subject: stripSubjectPrefix(parsed.subject || "(no subject)"),
          },
        }),
    senderType: "CONTACT",
    senderId: user.id,
    bodyText: parsed.text,
    bodyHtml: parsed.html,
    emailMessageId: parsed.messageId,
    emailInReplyTo: parsed.inReplyTo,
  });
}
