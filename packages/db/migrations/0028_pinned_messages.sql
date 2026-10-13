-- 0028_pinned_messages
--
-- A channel's pinned messages (#485, D-130): what its members keep at hand for everyone in it.
--
--   * One row per message: a message is pinned or it is not, whoever pinned it. Pinned again, the
--     row is left as it was.
--   * The message is in this channel, and the channel in this workspace (I-1, I-4): the two
--     composite keys `mentions` has, so a pin cannot point across a tenant.
--   * `pinned_by` outlives its person as NULL: the pin is the channel's, not theirs.
--   * Cascades with the message row (a retention purge), the channel and the workspace. Deleting
--     the message deletes its pin too (`messages/delete.ts`).
--
-- A new table with no rows: one transaction, as 0026.

CREATE TABLE pinned_messages (
    message_id    UUID PRIMARY KEY,
    channel_id    UUID NOT NULL,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    pinned_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    pinned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT pinned_messages_message_channel_fkey
        FOREIGN KEY (message_id, channel_id) REFERENCES messages (id, channel_id)
        ON DELETE CASCADE,
    CONSTRAINT pinned_messages_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE
);

-- A channel's pins, newest first: what the Pins panel lists and the cap counts.
CREATE INDEX idx_pinned_messages_channel ON pinned_messages (channel_id, pinned_at DESC);
-- Every foreign key indexed (D-89).
CREATE INDEX idx_pinned_messages_workspace ON pinned_messages (workspace_id);
CREATE INDEX idx_pinned_messages_pinned_by ON pinned_messages (pinned_by);
