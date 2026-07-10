import { AI_CONF, CHANNEL, CONVERSATION, MESSAGE } from "../common/const";
import { getConfig } from "../config/env.config";
import { searchArticles, stripMarkdown } from "../kb/search";
import { sendMessage } from "../realtime/hub";
import { sendReply } from "../email/outbound";
import { publicKbBase } from "../domains/host";
import { buildKbQuery } from "./draft";
import { runWithTimeout } from "./summary";
import type { Env } from "../types";

/**
 * The autonomous handler behind "Delegate to AI": replies to the customer on its own,
 * grounded in published KB articles (linking them instead of pasting them), and escalates
 * back to the human assignee when the customer asks for a human or the KB can't answer.
 */

const ESCALATE_TOKEN = "ESCALATE";

export const FIRST_TURN_HINT =
  'If you\'d rather talk to a human at any point, just type "escalate to human".';

type MessageRow = { senderType: string; bodyText: string };
type KbArticle = { title: string; url: string; excerpt: string };

/** Customer explicitly asking for a person — escalate without burning an AI call. */
export function wantsHuman(text: string): boolean {
  return /\b(escalate\s+to\s+(a\s+)?human|(talk|speak|chat)\s+(to|with)\s+(a\s+|an\s+)?(human|agent|person|someone real)|real\s+(person|human)|human\s+(agent|support|being|please)|not\s+a\s+bot)\b/i.test(
    text,
  );
}

/** The model signals it can't help by replying with the bare escalation token. */
export function isEscalateResponse(response: string): boolean {
  return /^escalate\b/i.test(response.trim());
}

function systemPrompt(workspaceName: string): string {
  return (
    `You are handling a live customer support conversation for ${workspaceName} while the human agent is away. Rules:\n` +
    "- Reply like a busy, friendly human teammate: plain text, short and direct — 1-3 sentences unless steps are essential. " +
    "No sign-offs, and NEVER introduce yourself or say you are an AI or assistant.\n" +
    "- Only state facts found in the knowledge-base articles provided. The documentation map shows everything that exists — " +
    "when the customer's answer lives in a mapped article that isn't excerpted, share that article's URL. When an article answers the question, " +
    "give a one-or-two-line overview and include the article's URL so the customer can read the full steps — never paste the whole article.\n" +
    `- If the customer asks for a human, or the articles don't contain what you need to actually resolve the request, output exactly ${ESCALATE_TOKEN} and nothing else.`
  );
}

const SENDER_LABEL: Record<string, string> = {
  CONTACT: "CUSTOMER",
  AGENT: "AGENT",
  AI: "YOU",
  SYSTEM: "SYSTEM",
};

export function buildHandlerPrompt(messages: MessageRow[], articles: KbArticle[], digest?: string | null): string {
  const map = digest ? `Documentation map (everything available):\n${digest}\n\n` : "";
  const kb =
    articles.length > 0
      ? articles.map((a, i) => `[${i + 1}] ${a.title}\nURL: ${a.url}\n${a.excerpt}`).join("\n\n")
      : "(none available)";
  const transcript = messages
    .map((m) => `[${SENDER_LABEL[m.senderType] ?? m.senderType}] ${m.bodyText.slice(0, 500)}`)
    .join("\n");
  return (
    `${map}Knowledge base articles you can link to:\n${kb}\n\n` +
    `Conversation so far (newest last):\n${transcript}\n\n` +
    `Write your next chat reply to the customer, or output exactly ${ESCALATE_TOKEN}.`
  );
}

async function loadConversation(env: Env, workspaceId: string, conversationId: string) {
  return env.DB.prepare(
    `SELECT id, channel, status, assignee_id as assigneeId, contact_id as contactId,
            ai_handling as aiHandling
     FROM conversations WHERE id=?1 AND workspace_id=?2`,
  )
    .bind(conversationId, workspaceId)
    .first<{
      id: string;
      channel: string;
      status: string;
      assigneeId: string | null;
      contactId: string;
      aiHandling: number;
    }>();
}

async function postAiMessage(
  env: Env,
  workspace: { id: string; name: string; slug: string },
  conv: { id: string; channel: string; contactId: string },
  text: string,
): Promise<void> {
  const out = await sendMessage(env, {
    workspaceId: workspace.id,
    conversationId: conv.id,
    senderType: MESSAGE.SENDER_TYPE.AI,
    senderId: null,
    bodyText: text,
  });
  if (conv.channel === CHANNEL.EMAIL) {
    const contact = await env.DB.prepare("SELECT email FROM contacts WHERE id=?1")
      .bind(conv.contactId)
      .first<{ email: string | null }>();
    if (contact) {
      await sendReply(env, { workspace, conversation: out.conversation, contact, message: out.message });
    }
  }
}

async function escalate(
  env: Env,
  workspace: { id: string; name: string; slug: string },
  conv: { id: string; channel: string; contactId: string; assigneeId: string | null },
): Promise<void> {
  // Conditional write: if a human already took over (ai_handling flipped), do nothing.
  const res = await env.DB.prepare(
    "UPDATE conversations SET ai_handling=0, ai_escalated=1 WHERE id=?1 AND ai_handling=1",
  )
    .bind(conv.id)
    .run();
  if (!res.meta.changes) return;

  const assignee = conv.assigneeId
    ? await env.DB.prepare("SELECT name, email FROM users WHERE id=?1")
        .bind(conv.assigneeId)
        .first<{ name: string | null; email: string | null }>()
    : null;
  const name = assignee?.name ?? assignee?.email ?? "a teammate";

  await postAiMessage(env, workspace, conv, `Looping in ${name} to help with this — they'll pick it up from here.`);
  await sendMessage(env, {
    workspaceId: workspace.id,
    conversationId: conv.id,
    senderType: MESSAGE.SENDER_TYPE.SYSTEM,
    senderId: null,
    bodyText: `AI escalated to ${name}`,
  });
}

/**
 * One autonomous AI turn. Called after each CONTACT message in a delegated conversation and
 * once right after delegation (firstTurn). Never throws — an AI failure must not break the
 * customer's message path; it escalates instead so the conversation is never silently stuck.
 */
export async function runAiTurn(
  env: Env,
  workspaceId: string,
  conversationId: string,
  opts: { firstTurn?: boolean } = {},
): Promise<void> {
  try {
    const conv = await loadConversation(env, workspaceId, conversationId);
    if (!conv || !conv.aiHandling || conv.status === CONVERSATION.STATUS.RESOLVED) return;

    const workspace = await env.DB.prepare("SELECT id, name, slug, kb_digest as kbDigest FROM workspaces WHERE id=?1")
      .bind(workspaceId)
      .first<{ id: string; name: string; slug: string; kbDigest: string | null }>();
    if (!workspace) return;

    const { results } = await env.DB.prepare(
      "SELECT sender_type as senderType, body_text as bodyText FROM messages WHERE conversation_id=?1 ORDER BY id DESC LIMIT ?2",
    )
      .bind(conversationId, AI_CONF.HANDLER.WINDOW)
      .all<MessageRow>();
    const window = results.reverse();

    const lastCustomer = [...window].reverse().find((m) => m.senderType === MESSAGE.SENDER_TYPE.CONTACT);
    if (!opts.firstTurn && lastCustomer && wantsHuman(lastCustomer.bodyText)) {
      await escalate(env, workspace, conv);
      return;
    }

    const query = buildKbQuery(window);
    const hits = query ? await searchArticles(env.DB, workspaceId, query, AI_CONF.HANDLER.KB_TOP_K) : [];
    let articles: KbArticle[] = [];
    if (hits.length > 0) {
      const placeholders = hits.map((_, i) => `?${i + 2}`).join(",");
      const { results: rows } = await env.DB.prepare(
        `SELECT id, title, slug, body_md as bodyMd FROM kb_articles WHERE workspace_id=?1 AND id IN (${placeholders})`,
      )
        .bind(workspaceId, ...hits.map((h) => h.id))
        .all<{ id: string; title: string; slug: string; bodyMd: string }>();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const kbBase = await publicKbBase(env.DB, workspaceId, workspace.slug, getConfig(env).APP_URL);
      articles = hits
        .map((h) => byId.get(h.id))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => ({
          title: r.title,
          url: `${kbBase}/a/${r.slug}`,
          excerpt: stripMarkdown(r.bodyMd).slice(0, AI_CONF.HANDLER.KB_SNIPPET_CHARS),
        }));
    }

    let reply: string;
    try {
      const response = (await runWithTimeout(
        env.AI.run(AI_CONF.MODEL, {
          messages: [
            { role: "system", content: systemPrompt(workspace.name) },
            { role: "user", content: buildHandlerPrompt(window, articles, workspace.kbDigest) },
          ],
          max_tokens: AI_CONF.HANDLER.MAX_TOKENS,
        }),
        AI_CONF.TIMEOUT_MS,
      )) as { response?: string };
      reply = response.response?.trim() ?? "";
    } catch {
      reply = "";
    }

    if (!reply || isEscalateResponse(reply)) {
      await escalate(env, workspace, conv);
      return;
    }

    // Re-check before posting: the human may have taken over while we were generating.
    const fresh = await loadConversation(env, workspaceId, conversationId);
    if (!fresh?.aiHandling) return;

    const text = opts.firstTurn ? `${reply}\n\n${FIRST_TURN_HINT}` : reply;
    await postAiMessage(env, workspace, conv, text);
  } catch (e) {
    console.error("ai turn failed", e);
  }
}

/** Fire-and-forget trigger used by the contact-message paths (widget + inbound email). */
export function triggerAiTurn(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  out: { conversation: { id: string; workspaceId: string; aiHandling?: number } },
): void {
  if (!out.conversation.aiHandling) return;
  waitUntil(runAiTurn(env, out.conversation.workspaceId, out.conversation.id));
}
