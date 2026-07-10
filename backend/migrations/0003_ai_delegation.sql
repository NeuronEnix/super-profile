-- Delegate-to-AI: ai_handling = AI is autonomously replying; ai_escalated = AI handed the
-- conversation back to the human assignee and it needs their attention.
ALTER TABLE conversations ADD COLUMN ai_handling INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN ai_escalated INTEGER NOT NULL DEFAULT 0;
