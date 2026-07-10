import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware, requireAdmin } from "../middleware/auth";
import { DOMAIN } from "../common/const";
import { now, uuidv7 } from "../common/id";
import { isValidHostname, appZone } from "./host";
import type { HonoEnv } from "../common/hono-env";

// Linking a docs domain to a workspace. Saving the hostname is all the customer does in-app;
// the DNS records shown back are what they paste at their DNS provider. Actually provisioning
// the hostname on the Cloudflare-for-SaaS side is the provider's (our) manual step for now,
// which is why rows start PENDING_DNS and are flipped to ACTIVE out-of-band.

const DomainBody = z.object({
  hostname: z
    .string()
    .trim()
    .min(4, "Enter a full domain like docs.yourcompany.com")
    .max(253, "Domain is too long"),
});

type DomainRow = {
  id: string;
  hostname: string;
  status: string;
  verificationToken: string;
  createdAt: number;
};

const DOMAIN_COLUMNS = "id, hostname, status, verification_token as verificationToken, created_at as createdAt";

/** The records the domain owner pastes at their DNS provider. */
function dnsRecords(appUrl: string, hostname: string, verificationToken: string) {
  return [
    {
      type: "CNAME",
      name: hostname,
      value: `fallback.${appZone(appUrl)}`,
      note: "Routes your docs traffic to us (set Proxy/CDN off — DNS only)",
    },
    {
      type: "TXT",
      name: `_sp-verify.${hostname}`,
      value: verificationToken,
      note: "Proves you own the domain",
    },
  ];
}

function withRecords(appUrl: string, row: DomainRow) {
  const { verificationToken, ...domain } = row;
  return { ...domain, records: dnsRecords(appUrl, row.hostname, verificationToken) };
}

export const domainsApi = new Hono<HonoEnv>();
domainsApi.use("*", authMiddleware, wsMiddleware);

domainsApi.get("/kb/domains", async (c) => {
  const workspaceId = c.req.param("wsId");
  const { results } = await c.env.DB.prepare(
    `SELECT ${DOMAIN_COLUMNS} FROM custom_domains WHERE workspace_id=?1 ORDER BY created_at ASC`,
  )
    .bind(workspaceId)
    .all<DomainRow>();
  return ok(c, { domains: results.map((r) => withRecords(c.env.APP_URL, r)) });
});

domainsApi.post("/kb/domains", requireAdmin, validate(DomainBody), async (c) => {
  const workspaceId = c.req.param("wsId");
  const { hostname: raw } = c.get("body") as z.infer<typeof DomainBody>;
  const hostname = raw.toLowerCase();
  if (!isValidHostname(hostname)) {
    throw ctxErr.general.invalidRequestData({ msg: "Enter a full domain like docs.yourcompany.com" });
  }
  // Our own infra zone is off-limits (sp.hyugorix.com, fallback.hyugorix.com, ...).
  const zone = appZone(c.env.APP_URL);
  if (hostname === zone || hostname.endsWith(`.${zone}`)) {
    throw ctxErr.domain.reserved();
  }
  // Uniqueness is global (a hostname can serve exactly one workspace). The UNIQUE constraint
  // on custom_domains.hostname is the real guard; the pre-check just gives a friendly error.
  const existing = await c.env.DB.prepare("SELECT 1 FROM custom_domains WHERE hostname=?1")
    .bind(hostname)
    .first();
  if (existing) throw ctxErr.domain.alreadyUsed();

  const row: DomainRow = {
    id: uuidv7(),
    hostname,
    status: DOMAIN.STATUS.PENDING_DNS,
    verificationToken: crypto.randomUUID(),
    createdAt: now(),
  };
  try {
    await c.env.DB.prepare(
      `INSERT INTO custom_domains (id, workspace_id, hostname, verification_token, status, ssl_status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'CLOUDFLARE_SAAS', ?6)`,
    )
      .bind(row.id, workspaceId, row.hostname, row.verificationToken, row.status, row.createdAt)
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) throw ctxErr.domain.alreadyUsed();
    throw err;
  }
  return ok(c, { domain: withRecords(c.env.APP_URL, row) });
});

domainsApi.delete("/kb/domains/:id", requireAdmin, async (c) => {
  const workspaceId = c.req.param("wsId");
  const id = c.req.param("id");
  const result = await c.env.DB.prepare("DELETE FROM custom_domains WHERE id=?1 AND workspace_id=?2")
    .bind(id, workspaceId)
    .run();
  if (result.meta.changes === 0) throw ctxErr.domain.notFound();
  return ok(c, {});
});
