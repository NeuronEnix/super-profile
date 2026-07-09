import { ctxErr } from "../ctx/ctx.error";
import type { Env } from "../types";

export type EmailMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  replyTo?: string;
};

export type EmailSender = {
  send(m: EmailMessage): Promise<{ id: string | null }>;
};

export function resendSender(apiKey: string): EmailSender {
  return {
    async send(m: EmailMessage) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: m.from,
          to: [m.to],
          subject: m.subject,
          html: m.html,
          text: m.text,
          reply_to: m.replyTo,
          headers: m.headers,
        }),
      });
      if (!res.ok) {
        const info = await res.text().catch(() => "");
        throw ctxErr.email.sendFailed({ info: { status: res.status, body: info } });
      }
      const body = (await res.json()) as { id?: string };
      return { id: body.id ?? null };
    },
  };
}

export function logSender(): EmailSender {
  return {
    async send(m: EmailMessage) {
      console.log(
        JSON.stringify({ dev_email_send: true, from: m.from, to: m.to, subject: m.subject, headers: m.headers, text: m.text }),
      );
      return { id: null };
    },
  };
}

export function getSender(env: Env): EmailSender {
  return env.RESEND_API_KEY ? resendSender(env.RESEND_API_KEY) : logSender();
}
