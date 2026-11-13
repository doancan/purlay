-- A deferred request retains its actual native source; losing that session never grants authority (D-310).
-- No foreign key: session deletion must not replace a known source with legacy unknown provenance.
SET lock_timeout = '10s';
ALTER TABLE workspace_exports ADD COLUMN source_session_id UUID;
ALTER TABLE personal_exports ADD COLUMN source_session_id UUID;
RESET lock_timeout;
