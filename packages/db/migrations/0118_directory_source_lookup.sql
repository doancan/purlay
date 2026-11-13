-- purlay: no-transaction
-- Source-only revocations use the retained exact native proof, without scanning every session.
SET lock_timeout = '10s';
DROP INDEX CONCURRENTLY IF EXISTS idx_workspace_identity_sessions_source;
CREATE INDEX CONCURRENTLY idx_workspace_identity_sessions_source
    ON workspace_identity_sessions(source_id, source_authorization_revision, session_id)
    WHERE directory_id IS NOT NULL;
RESET lock_timeout;
