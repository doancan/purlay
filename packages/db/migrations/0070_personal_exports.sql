-- 0070_personal_exports
--
-- A person's export of their own data (D-241): asked for from their account, made by the API in the
-- background, and downloaded once — by that person alone. The same life as an owner's workspace export
-- (0040, D-140), in a table of its own: a person's export names no workspace, and an owner's list must
-- never be able to show one.
--
--   * One row an export asked for, whose it is, and where it stands — `pending`, `ready` with its archive
--     in the object store and its size, `failed` with a code, `downloaded`, `expired` — on the same checks
--     as `workspace_exports`.
--   * The archive lives under the person's prefix in the store (`u/<id>/exports/`), and goes when it is
--     downloaded, expires, or the person erases their account; the row keeps its key until the object is
--     gone, so `sweep:exports` finishes what a refused delete left.
--   * At most one export of a person is being made at a time: the partial unique index, behind the check
--     the request makes under the person's row lock.
--   * The person's list and the day's count read their own newest first: the index on both.
--   * `ON DELETE CASCADE`: the row is the person's own record. An account is tombstoned rather than
--     deleted (D-139 §5): erasure ends its exports instead — a ready one `expired`, one being made
--     `failed` — and the sweep takes their archives, as it takes every archive a row no longer needs.
--
-- Rollback: `DROP TABLE personal_exports` in a new migration, once the routes are gone; archives still in
-- the store under `u/` are then the operator's to remove.
--
-- A new table with no rows: one transaction, as 0040.

CREATE TABLE personal_exports (
    id             UUID PRIMARY KEY,
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status         TEXT NOT NULL,
    storage_key    TEXT,
    size_bytes     BIGINT,
    failure        TEXT,
    created_at     TIMESTAMPTZ NOT NULL,
    finished_at    TIMESTAMPTZ,
    heartbeat_at   TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ,
    downloaded_at  TIMESTAMPTZ,

    CONSTRAINT personal_exports_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT personal_exports_status
        CHECK (status IN ('pending', 'ready', 'failed', 'downloaded', 'expired')),
    CONSTRAINT personal_exports_ready
        CHECK (status <> 'ready'
               OR (storage_key IS NOT NULL AND size_bytes IS NOT NULL AND expires_at IS NOT NULL)),
    CONSTRAINT personal_exports_pending
        CHECK (status <> 'pending' OR storage_key IS NULL),
    CONSTRAINT personal_exports_failure
        CHECK ((status = 'failed') = (failure IS NOT NULL) AND (failure IS NULL OR failure ~ '^[A-Z_]{1,64}$'))
);

CREATE UNIQUE INDEX idx_personal_exports_one_pending
    ON personal_exports (user_id) WHERE status = 'pending';

CREATE INDEX idx_personal_exports_user ON personal_exports (user_id, id DESC);
