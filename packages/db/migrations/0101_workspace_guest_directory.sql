-- purlay: no-transaction
-- 0101_workspace_guest_directory
-- Concurrent builds leave writes available; an interrupted build is safely replaced on the next run.
SET lock_timeout = '10s';
DROP INDEX CONCURRENTLY IF EXISTS idx_workspace_guest_directory;
CREATE INDEX CONCURRENTLY idx_workspace_guest_directory
    ON workspace_members (workspace_id, joined_at DESC, user_id DESC)
    WHERE access_kind = 'guest';
RESET lock_timeout;
