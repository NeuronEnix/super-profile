-- Allow 'AI' as a message sender (Delegate-to-AI replies). SQLite can't alter a CHECK
-- constraint, so rebuild the table in place and swap it in.
PRAGMA foreign_keys=OFF;

CREATE TABLE messages_new (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('CONTACT','AGENT','SYSTEM','AI')),
  sender_id TEXT, body_text TEXT NOT NULL, body_html TEXT,
  email_message_id TEXT, email_in_reply_to TEXT, created_at INTEGER NOT NULL
);
INSERT INTO messages_new SELECT * FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX idx_msg_conv ON messages (conversation_id, id);
CREATE INDEX idx_msg_email_mid ON messages (workspace_id, email_message_id);

PRAGMA foreign_keys=ON;
