-- purlay: no-transaction
-- 0058_message_changed_at
--
-- When a message last changed *to the server* (D-194): arrived, was edited, deleted, reacted to, answered, resolved,
-- redacted — the moment the row was written, on the database's own clock. It is what lets a client that was away
-- ask "what happened since I last heard" and be answered by the messages themselves, which an id cannot do:
--
--   * an id sorts by when the sender made it, and the server accepts one up to a minute behind (D-33), so a
--     message that arrives late sorts below one the client already holds;
--   * an edit, a deletion and a reaction make no new id at all.
--
-- **A trigger, not a column each writer must remember.** Every statement that updates a `messages` row stamps it,
-- including the ones that are not ours to remember — a retention job, an erasure, a repair by hand. The stamp is
-- left alone when the statement itself sets the column (a backfill, a test), so nothing in the application ever
-- writes it.
--
-- Millisecond precision, on purpose: a client holds it as an instant and a cursor is made of it, and a JavaScript
-- date cannot tell what a microsecond column can.
--
-- **What it does not carry**: a row that is deleted. The retention purge removes message rows (D-139 §3) and a
-- deleted row has no stamp to be read by, so a client that held one keeps showing it until it reloads, as every
-- open screen does (D-194 §Accepted).
--
-- Written for a table that has rows, outside the migrator's transaction (D-86), in 0010's order: the column and its
-- default, the backfill, the trigger, NOT NULL by way of a validated check (so the table is scanned once, not under
-- the lock that forbids writes), the index built CONCURRENTLY. Each step can run again.
--
-- Backfilled from the row's own times, so a client with an old watermark is not told that every message in the
-- channel changed on the day this ran.
--
-- `idx_messages_channel` (channel_id) goes: the new index leads with the same column, and a prefix of another whole
-- index costs every write and answers nothing the other cannot (`schema.integration.test.ts`).

SET lock_timeout = '10s';

ALTER TABLE messages ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ;
ALTER TABLE messages ALTER COLUMN changed_at SET DEFAULT date_trunc('milliseconds', clock_timestamp());

UPDATE messages
   SET changed_at = date_trunc(
       'milliseconds',
       GREATEST(created_at, updated_at, edited_at, deleted_at, resolved_at, thread_last_reply_at))
 WHERE changed_at IS NULL;

CREATE OR REPLACE FUNCTION messages_stamp_changed_at() RETURNS trigger AS $$
BEGIN
    IF NEW.changed_at IS NOT DISTINCT FROM OLD.changed_at THEN
        NEW.changed_at := date_trunc('milliseconds', clock_timestamp());
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_stamp_changed_at ON messages;
CREATE TRIGGER messages_stamp_changed_at
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION messages_stamp_changed_at();

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_changed_at_present;
ALTER TABLE messages ADD CONSTRAINT messages_changed_at_present CHECK (changed_at IS NOT NULL) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_changed_at_present;
ALTER TABLE messages ALTER COLUMN changed_at SET NOT NULL;
ALTER TABLE messages DROP CONSTRAINT messages_changed_at_present;

-- What the changes read walks: one channel, in the order things happened to it, the id breaking a tie.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_changes;
CREATE INDEX CONCURRENTLY idx_messages_changes ON messages (channel_id, changed_at, id);

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_channel;
