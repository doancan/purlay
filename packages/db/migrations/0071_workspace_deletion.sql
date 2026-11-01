-- purlay: no-transaction
-- 0071_workspace_deletion
--
-- An owner deletes a workspace (D-242): asked for, a grace period in which any owner can take it back, then
-- its content erased by `purge:workspaces`.
--
--   * `workspaces.deleted_at` (0003, never written before this) is when the deletion was asked for. From then
--     the workspace is no workspace to anybody: the tenancy guard has always refused one with it set. An owner
--     who takes the deletion back sets it to NULL again.
--   * `workspaces.purge_started_at`: when the job claimed it — the point after which nobody can take it back.
--     Set under the row's lock, which taking it back also waits on, so the two cannot both win.
--   * `workspaces.purged_at`: when its content was gone. The row itself stays, a tombstone with its name: the
--     trail it is on (`audit_log`, `server_audit_log`) refers to it, and neither is ever deleted from (I-9).
--   * `server_audit_log.target_workspace_id`: which workspace an entry is about (`server.workspace_purged`).
--     `ON DELETE RESTRICT`, as `audit_log`'s: the record outlives what it describes (D-26).
--
-- No index on the three times: the job reads `workspaces`, a table of one row per team, and a scan of it is
-- what every nightly job here already does. The trail's new column gets a partial index like the user's, for
-- the foreign key's own `ON DELETE` check (D-89).
--
-- Rollback: nothing reads these columns but this feature. `ALTER TABLE workspaces DROP COLUMN
-- purge_started_at, DROP COLUMN purged_at` and `DROP INDEX CONCURRENTLY idx_server_audit_log_workspace` then
-- `ALTER TABLE server_audit_log DROP COLUMN target_workspace_id` in a new migration undo it; a workspace whose
-- deletion was asked for stays gone (its `deleted_at` is 0003's), and one already purged stays empty.
--
-- On tables with rows, outside the migrator's transaction (D-86), in 0029's order: the columns, then each
-- check NOT VALID and validated, then the index CONCURRENTLY, dropped first since an interrupted build leaves
-- an invalid one. Nullable columns without a default are catalogue changes. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS purge_started_at TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

-- Claimed only once asked for, and purged only once claimed: a purged workspace can never be taken back.
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_deletion_order;
ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_deletion_order CHECK (
        (purge_started_at IS NULL OR deleted_at IS NOT NULL)
        AND (purged_at IS NULL OR purge_started_at IS NOT NULL)
    ) NOT VALID;
ALTER TABLE workspaces VALIDATE CONSTRAINT workspaces_deletion_order;

ALTER TABLE server_audit_log
    ADD COLUMN IF NOT EXISTS target_workspace_id UUID REFERENCES workspaces(id) ON DELETE RESTRICT;

RESET lock_timeout;

DROP INDEX CONCURRENTLY IF EXISTS idx_server_audit_log_workspace;
CREATE INDEX CONCURRENTLY idx_server_audit_log_workspace ON server_audit_log (target_workspace_id)
    WHERE target_workspace_id IS NOT NULL;
