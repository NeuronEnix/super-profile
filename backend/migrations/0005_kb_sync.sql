CREATE TABLE kb_sync_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','DONE','FAILED')),
  pages_found INTEGER NOT NULL DEFAULT 0,
  pages_imported INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  requested_by TEXT NOT NULL,
  started_at INTEGER,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE kb_articles ADD COLUMN source_url TEXT;
CREATE UNIQUE INDEX idx_kb_articles_source ON kb_articles(workspace_id, source_url)
  WHERE source_url IS NOT NULL;
ALTER TABLE workspaces ADD COLUMN kb_digest TEXT;
ALTER TABLE workspaces ADD COLUMN kb_digest_at INTEGER;
