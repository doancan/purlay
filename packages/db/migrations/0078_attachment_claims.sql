-- purlay: no-transaction
-- 0078_attachment_claims
--
-- The core's half of moving an attachment's link to its message into chat (D-250, `MODULES.md` §10, step 8).
--
-- An attachment is a stored object, its uploader and its workspace. Whether a module has *taken* it — a message
-- sent with it — is the core's to know without knowing which module, or which table of its, took it: the sweep of
-- uploads nobody sent, the quota of an uploader's unsent files and the upload's own checks asked
-- `message_id IS NULL`, which names a column that is chat's. `claimed_at` says it in the core's own words: null
-- until a module claims the upload, set by it in the transaction that links it.
--
-- The existing rows are claimed where they are linked. The moment is not known; `created_at` stands in, and
-- nothing reads it as a time — only whether it is null.
--
-- `(id, workspace_id)` is made unique so that chat's link table can name an attachment and its workspace
-- together, as its keys to messages already do: an attachment cannot be linked into another workspace's
-- message (I-1). A unique index is what a foreign key needs; it is built CONCURRENTLY, so writers are not
-- blocked, and a crashed build leaves an INVALID index that is dropped first.
--
-- This is the expand half, and nothing is removed: `attachments.message_id` and `channel_id` and their keys stay
-- and are written as before, so the release before this one still runs on the schema. They go in the release
-- after, once nothing reads them.

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

UPDATE attachments SET claimed_at = created_at
    WHERE message_id IS NOT NULL AND claimed_at IS NULL;

DROP INDEX CONCURRENTLY IF EXISTS attachments_id_workspace_key;
CREATE UNIQUE INDEX CONCURRENTLY attachments_id_workspace_key ON attachments (id, workspace_id);

-- What the sweep and the quota look for: an uploader's files nobody sent, oldest first.
DROP INDEX CONCURRENTLY IF EXISTS idx_attachments_unclaimed;
CREATE INDEX CONCURRENTLY idx_attachments_unclaimed
    ON attachments (workspace_id, uploader_id, created_at) WHERE claimed_at IS NULL;
