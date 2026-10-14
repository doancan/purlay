-- 0040_workspace_exports
--
-- An owner's export of their workspace (#84, D-140): asked for, made by the API in the background, and
-- downloaded once.
--
--   * One row an export asked for: by whom, and where it stands — `pending` while it is made, `ready`
--     with its archive in the object store and how big it is, `failed` with a code (never a message a
--     store or a database wrote), `downloaded` once it has been, `expired` when nobody did in time.
--   * The archive lives under the workspace's prefix in the store, and goes when it is downloaded or
--     expires; the row keeps its key until the object is gone — a download cut off, or a store that
--     refused a delete, leaves it for the sweep to finish — and stays, as the record that it was made.
--   * A run being made says so every minute (`heartbeat_at`): one silent for long was cut off by a
--     restart, however long a large export takes.
--   * At most one export of a workspace is being made at a time: the partial unique index.
--   * The owner's list reads a workspace's newest first: the index on both.
--   * Erasing a person sets their requests' `requested_by` to null: the index that finds them.
--
-- A new table with no rows: one transaction, as 0026.

CREATE TABLE workspace_exports (
    id             UUID PRIMARY KEY,
    workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    requested_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    status         TEXT NOT NULL,
    storage_key    TEXT,
    size_bytes     BIGINT,
    failure        TEXT,
    created_at     TIMESTAMPTZ NOT NULL,
    finished_at    TIMESTAMPTZ,
    heartbeat_at   TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ,
    downloaded_at  TIMESTAMPTZ,

    CONSTRAINT workspace_exports_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT workspace_exports_status
        CHECK (status IN ('pending', 'ready', 'failed', 'downloaded', 'expired')),
    -- A ready export has its archive, its size and its expiry; a pending one has no archive yet.
    CONSTRAINT workspace_exports_ready
        CHECK (status <> 'ready'
               OR (storage_key IS NOT NULL AND size_bytes IS NOT NULL AND expires_at IS NOT NULL)),
    CONSTRAINT workspace_exports_pending
        CHECK (status <> 'pending' OR storage_key IS NULL),
    CONSTRAINT workspace_exports_failure
        CHECK ((status = 'failed') = (failure IS NOT NULL) AND (failure IS NULL OR failure ~ '^[A-Z_]{1,64}$'))
);

CREATE UNIQUE INDEX idx_workspace_exports_one_pending
    ON workspace_exports (workspace_id) WHERE status = 'pending';

CREATE INDEX idx_workspace_exports_workspace ON workspace_exports (workspace_id, id DESC);

CREATE INDEX idx_workspace_exports_requested_by
    ON workspace_exports (requested_by) WHERE requested_by IS NOT NULL;
