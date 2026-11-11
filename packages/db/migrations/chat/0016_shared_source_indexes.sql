-- purlay: no-transaction
-- D-306: build the workspace file keyset index without blocking source writers (D-86).
-- Drop the owned index first so an interrupted/invalid concurrent build can be retried.
DROP INDEX CONCURRENTLY IF EXISTS idx_message_attachments_workspace;
CREATE INDEX CONCURRENTLY idx_message_attachments_workspace
    ON message_attachments (workspace_id, message_id DESC, attachment_id DESC);
