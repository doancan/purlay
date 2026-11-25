-- purlay: no-transaction
-- 0125_outbox_workspace_recent
--
-- The deliveries a workspace queued in the last minute (`deliveries_per_minute`, #1306): its rows by when they were queued, so the
-- count of the last minute starts at the newest entry of the workspace and stops at the limit, and does not walk every row the
-- workspace has kept (`idx_outbox_workspace` holds them by workspace alone, and finished rows stay for days).
--
-- It covers `idx_outbox_workspace` (the same first column), which is dropped: a prefix of another index is a second write for nothing,
-- and the lookups by workspace (the cascade, the purge, the backlog's count) read the new one.
--
-- CONCURRENTLY, and an INVALID leftover of a crashed build is dropped first.
--
-- Rollback: `CREATE INDEX CONCURRENTLY idx_outbox_workspace ON outbox (workspace_id)` and `DROP INDEX idx_outbox_workspace_recent`.

DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_workspace_recent;
CREATE INDEX CONCURRENTLY idx_outbox_workspace_recent
    ON outbox (workspace_id, created_at DESC);
DROP INDEX CONCURRENTLY IF EXISTS idx_outbox_workspace;
