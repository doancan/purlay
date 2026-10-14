-- 0034_message_versions
--
-- What an edited message said before (#82, D-135): each edit keeps the words it replaced, as a version
-- of the message, with the instant they were replaced.
--
--   * Its id is the application's UUIDv7 at that instant (D-8), so a message's versions are keyset on
--     it, newest first, and a page's cursor survives a version removed.
--   * The message is in this channel, and the channel in this workspace (I-1, I-4): the two composite
--     keys `mentions` has, so a version cannot point across a tenant.
--   * Cascades with the message row (a retention purge), the channel and the workspace. Deleting a
--     message removes its versions in the same transaction (`messages/delete.ts`): a tombstone hides
--     what was said, and its history would otherwise keep it readable.
--   * The words are held to a message's own bound (0011's units), so a version is never longer than
--     a message could be.
--
-- A new table with no rows: one transaction, as 0026.

CREATE TABLE message_versions (
    id            UUID PRIMARY KEY,
    message_id    UUID NOT NULL,
    channel_id    UUID NOT NULL,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    content       TEXT NOT NULL,
    replaced_at   TIMESTAMPTZ NOT NULL,

    CONSTRAINT message_versions_content_length CHECK (
        char_length(content)
        + char_length(regexp_replace(content, '[^\U00010000-\U0010FFFF]', '', 'g'))
        <= 16000
    ),
    CONSTRAINT message_versions_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT message_versions_message_channel_fkey
        FOREIGN KEY (message_id, channel_id) REFERENCES messages (id, channel_id)
        ON DELETE CASCADE,
    CONSTRAINT message_versions_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE
);

-- A message's versions, newest first: what its history pages through, and the cap counts.
CREATE INDEX idx_message_versions_message ON message_versions (message_id, id DESC);
-- Every foreign key indexed (D-89).
CREATE INDEX idx_message_versions_channel ON message_versions (channel_id, workspace_id);
CREATE INDEX idx_message_versions_workspace ON message_versions (workspace_id);
