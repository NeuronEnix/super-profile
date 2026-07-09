CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT,
  last_seen_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  widget_key TEXT NOT NULL UNIQUE, widget_color TEXT NOT NULL DEFAULT '#4f46e5',
  created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('ADMIN','AGENT')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE invites (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('ADMIN','AGENT')),
  token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
  accepted_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE contacts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT, name TEXT, last_seen_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, user_id), UNIQUE (workspace_id, email)
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  channel TEXT NOT NULL CHECK (channel IN ('CHAT','EMAIL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SNOOZED','RESOLVED')),
  assignee_id TEXT REFERENCES users(id), subject TEXT, snoozed_until INTEGER,
  last_message_at INTEGER NOT NULL, last_message_preview TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  ai_summary TEXT, ai_summary_msg_count INTEGER NOT NULL DEFAULT 0,
  contact_last_read_at INTEGER, agent_last_read_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_conv_inbox ON conversations (workspace_id, status, last_message_at DESC);
CREATE INDEX idx_conv_contact ON conversations (workspace_id, contact_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('CONTACT','AGENT','SYSTEM')),
  sender_id TEXT, body_text TEXT NOT NULL, body_html TEXT,
  email_message_id TEXT, email_in_reply_to TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_msg_conv ON messages (conversation_id, id);
CREATE INDEX idx_msg_email_mid ON messages (workspace_id, email_message_id);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
  workspace_id TEXT NOT NULL, r2_key TEXT NOT NULL, filename TEXT NOT NULL,
  content_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE kb_collections (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, slug)
);
CREATE TABLE kb_articles (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  collection_id TEXT REFERENCES kb_collections(id),
  title TEXT NOT NULL, slug TEXT NOT NULL, body_md TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED')),
  created_by TEXT NOT NULL, published_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, slug)
);
CREATE TABLE custom_domains (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  hostname TEXT NOT NULL UNIQUE, verification_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_DNS' CHECK (status IN ('PENDING_DNS','ACTIVE','FAILED')),
  ssl_status TEXT NOT NULL DEFAULT 'STUBBED', verified_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE canned_responses (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
