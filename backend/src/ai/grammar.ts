import { AI_CONF } from "../common/const";
import { ctxErr } from "../ctx/ctx.error";
import { runWithTimeout } from "./summary";
import type { Env } from "../types";

const SYSTEM_PROMPT =
  "You are a copy editor for a customer support agent's reply. " +
  "Fix grammar, spelling, punctuation and capitalization ONLY. Always: " +
  "capitalize the first letter of every sentence, including after each period, question mark or exclamation mark; " +
  "capitalize proper nouns (people's names, products) and the word 'I', but never capitalize any other mid-sentence word; " +
  "add missing punctuation — end each sentence with a period (or fitting mark), add clearly needed apostrophes (\"dont\" -> \"don't\"), " +
  "and when a comma splices two complete sentences, replace it with a period and capitalize the next word. " +
  "Keep the author's wording, tone, meaning, line breaks and length — never rephrase, add or remove content beyond those corrections. " +
  "If the text is already correct, return it unchanged. " +
  "Output only the corrected text, with no preamble, quotes or explanation.";

export async function correctGrammar(env: Env, text: string): Promise<string> {
  let response: { response?: string };
  try {
    response = (await runWithTimeout(
      env.AI.run(AI_CONF.MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        max_tokens: AI_CONF.GRAMMAR.MAX_TOKENS,
      }),
      AI_CONF.TIMEOUT_MS,
    )) as { response?: string };
  } catch {
    throw ctxErr.ai.unavailable();
  }

  const corrected = response.response?.trim();
  if (!corrected) throw ctxErr.ai.unavailable();
  return corrected;
}
