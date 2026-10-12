-- 0019_administration
--
-- The trail of administrative actions and the record of scheduled work (D-26, D-30;
-- `SCHEMA.md` §9).
--
--   * `audit_log` is append-only (I-9): no `updated_at`, no `deleted_at`. Its id is the application's
--     UUIDv7, read newest first by keyset like `messages` (D-8), and said so by a CHECK. The
--     workspace is RESTRICT: a hard purge that would erase the trail fails loudly. The actor is
--     SET NULL: what was done survives who did it (D-27).
--   * `job_runs` is one row per job, upserted on every run, so a scheduler nobody installed is
--     visible as a job that never succeeded (D-30). Instance-wide: no workspace.
--   * Every foreign-key column is indexed (D-89).
--
-- Re-runnable: what it adds is dropped first.

DROP TABLE IF EXISTS job_runs;
DROP TABLE IF EXISTS audit_log;

CREATE TABLE audit_log (
    id            UUID PRIMARY KEY,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action        VARCHAR(64) NOT NULL,
    target_type   VARCHAR(32) NOT NULL,
    target_id     UUID,
    ip_address    INET,
    user_agent    TEXT,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT audit_log_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

-- The admin view: one workspace's trail, newest first.
CREATE INDEX idx_audit_log_workspace ON audit_log (workspace_id, id DESC);

-- "What did this account do", needed to answer an erasure request before honouring it.
CREATE INDEX idx_audit_log_actor ON audit_log (actor_user_id, id DESC)
    WHERE actor_user_id IS NOT NULL;

CREATE TABLE job_runs (
    job_name             VARCHAR(64) PRIMARY KEY,
    last_started_at      TIMESTAMPTZ,
    last_success_at      TIMESTAMPTZ,
    last_duration_ms     INTEGER,
    -- Truncated message only: a stack trace belongs in the log.
    last_error           TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT consecutive_failures_non_negative CHECK (consecutive_failures >= 0)
);
