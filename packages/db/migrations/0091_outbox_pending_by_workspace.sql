-- purlay: no-transaction
-- 0091_outbox_pending_by_workspace
--
-- What a publish asks before it writes (D-288 §10): how many facts the workspace already has pending for a consumer, counted up to
-- the ceiling and no further. Without this index the planner walks `idx_outbox_expires` or `idx_outbox_workspace` and filters, and a
-- workspace with a day of delivered history and a few pending rows reads all of it (measured on a million rows: 130 ms against
-- 0.06 ms). The partial index holds only what waits, so it is as small as the backlog and a delivered row leaves it.
--
-- Built CONCURRENTLY so a node that publishes while a roll is under way is not blocked; a crashed build leaves an INVALID index,
-- which is dropped first.
--
-- Rollback: `DROP INDEX idx_outbox_pending_workspace`. Nothing but the ceiling's count reads it.

DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_pending_workspace;
CREATE INDEX CONCURRENTLY idx_outbox_pending_workspace
    ON outbox (workspace_id, consumer) WHERE state = 'pending';
