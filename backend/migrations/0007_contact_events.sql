CREATE TABLE contact_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  type TEXT NOT NULL CHECK (type IN ('PAGE_VIEW')),
  url TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_contact ON contact_events (contact_id, created_at DESC);
