-- A prepared personal archive retains exactly the workspaces its bytes contain (D-310).
-- NULL is legacy unknown, an empty array is a proven account-only archive. No inferred backfill.
SET lock_timeout = '10s';
ALTER TABLE personal_exports ADD COLUMN source_workspace_ids UUID[];
ALTER TABLE personal_exports ADD CONSTRAINT personal_export_workspace_sources
    CHECK (CASE
        WHEN source_workspace_ids IS NULL OR cardinality(source_workspace_ids) = 0 THEN true
        WHEN array_ndims(source_workspace_ids) <> 1 OR array_lower(source_workspace_ids, 1) <> 1 THEN false
        ELSE array_position(source_workspace_ids, NULL) IS NULL
    END) NOT VALID;
ALTER TABLE personal_exports VALIDATE CONSTRAINT personal_export_workspace_sources;
RESET lock_timeout;
