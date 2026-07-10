ALTER TABLE conversations ADD COLUMN first_agent_reply_at INTEGER;
ALTER TABLE conversations ADD COLUMN resolved_at INTEGER;
ALTER TABLE workspaces ADD COLUMN sla_first_response_min INTEGER;
ALTER TABLE workspaces ADD COLUMN sla_resolution_min INTEGER;
UPDATE conversations SET first_agent_reply_at =
  (SELECT MIN(created_at) FROM messages m
   WHERE m.conversation_id = conversations.id AND m.sender_type IN ('AGENT','AI'));
UPDATE conversations SET resolved_at = updated_at WHERE status = 'RESOLVED';
