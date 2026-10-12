-- purlay: no-transaction
-- 0016_tombstones_keep_their_place
--
-- Deleting a message replaces its content with a tombstone and keeps its place (D-103 §7, D-9):
-- a deleted root that has replies stays in the channel's feed, with its thread, and a deleted reply
-- stays in its thread. The two indexes those reads use were partial on live rows only, so the
-- queries that now also want those tombstones could no longer be answered from them.
--
--   idx_messages_channel_feed  the feed: roots that are live, or deleted with a reply.
--                              Replay and history keep their `deleted_at IS NULL`, which implies
--                              this predicate, so they use it unchanged.
--   idx_messages_thread        a thread: every reply, deleted or not. A thread is read whole,
--                              and a deleted reply is one row of it.
--
-- Written the way 0009 and 0014 are, for a table with rows: outside the migrator's transaction
-- (D-86) so the build does not block writers, dropped and then built so a run interrupted at any
-- point (which leaves an INVALID index `IF NOT EXISTS` would call present) can be run again. The
-- names are kept, so what refers to them — the documents, the schema test — still holds. Between the
-- two statements of each pair, the read it serves is slower, not wrong.

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_channel_feed;
CREATE INDEX CONCURRENTLY idx_messages_channel_feed
    ON messages (channel_id, id DESC)
    WHERE parent_id IS NULL AND (deleted_at IS NULL OR thread_reply_count > 0);

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_thread;
CREATE INDEX CONCURRENTLY idx_messages_thread
    ON messages (parent_id, id)
    WHERE parent_id IS NOT NULL;
