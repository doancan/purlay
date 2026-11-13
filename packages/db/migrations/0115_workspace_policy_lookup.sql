-- purlay: no-transaction
-- Legacy unknown archives must detect retained workspace policy history without scanning every workspace (D-310).
SET lock_timeout = '10s';
DROP INDEX CONCURRENTLY IF EXISTS idx_workspaces_access_policy_epoch;
CREATE INDEX CONCURRENTLY idx_workspaces_access_policy_epoch ON workspaces (access_policy_epoch);
RESET lock_timeout;
