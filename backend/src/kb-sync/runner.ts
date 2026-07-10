import { AI_CONF, KB_SYNC } from "../common/const";
import { getConfig } from "../config/env.config";
import { now, uuidv7 } from "../common/id";
import { runWithTimeout } from "../ai/summary";
import { publicKbBase } from "../domains/host";
import {
  cooldownRemainingMs, deriveCollectionName, extractLinks, extractMainContent, finalOutcome,
  htmlToMarkdown, humanizeMs, inScope, isBlockedResponse, nextBatch, type DocsSource,
} from "./crawl";
import { buildGistPrompt, composeDigest, parseGists, type DigestArticle } from "./digest";
import { upsertImportedArticle } from "./import.service";
import type { Env } from "../types";

export async function regenerateDigest(env: Env, workspaceId: string): Promise<void> {
  const ws = await env.DB.prepare("SELECT slug FROM workspaces WHERE id=?1")
    .bind(workspaceId)
    .first<{ slug: string }>();
  if (!ws) return;
  const { results } = await env.DB.prepare(
    `SELECT a.title as title, a.slug as slug, a.body_text as bodyText, c.name as collection
     FROM kb_articles a LEFT JOIN kb_collections c ON c.id = a.collection_id
     WHERE a.workspace_id=?1 AND a.status='PUBLISHED'
     ORDER BY COALESCE(c.position, 999), a.title LIMIT ?2`,
  )
    .bind(workspaceId, AI_CONF.DIGEST.MAX_ARTICLES)
    .all<{ title: string; slug: string; bodyText: string; collection: string | null }>();
  if (results.length === 0) return;
  const articles: DigestArticle[] = results.map((r) => ({
    title: r.title,
    slug: r.slug,
    collection: r.collection,
    excerpt: r.bodyText.slice(0, AI_CONF.DIGEST.PER_ARTICLE_EXCERPT),
  }));
  let gists = new Map<number, string>();
  try {
    const response = (await runWithTimeout(
      env.AI.run(AI_CONF.MODEL, {
        messages: [{ role: "user", content: buildGistPrompt(articles) }],
        max_tokens: AI_CONF.DIGEST.MAX_TOKENS,
      }),
      AI_CONF.TIMEOUT_MS,
    )) as { response?: string };
    gists = parseGists(response.response ?? "", articles.length);
  } catch {
    // AI down → fallback digest of titles + urls only, still useful
  }
  const base = await publicKbBase(env.DB, workspaceId, ws.slug, getConfig(env).APP_URL);
  const digest = composeDigest(articles, gists, base, AI_CONF.DIGEST.CHAR_CAP);
  await env.DB.prepare("UPDATE workspaces SET kb_digest=?1, kb_digest_at=?2 WHERE id=?3")
    .bind(digest, now(), workspaceId)
    .run();
}

type Job = {
  workspaceId: string;
  requestedBy: string;
  source: DocsSource;
  frontier: string[];
  visited: string[];
  imported: number;
  failed: number;
  blockedStreak: number;
  blockedTotal: number;
  alarmRetries: number;
  sitemapTried: boolean;
};

/**
 * One instance per workspace (idFromName(workspaceId)). Single-threaded by the DO model, so
 * parallel Sync clicks serialize and the cooldown/running check below is race-free. The crawl
 * runs as an alarm loop — small batches, fresh subrequest budget each firing, progress persisted.
 */
export class KbSyncRunner {
  private ctx: DurableObjectState;
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/start" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const { workspaceId, userId, source } = (await request.json()) as {
      workspaceId: string;
      userId: string;
      source: DocsSource;
    };
    const ts = now();
    const row = await this.env.DB.prepare(
      "SELECT status, started_at as startedAt, last_synced_at as lastSyncedAt FROM kb_sync_sources WHERE workspace_id=?1",
    )
      .bind(workspaceId)
      .first<{ status: string; startedAt: number | null; lastSyncedAt: number | null }>();

    if (row?.status === KB_SYNC.STATUS.RUNNING && row.startedAt && ts - row.startedAt < KB_SYNC.STALE_RUNNING_MS) {
      return Response.json(
        { error: { name: "KB_SYNC_ALREADY_RUNNING", msg: "A sync is already in progress" } },
        { status: 409 },
      );
    }
    const remaining = cooldownRemainingMs(
      row?.lastSyncedAt ?? null,
      getConfig(this.env).KB_SYNC_COOLDOWN_MIN,
      ts,
    );
    if (remaining > 0) {
      return Response.json(
        { error: { name: "KB_SYNC_COOLDOWN", msg: `You can sync again in ${humanizeMs(remaining)}` } },
        { status: 409 },
      );
    }

    const job: Job = {
      workspaceId, requestedBy: userId, source,
      frontier: [source.startUrl], visited: [],
      imported: 0, failed: 0, blockedStreak: 0, blockedTotal: 0, alarmRetries: 0, sitemapTried: false,
    };
    await this.ctx.storage.put("job", job);
    await this.env.DB.prepare(
      `INSERT INTO kb_sync_sources
         (id, workspace_id, url, status, pages_found, pages_imported, pages_failed, error,
          requested_by, started_at, last_synced_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, 0, 0, NULL, ?5, ?6, NULL, ?6, ?6)
       ON CONFLICT(workspace_id) DO UPDATE SET
         url=?3, status=?4, pages_found=0, pages_imported=0, pages_failed=0, error=NULL,
         requested_by=?5, started_at=?6, updated_at=?6`,
    )
      .bind(uuidv7(), workspaceId, source.startUrl, KB_SYNC.STATUS.RUNNING, userId, ts)
      .run();
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<Job>("job");
    if (!job) return;
    try {
      await this.runBatch(job);
    } catch (e) {
      job.alarmRetries += 1;
      await this.ctx.storage.put("job", job);
      if (job.alarmRetries >= 3) {
        await this.finalize(job, KB_SYNC.STATUS.FAILED, `Sync crashed: ${String(e).slice(0, 300)}`);
        return;
      }
      throw e; // let the runtime's alarm retry take it from here
    }
  }

  private async runBatch(job: Job): Promise<void> {
    if (!job.sitemapTried) {
      job.sitemapTried = true;
      try {
        const res = await this.fetchPage(`${job.source.origin}/sitemap.xml`);
        if (res.ok) {
          const xml = await res.text();
          const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
          for (const loc of locs) {
            const clean = loc.replace(/\/+$/, "");
            if (inScope(clean, job.source) && !job.frontier.includes(clean) && !job.visited.includes(clean)) {
              job.frontier.push(clean);
            }
          }
        }
      } catch {
        // no sitemap — BFS discovers links instead
      }
    }

    const count = nextBatch(job.frontier, job.visited.length, job.imported);
    for (let i = 0; i < count; i++) {
      const url = job.frontier.shift();
      if (!url || job.visited.includes(url)) continue;
      job.visited.push(url);
      try {
        const res = await this.fetchPage(url);
        const bodySnippet = res.ok || res.status === 403 || res.status === 429 ? await res.text() : "";
        if (isBlockedResponse(res.status, (n) => res.headers.get(n), bodySnippet)) {
          job.failed += 1;
          job.blockedStreak += 1;
          job.blockedTotal += 1;
          if (job.blockedStreak >= KB_SYNC.BLOCKED_STREAK_LIMIT) {
            await this.finalize(job, KB_SYNC.STATUS.FAILED, KB_SYNC.BLOCKED_MSG);
            return;
          }
          continue;
        }
        job.blockedStreak = 0;
        if (!res.ok) {
          job.failed += 1;
          continue;
        }
        if (!(res.headers.get("content-type") ?? "").includes("text/html")) continue;
        const html = bodySnippet;
        if (html.length > KB_SYNC.MAX_HTML_BYTES) continue;
        const finalUrl = (res.url || url).replace(/\/+$/, "") || url;
        if (!inScope(finalUrl, job.source)) continue;

        for (const link of extractLinks(html, finalUrl)) {
          if (inScope(link, job.source) && !job.visited.includes(link) && !job.frontier.includes(link)) {
            job.frontier.push(link);
          }
        }

        const { title, contentHtml } = extractMainContent(html);
        const md = htmlToMarkdown(contentHtml);
        if (md.length < KB_SYNC.MIN_CONTENT_CHARS) continue;
        await upsertImportedArticle(this.env, {
          workspaceId: job.workspaceId,
          requestedBy: job.requestedBy,
          sourceUrl: finalUrl,
          title,
          bodyMd: md,
          collectionName: deriveCollectionName(finalUrl, job.source),
        });
        job.imported += 1;
      } catch {
        job.failed += 1;
      }
    }

    await this.writeProgress(job);
    if (nextBatch(job.frontier, job.visited.length, job.imported) === 0) {
      const outcome = finalOutcome(job.imported, job.blockedTotal);
      await this.finalize(job, outcome.status, outcome.error);
      return;
    }
    await this.ctx.storage.put("job", job);
    await this.ctx.storage.setAlarm(Date.now() + 250);
  }

  private fetchPage(url: string): Promise<Response> {
    return fetch(url, {
      headers: { "User-Agent": KB_SYNC.USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(KB_SYNC.FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  }

  private async writeProgress(job: Job): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE kb_sync_sources SET pages_found=?1, pages_imported=?2, pages_failed=?3, updated_at=?4 WHERE workspace_id=?5",
    )
      .bind(job.visited.length, job.imported, job.failed, now(), job.workspaceId)
      .run();
  }

  private async finalize(job: Job, status: string, error: string | null): Promise<void> {
    if (status === KB_SYNC.STATUS.DONE) {
      try {
        await regenerateDigest(this.env, job.workspaceId);
      } catch (e) {
        console.error("digest generation failed", e);
      }
    }
    const ts = now();
    await this.env.DB.prepare(
      `UPDATE kb_sync_sources SET status=?1, error=?2, pages_found=?3, pages_imported=?4, pages_failed=?5,
         last_synced_at=CASE WHEN ?1='DONE' THEN ?6 ELSE last_synced_at END, updated_at=?6
       WHERE workspace_id=?7`,
    )
      .bind(status, error, job.visited.length, job.imported, job.failed, ts, job.workspaceId)
      .run();
    await this.ctx.storage.deleteAll();
  }
}
