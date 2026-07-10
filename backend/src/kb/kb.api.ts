import { Hono } from "hono";
import { z } from "zod";
import { ok } from "../common/envelope";
import { ctxErr } from "../ctx/ctx.error";
import { validate } from "../middleware/validate";
import { authMiddleware, wsMiddleware } from "../middleware/auth";
import { ARTICLE } from "../common/const";
import { now, uuidv7 } from "../common/id";
import { slugify, randomSuffix, ARTICLE_SLUG_REGEX } from "../common/slug";
import { stripMarkdown } from "./search";
import type { HonoEnv } from "../common/hono-env";

const CollectionBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});
const CollectionPatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  position: z.number().int().optional(),
});

const ArticleBody = z.object({
  title: z.string().min(1).max(200),
  collectionId: z.string().nullable().optional(),
  bodyMd: z.string().max(200_000).optional(),
});
const ArticlePatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  collectionId: z.string().nullable().optional(),
  bodyMd: z.string().max(200_000).optional(),
  slug: z
    .string()
    .min(5)
    .max(100)
    .regex(
      ARTICLE_SLUG_REGEX,
      "Slug must be 5–100 characters: lowercase letters, numbers and hyphens only, no leading or trailing hyphen",
    )
    .optional(),
  status: z.enum([ARTICLE.STATUS.DRAFT, ARTICLE.STATUS.PUBLISHED]).optional(),
});

export async function uniqueSlug(
  db: D1Database,
  table: "kb_collections" | "kb_articles",
  workspaceId: string,
  base: string,
): Promise<string> {
  const slugBase = slugify(base);
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? slugBase : `${slugBase}-${randomSuffix()}`;
    const existing = await db
      .prepare(`SELECT 1 FROM ${table} WHERE workspace_id=?1 AND slug=?2`)
      .bind(workspaceId, candidate)
      .first();
    if (!existing) return candidate;
  }
  return `${slugBase}-${randomSuffix()}`;
}

export const kbApi = new Hono<HonoEnv>();
kbApi.use("*", authMiddleware, wsMiddleware);

// --- Collections ---

kbApi.post("/kb/collections", validate(CollectionBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const { name, description } = c.get("body") as z.infer<typeof CollectionBody>;
  const id = uuidv7();
  const slug = await uniqueSlug(c.env.DB, "kb_collections", workspaceId, name);
  const ts = now();
  const { count } = (await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM kb_collections WHERE workspace_id=?1",
  )
    .bind(workspaceId)
    .first<{ count: number }>()) ?? { count: 0 };
  await c.env.DB.prepare(
    "INSERT INTO kb_collections (id, workspace_id, name, slug, description, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, workspaceId, name, slug, description ?? "", count, ts)
    .run();
  return ok(c, { collection: { id, name, slug, description: description ?? "", position: count } });
});

kbApi.get("/kb/collections", async (c) => {
  const { workspaceId } = c.get("member");
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, slug, description, position FROM kb_collections WHERE workspace_id=?1 ORDER BY position ASC",
  )
    .bind(workspaceId)
    .all();
  return ok(c, { collections: results });
});

kbApi.patch("/kb/collections/:id", validate(CollectionPatchBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const patch = c.get("body") as z.infer<typeof CollectionPatchBody>;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.name !== undefined) {
    binds.push(patch.name);
    sets.push(`name=?${binds.length}`);
  }
  if (patch.description !== undefined) {
    binds.push(patch.description);
    sets.push(`description=?${binds.length}`);
  }
  if (patch.position !== undefined) {
    binds.push(patch.position);
    sets.push(`position=?${binds.length}`);
  }
  if (sets.length === 0) return ok(c);
  binds.push(id, workspaceId);
  const res = await c.env.DB.prepare(
    `UPDATE kb_collections SET ${sets.join(", ")} WHERE id=?${binds.length - 1} AND workspace_id=?${binds.length}`,
  )
    .bind(...binds)
    .run();
  if (res.meta.changes !== 1) throw ctxErr.kb.collectionNotFound();
  return ok(c);
});

kbApi.delete("/kb/collections/:id", async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  // Batched: unlinking articles and deleting the collection are one logical unit — a crash
  // between the two would otherwise unlink articles from a collection that never actually goes away.
  const [, deleteRes] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE kb_articles SET collection_id=NULL WHERE collection_id=?1 AND workspace_id=?2").bind(
      id,
      workspaceId,
    ),
    c.env.DB.prepare("DELETE FROM kb_collections WHERE id=?1 AND workspace_id=?2").bind(id, workspaceId),
  ]);
  // Within a db.batch(), D1's changes counter carries over trigger-driven writes from earlier
  // statements in the same batch (here: the UPDATE's kb_articles_fts AFTER-trigger side effect),
  // same gotcha as decision.md #16 — use < 1, not !== 1, to detect "not found".
  if (deleteRes.meta.changes < 1) throw ctxErr.kb.collectionNotFound();
  return ok(c);
});

// --- Articles ---

const ARTICLE_COLUMNS =
  "id, workspace_id as workspaceId, collection_id as collectionId, title, slug, body_md as bodyMd, status, created_by as createdBy, published_at as publishedAt, created_at as createdAt, updated_at as updatedAt";

kbApi.post("/kb/articles", validate(ArticleBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const userId = c.get("userId");
  const { title, collectionId, bodyMd } = c.get("body") as z.infer<typeof ArticleBody>;
  const id = uuidv7();
  const slug = await uniqueSlug(c.env.DB, "kb_articles", workspaceId, title);
  const ts = now();
  const md = bodyMd ?? "";
  await c.env.DB.prepare(
    `INSERT INTO kb_articles
       (id, workspace_id, collection_id, title, slug, body_md, body_text, status, created_by,
        published_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'DRAFT', ?8, NULL, ?9, ?9)`,
  )
    .bind(id, workspaceId, collectionId ?? null, title, slug, md, stripMarkdown(md), userId, ts)
    .run();
  return ok(c, { article: { id, title, slug, collectionId: collectionId ?? null, bodyMd: md, status: "DRAFT" } });
});

kbApi.get("/kb/articles", async (c) => {
  const { workspaceId } = c.get("member");
  const { results } = await c.env.DB.prepare(
    `SELECT ${ARTICLE_COLUMNS} FROM kb_articles WHERE workspace_id=?1 ORDER BY updated_at DESC`,
  )
    .bind(workspaceId)
    .all();
  return ok(c, { articles: results });
});

kbApi.get("/kb/articles/:id", async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const article = await c.env.DB.prepare(`SELECT ${ARTICLE_COLUMNS} FROM kb_articles WHERE id=?1 AND workspace_id=?2`)
    .bind(id, workspaceId)
    .first();
  if (!article) throw ctxErr.kb.articleNotFound();
  return ok(c, { article });
});

kbApi.patch("/kb/articles/:id", validate(ArticlePatchBody, "json"), async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const patch = c.get("body") as z.infer<typeof ArticlePatchBody>;

  const current = await c.env.DB.prepare("SELECT status FROM kb_articles WHERE id=?1 AND workspace_id=?2")
    .bind(id, workspaceId)
    .first<{ status: string }>();
  if (!current) throw ctxErr.kb.articleNotFound();

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) {
    binds.push(patch.title);
    sets.push(`title=?${binds.length}`);
  }
  if (patch.collectionId !== undefined) {
    binds.push(patch.collectionId);
    sets.push(`collection_id=?${binds.length}`);
  }
  if (patch.bodyMd !== undefined) {
    binds.push(patch.bodyMd);
    sets.push(`body_md=?${binds.length}`);
    binds.push(stripMarkdown(patch.bodyMd));
    sets.push(`body_text=?${binds.length}`);
  }
  if (patch.slug !== undefined) {
    const clash = await c.env.DB.prepare(
      "SELECT 1 FROM kb_articles WHERE workspace_id=?1 AND slug=?2 AND id<>?3",
    )
      .bind(workspaceId, patch.slug, id)
      .first();
    if (clash) throw ctxErr.kb.slugTaken();
    binds.push(patch.slug);
    sets.push(`slug=?${binds.length}`);
  }
  if (patch.status !== undefined) {
    binds.push(patch.status);
    sets.push(`status=?${binds.length}`);
    if (patch.status === ARTICLE.STATUS.PUBLISHED && current.status !== ARTICLE.STATUS.PUBLISHED) {
      binds.push(now());
      sets.push(`published_at=?${binds.length}`);
    }
  }
  if (sets.length === 0) return ok(c);
  binds.push(now());
  sets.push(`updated_at=?${binds.length}`);
  binds.push(id, workspaceId);
  await c.env.DB.prepare(
    `UPDATE kb_articles SET ${sets.join(", ")} WHERE id=?${binds.length - 1} AND workspace_id=?${binds.length}`,
  )
    .bind(...binds)
    .run();

  const updated = await c.env.DB.prepare(`SELECT ${ARTICLE_COLUMNS} FROM kb_articles WHERE id=?1`).bind(id).first();
  return ok(c, { article: updated });
});

kbApi.delete("/kb/articles/:id", async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("DELETE FROM kb_articles WHERE id=?1 AND workspace_id=?2")
    .bind(id, workspaceId)
    .run();
  // changes includes rows touched by the kb_articles_fts AFTER DELETE trigger, not just this row.
  if (res.meta.changes < 1) throw ctxErr.kb.articleNotFound();
  return ok(c);
});

kbApi.post("/kb/articles/:id/publish", async (c) => {
  const { workspaceId } = c.get("member");
  const id = c.req.param("id");
  const res = await c.env.DB.prepare(
    "UPDATE kb_articles SET status='PUBLISHED', published_at=?1, updated_at=?1 WHERE id=?2 AND workspace_id=?3",
  )
    .bind(now(), id, workspaceId)
    .run();
  // changes includes rows touched by the kb_articles_fts AFTER UPDATE trigger, not just this row.
  if (res.meta.changes < 1) throw ctxErr.kb.articleNotFound();
  const updated = await c.env.DB.prepare(`SELECT ${ARTICLE_COLUMNS} FROM kb_articles WHERE id=?1`).bind(id).first();
  return ok(c, { article: updated });
});
