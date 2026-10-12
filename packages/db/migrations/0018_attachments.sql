-- purlay: no-transaction
-- 0018_attachments
--
-- Files and images a message carries (D-16, D-109). Uploaded before the message exists, so
-- `message_id` is null until the send links it.
--
-- The rules a constraint can say are said here (D-90):
--   * the id is the client's UUIDv7, so a retried upload finds the row it made (D-109 §3);
--   * the size, sides and pixel count are bounded — the size is `attachment_size_limit`, the one
--     source of truth for it (`ARCHITECTURE.md` §9); the contract's constants are bound to these
--     CHECKs by a test that inserts at each bound and one past it;
--   * an attachment is in its message's workspace: a composite key on `messages (id, workspace_id)`,
--     built as an index CONCURRENTLY, as 0010 built its targets;
--   * every foreign-key column is indexed (D-89).
--
-- Re-runnable: what it adds is dropped first.

DROP TABLE IF EXISTS attachments;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_id_workspace_id_key;
DROP INDEX CONCURRENTLY IF EXISTS messages_id_workspace_id_ix;

CREATE UNIQUE INDEX CONCURRENTLY messages_id_workspace_id_ix ON messages (id, workspace_id);
ALTER TABLE messages
    ADD CONSTRAINT messages_id_workspace_id_key UNIQUE USING INDEX messages_id_workspace_id_ix;

CREATE TABLE attachments (
    id            UUID PRIMARY KEY,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- NULL while unattached. The person's own until then; their message's afterwards.
    message_id    UUID,
    uploader_id   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

    -- Opaque keys in the object store, never a public URL: reads are brokered (D-109 §6).
    storage_key   TEXT NOT NULL UNIQUE,
    thumbnail_key TEXT UNIQUE,

    file_name     VARCHAR(255) NOT NULL,
    mime_type     VARCHAR(128) NOT NULL,
    size_bytes    BIGINT NOT NULL,
    kind          attachment_kind NOT NULL DEFAULT 'file',
    -- Present for an image, so the client reserves its space before it loads.
    width         INTEGER,
    height        INTEGER,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT attachments_message_workspace_fkey
        FOREIGN KEY (message_id, workspace_id) REFERENCES messages (id, workspace_id)
        ON DELETE CASCADE,
    CONSTRAINT attachments_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    -- 25 MiB (D-16).
    CONSTRAINT attachment_size_limit
        CHECK (size_bytes > 0 AND size_bytes <= 26214400),
    -- Both sides or neither, each at most 16384, at most 40 million pixels (D-109 §2).
    CONSTRAINT attachment_dimensions
        CHECK ((width IS NULL) = (height IS NULL)
               AND (width IS NULL OR (width BETWEEN 1 AND 16384 AND height BETWEEN 1 AND 16384
                                      AND width::bigint * height <= 40000000)))
);

CREATE INDEX idx_attachments_message ON attachments (message_id) WHERE message_id IS NOT NULL;
-- A person's unattached uploads in a workspace: counted against the bound, and swept (#71).
CREATE INDEX idx_attachments_unattached
    ON attachments (workspace_id, uploader_id, created_at) WHERE message_id IS NULL;
CREATE INDEX idx_attachments_uploader ON attachments (uploader_id);
CREATE INDEX idx_attachments_workspace ON attachments (workspace_id);
