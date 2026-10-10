-- purlay: no-transaction
-- 0013_read_state
--
-- I-6 as a constraint: `unread_mention_count <= unread_count`. `SCHEMA.md` §11 said it
-- was not one yet because the service that defines when a mention is counted did not
-- exist; it does now (D-99 §1), and a constraint written before the rule would have
-- decided it.
--
-- **No index is added for the recount, and that was measured.** Moving a read position
-- recounts the messages of the channel past it (`modules/channels/read-state.ts`). On
-- 400,000 messages the plan was read three ways, with the query's real shape (the
-- channel and position as parameters):
--   * a quiet channel (10 messages) among 400,000 newer ones elsewhere: 4 buffers, by
--     `idx_messages_channel` — a plan that took the primary key and discarded the other
--     channels' rows needed 4,536, and the planner does not choose it once it knows the
--     channel;
--   * a 200,000-message channel, 5 unread: 4 buffers by the primary key; 20,000 unread:
--     426 buffers by the primary key;
--   * a channel of 10,000 spread through 200,000 interleaved messages, 100 unread: 45
--     buffers by the primary key.
-- An index on `(channel_id, id)` — which would have replaced `idx_messages_channel`, of
-- which it is a superset — was built and measured against each: the planner chose the
-- same plans, so it would have cost a larger index entry on every message written and
-- bought nothing the numbers show. It is the first thing to try if a recount ever shows
-- up in a measurement of the read path.
--
-- Written for a table that has rows, and run outside the migrator's transaction (D-86),
-- as 0010 is, and for the same reasons:
--   * the check is added NOT VALID, which looks at new rows at once and takes a lock
--     that lasts only as long as the statement, and validated in the next statement,
--     which scans without blocking readers or writers;
--   * a lock wait is bounded, so a long transaction ahead of an ALTER fails this
--     migration instead of queueing every query on the table behind it.
--
-- It can be run again after a crash at any point: what it adds is dropped first. A row
-- that already breaks I-6 fails the VALIDATE, loudly, and the constraint stays present
-- and unvalidated until someone fixes the row and runs this again.

SET lock_timeout = '10s';

ALTER TABLE channel_members DROP CONSTRAINT IF EXISTS unread_mention_within_unread;

ALTER TABLE channel_members
    ADD CONSTRAINT unread_mention_within_unread
    CHECK (unread_mention_count <= unread_count) NOT VALID;
ALTER TABLE channel_members VALIDATE CONSTRAINT unread_mention_within_unread;

RESET lock_timeout;
