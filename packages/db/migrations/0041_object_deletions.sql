-- 0041_object_deletions
--
-- Objects in the store whose rows are gone, until the store has let them go (#592, D-141).
--
--   * A key is written in the transaction that deletes the rows naming it, so it is never lost
--     between the commit and the store's delete — a refusal, or the process stopping in between.
--   * The row goes once the store has deleted the object; `sweep:deletions` tries what is left again,
--     in key order from where it got to, so keys the store keeps refusing never hold back the rest.
--   * Keys are the store's own, under a workspace's prefix (`workspacePrefix`).
--
-- A new table with no rows: one transaction, as 0026.

CREATE TABLE object_deletions (
    storage_key      TEXT PRIMARY KEY,
    enqueued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at  TIMESTAMPTZ,

    CONSTRAINT object_deletions_key_in_a_workspace CHECK (storage_key LIKE 'w/%'),
    CONSTRAINT object_deletions_attempts CHECK (attempts >= 0)
);
