import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { ARTICLE } from "../common/const";
import { searchArticles } from "./search";
import type { HonoEnv } from "../common/hono-env";

const SearchQuery = z.object({ q: z.string().min(1).max(200) });

export const kbPublicApi = new Hono<HonoEnv>();

async function getWorkspaceBySlug(db: D1Database, wsSlug: string) {
  const workspace = await db
    .prepare("SELECT id, name, widget_color as widgetColor FROM workspaces WHERE slug=?1")
    .bind(wsSlug)
    .first<{ id: string; name: string; widgetColor: string }>();
  if (!workspace) throw ctxErr.workspace.notFound();
  return workspace;
}

kbPublicApi.get("/:wsSlug", async (c) => {
  const wsSlug = c.req.param("wsSlug");
  if (!wsSlug) throw ctxErr.workspace.notFound();
  const workspace = await getWorkspaceBySlug(c.env.DB, wsSlug);

  const { results: collections } = await c.env.DB.prepare(
    "SELECT id, name, slug, description FROM kb_collections WHERE workspace_id=?1 ORDER BY position ASC",
  )
    .bind(workspace.id)
    .all<{ id: string; name: string; slug: string; description: string }>();

  const { results: articles } = await c.env.DB.prepare(
    `SELECT id, collection_id as collectionId, title, slug FROM kb_articles
     WHERE workspace_id=?1 AND status=?2 ORDER BY title ASC`,
  )
    .bind(workspace.id, ARTICLE.STATUS.PUBLISHED)
    .all<{ id: string; collectionId: string | null; title: string; slug: string }>();

  const collectionsWithArticles = collections.map((col) => ({
    ...col,
    articles: articles.filter((a) => a.collectionId === col.id).map((a) => ({ title: a.title, slug: a.slug })),
  }));
  const uncategorized = articles.filter((a) => !a.collectionId).map((a) => ({ title: a.title, slug: a.slug }));

  return ok(c, {
    workspace: { name: workspace.name, widgetColor: workspace.widgetColor },
    collections: collectionsWithArticles,
    uncategorized,
  });
});

kbPublicApi.get("/:wsSlug/search", validate(SearchQuery, "query"), async (c) => {
  const wsSlug = c.req.param("wsSlug");
  if (!wsSlug) throw ctxErr.workspace.notFound();
  const workspace = await getWorkspaceBySlug(c.env.DB, wsSlug);
  const { q } = c.get("body") as z.infer<typeof SearchQuery>;
  const hits = await searchArticles(c.env.DB, workspace.id, q, 20);
  return ok(c, { results: hits });
});

kbPublicApi.get("/:wsSlug/articles/:slug", async (c) => {
  const wsSlug = c.req.param("wsSlug");
  if (!wsSlug) throw ctxErr.workspace.notFound();
  const slug = c.req.param("slug");
  if (!slug) throw ctxErr.kb.articleNotFound();
  const workspace = await getWorkspaceBySlug(c.env.DB, wsSlug);
  const article = await c.env.DB.prepare(
    `SELECT id, title, slug, body_md as bodyMd, published_at as publishedAt
     FROM kb_articles WHERE workspace_id=?1 AND slug=?2 AND status=?3`,
  )
    .bind(workspace.id, slug, ARTICLE.STATUS.PUBLISHED)
    .first();
  if (!article) throw ctxErr.kb.articleNotFound();
  return ok(c, { article });
});
