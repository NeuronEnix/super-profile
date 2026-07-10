import { AI_CONF, MESSAGE } from "../common/const";
import { ctxErr } from "../ctx/ctx.error";
import { searchArticles, stripMarkdown, type ArticleSearchHit } from "../kb/search";
import { runWithTimeout } from "./summary";
import type { Env } from "../types";

const SYSTEM_PROMPT =
  "You draft a reply for a customer support agent to send to a customer. " +
  "Warm, professional and concise; plain text only — no markdown, no subject line, no greeting-name placeholders, no signature. " +
  "Ground every factual claim (features, steps, prices, policies) in the knowledge-base excerpts provided. " +
  "If the excerpts don't cover the customer's question, write an honest reply that asks a clarifying question " +
  "or says you'll look into it — never invent product facts. " +
  "Under 120 words. Output only the reply body.";

type MessageRow = { senderType: string; bodyText: string };
type ArticleRow = ArticleSearchHit & { bodyMd: string };

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The FTS query is built from what the CUSTOMER said (their last few messages, newest first) —
 * agent/system lines would only add noise to article matching.
 */
export function buildKbQuery(messages: MessageRow[]): string {
  const contactText = messages
    .filter((m) => m.senderType === MESSAGE.SENDER_TYPE.CONTACT)
    .slice(-3)
    .reverse()
    .map((m) => m.bodyText)
    .join(" ");
  return clip(contactText.replace(/\s+/g, " ").trim(), AI_CONF.DRAFT.QUERY_CHARS);
}

export function buildDraftPrompt(messages: MessageRow[], articles: { title: string; excerpt: string }[]): string {
  const kb =
    articles.length > 0
      ? articles.map((a, i) => `[${i + 1}] ${a.title}\n${a.excerpt}`).join("\n\n")
      : "(none found — do not invent facts)";
  const transcript = messages.map((m) => `[${m.senderType}] ${clip(m.bodyText, 500)}`).join("\n");
  return (
    `Knowledge base excerpts:\n${kb}\n\n` +
    `Conversation (newest last):\n${transcript}\n\n` +
    "Draft the agent's next reply to the customer."
  );
}

export type DraftResult = { draft: string; sources: ArticleSearchHit[] };

export async function suggestReply(env: Env, workspaceId: string, conversationId: string): Promise<DraftResult> {
  const conv = await env.DB.prepare("SELECT id FROM conversations WHERE id=?1 AND workspace_id=?2")
    .bind(conversationId, workspaceId)
    .first<{ id: string }>();
  if (!conv) throw ctxErr.conversation.notFound();

  const { results } = await env.DB.prepare(
    "SELECT sender_type as senderType, body_text as bodyText FROM messages WHERE conversation_id=?1 ORDER BY id DESC LIMIT ?2",
  )
    .bind(conversationId, AI_CONF.DRAFT.WINDOW)
    .all<MessageRow>();
  const window = results.reverse();

  const query = buildKbQuery(window);
  const hits = query ? await searchArticles(env.DB, workspaceId, query, AI_CONF.DRAFT.KB_TOP_K) : [];

  let articles: { title: string; excerpt: string }[] = [];
  if (hits.length > 0) {
    const placeholders = hits.map((_, i) => `?${i + 2}`).join(",");
    const { results: rows } = await env.DB.prepare(
      `SELECT id, title, slug, body_md as bodyMd FROM kb_articles WHERE workspace_id=?1 AND id IN (${placeholders})`,
    )
      .bind(workspaceId, ...hits.map((h) => h.id))
      .all<ArticleRow>();
    // Preserve bm25 relevance order from the search, not the arbitrary IN() order.
    const byId = new Map(rows.map((r) => [r.id, r]));
    articles = hits
      .map((h) => byId.get(h.id))
      .filter((r): r is ArticleRow => !!r)
      .map((r) => ({ title: r.title, excerpt: clip(stripMarkdown(r.bodyMd), AI_CONF.DRAFT.KB_SNIPPET_CHARS) }));
  }

  let response: { response?: string };
  try {
    response = (await runWithTimeout(
      env.AI.run(AI_CONF.MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildDraftPrompt(window, articles) },
        ],
        max_tokens: AI_CONF.DRAFT.MAX_TOKENS,
      }),
      AI_CONF.TIMEOUT_MS,
    )) as { response?: string };
  } catch {
    throw ctxErr.ai.unavailable();
  }

  const draft = response.response?.trim();
  if (!draft) throw ctxErr.ai.unavailable();

  return { draft, sources: hits };
}
