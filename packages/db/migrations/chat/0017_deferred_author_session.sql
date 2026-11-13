-- A new schedule/reminder captures its authoring session; old rows remain unknown (D-310).
-- Kept in the chat set so a core-only deployment never needs chat tables.
-- No foreign key: deleting a source cannot erase provenance or promote company authority.
SET lock_timeout = '10s';
ALTER TABLE scheduled_messages ADD COLUMN source_session_id UUID;
ALTER TABLE message_reminders ADD COLUMN source_session_id UUID;
RESET lock_timeout;
