-- Existing and new workspaces allow urgent messages until an owner or admin turns them off.
ALTER TABLE workspaces ADD COLUMN urgent_messages_enabled BOOLEAN NOT NULL DEFAULT TRUE;
