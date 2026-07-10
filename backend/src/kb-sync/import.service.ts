import { now, uuidv7 } from "../common/id";
import { ARTICLE } from "../common/const";
import { slugify } from "../common/slug";
import { uniqueSlug } from "../kb/kb.api";
import { stripMarkdown } from "../kb/search";
import type { Env } from "../types";

async function findOrCreateCollection(env: Env, workspaceId: string, name: string): Promise<string> {
  const slug = slugify(name);
  const existing = await env.DB.prepare("SELECT id FROM kb_collections WHERE workspace_id=?1 AND slug=?2")
    .bind(workspaceId, slug)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = uuidv7();
  const { count } = (await env.DB.prepare("SELECT COUNT(*) as count FROM kb_collections WHERE workspace_id=?1")
    .bind(workspaceId)
    .first<{ count: number }>()) ?? { count: 0 };
  await env.DB.prepare(
    "INSERT INTO kb_collections (id, workspace_id, name, slug, description, position, created_at) VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)",
  )
    .bind(id, workspaceId, name, slug, count, now())
    .run();
  return id;
}

export async function upsertImportedArticle(
  env: Env,
  input: {
    workspaceId: string;
    requestedBy: string;
    sourceUrl: string;
    title: string;
    bodyMd: string;
    collectionName: string | null;
  },
): Promise<"INSERTED" | "UPDATED"> {
  const ts = now();
  const collectionId = input.collectionName
    ? await findOrCreateCollection(env, input.workspaceId, input.collectionName)
    : null;
  const existing = await env.DB.prepare("SELECT id FROM kb_articles WHERE workspace_id=?1 AND source_url=?2")
    .bind(input.workspaceId, input.sourceUrl)
    .first<{ id: string }>();
  if (existing) {
    // Slug stays stable so public links never break; status untouched (an admin may have drafted it).
    await env.DB.prepare(
      "UPDATE kb_articles SET title=?1, body_md=?2, body_text=?3, collection_id=?4, updated_at=?5 WHERE id=?6",
    )
      .bind(input.title, input.bodyMd, stripMarkdown(input.bodyMd), collectionId, ts, existing.id)
      .run();
    return "UPDATED";
  }
  const id = uuidv7();
  const slug = await uniqueSlug(env.DB, "kb_articles", input.workspaceId, input.title);
  await env.DB.prepare(
    `INSERT INTO kb_articles
       (id, workspace_id, collection_id, title, slug, body_md, body_text, status, created_by,
        published_at, created_at, updated_at, source_url)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, ?11)`,
  )
    .bind(
      id, input.workspaceId, collectionId, input.title, slug, input.bodyMd,
      stripMarkdown(input.bodyMd), ARTICLE.STATUS.PUBLISHED, input.requestedBy, ts, input.sourceUrl,
    )
    .run();
  return "INSERTED";
}
