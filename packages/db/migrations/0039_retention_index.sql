-- purlay: no-transaction
-- 0039_retention_index
--
-- The retention purge (D-27 §1, D-139 §1) reads, each night, the messages of one workspace older than
-- its window. `idx_messages_workspace` holds the workspace alone, so that read would walk every message
-- the workspace ever had, once a batch; this one is a range from the oldest to the window's edge.
--
-- Written as 0009, 0014 and 0016 are, for a table with rows: outside the migrator's transaction (D-86)
-- so the build does not block writers, dropped first so a run interrupted mid-build (which leaves an
-- INVALID index `IF NOT EXISTS` would call present) can be run again.

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_workspace_age;
CREATE INDEX CONCURRENTLY idx_messages_workspace_age
    ON messages (workspace_id, created_at);

-- The new index begins with the workspace, so it answers everything the old one did — the foreign
-- key's own lookup included (D-89) — and the old one would only be written for nothing.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_workspace;
