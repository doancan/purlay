-- purlay: no-transaction
-- 0032_event_messages
--
-- A message with no author (#79, D-134 §6): what a repository's feed posts. Its `sender_id` is
-- NULL, and it is a `system_event`; a person's message is `text` and has its sender. The two are
-- one rule, held here so no writer can make the other two: a person's message without a sender,
-- or an event that says somebody wrote it.
--
--   * `sender_id` loses NOT NULL — a change of the catalogue only, whatever the table holds.
--   * The rule is added NOT VALID, which checks new rows at once and holds its lock only for the
--     statement, then validated in the next, which scans without blocking readers or writers. Every
--     row today is `text` with its sender (no writer has made a `system_event`), so it validates.
--   * A lock wait is bounded, so a long transaction ahead of an ALTER fails this migration rather
--     than queueing every query on `messages` behind it (D-86, as 0010).
--
-- It can be run again after a crash at any point: the rule is dropped first, and dropping NOT NULL
-- twice is the same as once.

SET lock_timeout = '10s';

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_by_type;

ALTER TABLE messages ALTER COLUMN sender_id DROP NOT NULL;

ALTER TABLE messages ADD CONSTRAINT messages_sender_by_type
    CHECK ((message_type = 'text') = (sender_id IS NOT NULL)) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_sender_by_type;
