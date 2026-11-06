-- purlay: no-transaction
-- D-277: operator aggregates read indexed metadata, never conversation tables.
-- Concurrent, re-runnable builds on tables which already hold rows (D-86).
DROP INDEX CONCURRENTLY IF EXISTS idx_users_administration_status;
CREATE INDEX CONCURRENTLY idx_users_administration_status ON users (deleted_at) INCLUDE (is_server_admin, suspended_at);
DROP INDEX CONCURRENTLY IF EXISTS idx_workspace_exports_status;
CREATE INDEX CONCURRENTLY idx_workspace_exports_status ON workspace_exports (status);
