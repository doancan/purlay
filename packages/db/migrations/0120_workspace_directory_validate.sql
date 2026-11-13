-- purlay: no-transaction
-- Validate the directory constraints in separate statements, after 0117 releases its DDL locks.
-- Each validation is resumable and permits concurrent writers (D-86).
SET lock_timeout = '10s';
ALTER TABLE workspace_identity_connections VALIDATE CONSTRAINT workspace_identity_connections_directory_pair;
ALTER TABLE workspace_identity_connections VALIDATE CONSTRAINT workspace_identity_connections_directory_reference;
ALTER TABLE sessions VALIDATE CONSTRAINT sessions_directory_company;
ALTER TABLE native_authorizations VALIDATE CONSTRAINT native_authorizations_directory_company;
ALTER TABLE workspace_identity_sessions VALIDATE CONSTRAINT workspace_identity_sessions_directory_tuple;

-- Workspace-first keys support the exact composite tenant foreign keys and scoped cleanup.
DROP INDEX CONCURRENTLY IF EXISTS idx_workspace_directory_credentials_workspace;
CREATE INDEX CONCURRENTLY idx_workspace_directory_credentials_workspace
    ON workspace_directory_credentials (workspace_id, directory_id, id);
DROP INDEX CONCURRENTLY IF EXISTS idx_workspace_directory_identity_links_workspace;
CREATE INDEX CONCURRENTLY idx_workspace_directory_identity_links_workspace
    ON workspace_directory_identity_links (workspace_id, directory_id, user_id);
RESET lock_timeout;
