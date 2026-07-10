import { Hono } from "hono";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { ingestInboundEmail, type InboundEmailInput } from "./inbound";
import type { HonoEnv } from "../common/hono-env";

type SimulatorPayload = {
  to: string;
  from: string;
  fromName?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  text: string;
  html?: string;
};

type ResendInboundPayload = {
  type?: string;
  data: {
    to?: Array<{ email: string }> | string;
    from?: { email: string; name?: string } | string;
    subject?: string;
    headers?: Record<string, string>;
    text?: string;
    html?: string;
  };
};

function isSimulatorPayload(body: unknown): body is SimulatorPayload {
  const b = body as Record<string, unknown>;
  return typeof b?.to === "string" && typeof b?.from === "string" && typeof b?.text === "string";
}

function isResendInboundPayload(body: unknown): body is ResendInboundPayload {
  const b = body as Record<string, unknown>;
  return typeof b?.data === "object" && b.data !== null;
}

function normalizeInboundPayload(body: unknown): InboundEmailInput | null {
  if (isSimulatorPayload(body)) {
    return {
      to: body.to,
      from: body.from,
      fromName: body.fromName ?? null,
      subject: body.subject ?? "",
      messageId: body.messageId ?? null,
      inReplyTo: body.inReplyTo ?? null,
      references: body.references ?? [],
      text: body.text,
      html: body.html ?? null,
    };
  }
  if (isResendInboundPayload(body)) {
    const d = body.data;
    const to = Array.isArray(d.to) ? (d.to[0]?.email ?? "") : (d.to ?? "");
    const from = typeof d.from === "string" ? d.from : (d.from?.email ?? "");
    const fromName = typeof d.from === "object" ? (d.from?.name ?? null) : null;
    const headers = d.headers ?? {};
    const references = (headers["References"] ?? headers["references"] ?? "")
      .split(/\s+/)
      .filter(Boolean);
    return {
      to,
      from,
      fromName,
      subject: d.subject ?? "",
      messageId: headers["Message-ID"] ?? headers["message-id"] ?? null,
      inReplyTo: headers["In-Reply-To"] ?? headers["in-reply-to"] ?? null,
      references,
      text: d.text ?? "",
      html: d.html ?? null,
    };
  }
  return null;
}

export const emailApi = new Hono<HonoEnv>();

emailApi.post("/inbound", async (c) => {
  const secret = c.req.header("X-Inbound-Secret");
  if (!secret || secret !== c.env.EMAIL_INBOUND_SECRET) throw ctxErr.email.invalidInbound();

  const body = await c.req.json().catch(() => null);
  const parsed = body ? normalizeInboundPayload(body) : null;
  if (!parsed || !parsed.to || !parsed.from) throw ctxErr.email.invalidInbound();

  const result = await ingestInboundEmail(c.env, parsed);
  if (result === null) {
    // A silent 200 here hides typos in the workspace slug from whoever drives the simulator.
    throw ctxErr.email.invalidInbound({ msg: "No workspace matches that inbound address" });
  }
  if ("duplicate" in result) return ok(c, { duplicate: true });
  return ok(c);
});
