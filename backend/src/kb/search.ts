export type ArticleSearchHit = {
  id: string;
  title: string;
  slug: string;
};

/** Strips markdown syntax down to searchable plain text (fenced code blocks removed first). */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_>[\]()!`-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds an OR-of-prefixes FTS5 query so natural-language questions ("how do I reset my
 * password") surface articles matching any of the significant words, ranked by bm25 — a strict
 * phrase match would almost never hit real article text.
 */
function ftsQuery(q: string): string | null {
  const terms = q
    .replace(/["*]/g, "")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}*`).join(" OR ");
}

export async function searchArticles(
  db: D1Database,
  workspaceId: string,
  q: string,
  limit: number,
): Promise<ArticleSearchHit[]> {
  const query = ftsQuery(q);
  if (!query) return [];
  const { results } = await db
    .prepare(
      `SELECT a.id as id, a.title as title, a.slug as slug
       FROM kb_articles_fts f JOIN kb_articles a ON a.rowid = f.rowid
       WHERE kb_articles_fts MATCH ?1 AND a.workspace_id=?2 AND a.status='PUBLISHED'
       ORDER BY bm25(kb_articles_fts)
       LIMIT ?3`,
    )
    .bind(query, workspaceId, limit)
    .all<ArticleSearchHit>();
  return results;
}
