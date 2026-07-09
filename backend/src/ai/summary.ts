import { AI_CONF } from "../common/const";
import { now } from "../common/id";
import { ctxErr } from "../ctx/ctx.error";
import type { Env } from "../types";

const SYSTEM_PROMPT =
  "You summarize customer support conversations for an agent about to reply. Output exactly three labeled lines:\n" +
  "WANTS: what the customer wants\n" +
  "TRIED: what has been tried/answered so far\n" +
  "STATUS: current state and what should happen next.\n" +
  "Be specific and under 80 words total.";

type MessageRow = { senderType: string; bodyText: string };

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function buildUserPrompt(previousSummary: string | null, messages: MessageRow[]): string {
  const lines = messages.map((m) => `[${m.senderType}] ${clip(m.bodyText, 500)}`).join("\n");
  const prefix = previousSummary ? `Previous summary:\n${previousSummary}\n\n` : "";
  return `${prefix}Conversation (newest last):\n${lines}`;
}

function runWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("AI_TIMEOUT")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export type SummaryResult = { summary: string; generatedAt: number; cached: boolean };

export async function getConversationSummary(
  env: Env,
  workspaceId: string,
  conversationId: string,
  force: boolean,
): Promise<SummaryResult> {
  const conv = await env.DB.prepare(
    `SELECT message_count as messageCount, ai_summary as aiSummary,
            ai_summary_msg_count as aiSummaryMsgCount, updated_at as updatedAt
     FROM conversations WHERE id=?1 AND workspace_id=?2`,
  )
    .bind(conversationId, workspaceId)
    .first<{ messageCount: number; aiSummary: string | null; aiSummaryMsgCount: number; updatedAt: number }>();
  if (!conv) throw ctxErr.conversation.notFound();

  if (!force && conv.aiSummary && conv.aiSummaryMsgCount === conv.messageCount) {
    return { summary: conv.aiSummary, generatedAt: conv.updatedAt, cached: true };
  }

  const { results } = await env.DB.prepare(
    "SELECT sender_type as senderType, body_text as bodyText FROM messages WHERE conversation_id=?1 ORDER BY id DESC LIMIT ?2",
  )
    .bind(conversationId, AI_CONF.SUMMARY_WINDOW)
    .all<MessageRow>();
  const window = results.reverse();
  const userPrompt = buildUserPrompt(conv.aiSummary, window);

  let response: { response?: string };
  try {
    response = (await runWithTimeout(
      env.AI.run(AI_CONF.MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        max_tokens: AI_CONF.MAX_TOKENS,
      }),
      AI_CONF.TIMEOUT_MS,
    )) as { response?: string };
  } catch {
    throw ctxErr.ai.unavailable();
  }

  const summary = response.response?.trim();
  if (!summary) throw ctxErr.ai.unavailable();

  const ts = now();
  await env.DB.prepare("UPDATE conversations SET ai_summary=?1, ai_summary_msg_count=?2 WHERE id=?3 AND workspace_id=?4")
    .bind(summary, conv.messageCount, conversationId, workspaceId)
    .run();

  return { summary, generatedAt: ts, cached: false };
}
