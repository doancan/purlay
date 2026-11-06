-- purlay: no-transaction
-- D-277: filtered keyset pages must not scan the whole server trail. These unpublished
-- indexes follow D-86: concurrent builds, dropped first so interrupted builds can restart.
DROP INDEX CONCURRENTLY IF EXISTS idx_server_audit_action_id;
CREATE INDEX CONCURRENTLY idx_server_audit_action_id ON server_audit_log (action, id DESC);
DROP INDEX CONCURRENTLY IF EXISTS idx_server_audit_target_id;
CREATE INDEX CONCURRENTLY idx_server_audit_target_id ON server_audit_log (target_user_id, id DESC) WHERE target_user_id IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS idx_server_audit_workspace_id;
CREATE INDEX CONCURRENTLY idx_server_audit_workspace_id ON server_audit_log (target_workspace_id, id DESC) WHERE target_workspace_id IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS idx_server_audit_created;
CREATE INDEX CONCURRENTLY idx_server_audit_created ON server_audit_log (created_at, id DESC);
