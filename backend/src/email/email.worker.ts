import PostalMime from "postal-mime";
import { ingestInboundEmail, type InboundEmailInput } from "./inbound";
import type { Env } from "../types";

/** Cloudflare Email Routing catch-all handler on inbox.hyugorix.com. */
export async function handleEmailWorker(message: ForwardableEmailMessage, env: Env): Promise<void> {
  try {
    const parsed = await PostalMime.parse(message.raw);
    const input: InboundEmailInput = {
      to: message.to,
      from: message.from,
      fromName: parsed.from?.name || null,
      subject: parsed.subject ?? "",
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: parsed.references ? parsed.references.split(/\s+/).filter(Boolean) : [],
      text: parsed.text ?? "",
      html: parsed.html ?? null,
    };
    await ingestInboundEmail(env, input);
  } catch (e) {
    console.error("email() worker handler failed", e);
  }
}
