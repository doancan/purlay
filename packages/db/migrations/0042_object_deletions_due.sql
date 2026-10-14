-- 0042_object_deletions_due
--
-- When a waiting object may be deleted (#607, D-141 §4 amended).
--
--   * An upload writes its keys here before it writes the object, so a process that stops between
--     the store's write and the row's insert leaves the keys behind, not the objects unnamed. The
--     insert takes them out again in its own transaction.
--   * Such a key is not due at once: an upload still on its way must not have its object deleted
--     under it. A key whose row was deleted is due at once, as before.
--
-- Existing rows are due now: the default fills them.

ALTER TABLE object_deletions ADD COLUMN due_at TIMESTAMPTZ NOT NULL DEFAULT now();
