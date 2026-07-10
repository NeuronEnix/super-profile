import { DOMAIN } from "../common/const";

// Custom-domain (Cloudflare for SaaS) host resolution. Customer hostnames like
// docs.customer.com reach this Worker through the zone-wide wildcard route + SaaS fallback
// origin, so the Host header is the only thing that says which workspace's public KB
// to serve. Everything here is read-only lookup — activation is a dashboard/DB concern.

export type KbDomain = { workspaceId: string; wsSlug: string; name: string; widgetColor: string };

export function normalizeHost(rawHost: string | undefined): string {
  return (rawHost ?? "").trim().toLowerCase().split(":")[0] ?? "";
}

/** Hosts that are the app itself (dashboard/widget/API) rather than a customer KB domain. */
export function isAppHost(host: string, appUrl: string): boolean {
  if (!host) return true; // no Host header — never treat as a customer domain
  if (host === new URL(appUrl).hostname) return true;
  if (host === "localhost" || host === "127.0.0.1") return true;
  return host.endsWith(".workers.dev");
}

export async function lookupKbDomain(db: D1Database, host: string): Promise<KbDomain | null> {
  if (!host) return null;
  return await db
    .prepare(
      `SELECT cd.workspace_id as workspaceId, w.slug as wsSlug, w.name, w.widget_color as widgetColor
       FROM custom_domains cd JOIN workspaces w ON w.id = cd.workspace_id
       WHERE cd.hostname = ?1 AND cd.status = ?2`,
    )
    .bind(host, DOMAIN.STATUS.ACTIVE)
    .first<KbDomain>();
}
