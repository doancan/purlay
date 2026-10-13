-- 0026_saved_messages
--
-- A person's saved messages (#484, D-128): a message kept to come back to, in one of three states.
--
--   * One row per person and message. Its id is the application's UUIDv7 (D-8), kept when the save
--     is made again, so a page of saves is keyset on it and a cursor survives a save removed.
--   * The message is in this channel, and the channel in this workspace (I-1, I-4): the two
--     composite keys `mentions` has, so a save cannot point across a tenant.
--   * Cascades with the message row (a retention purge), the channel and the workspace. A soft
--     delete keeps it and the list hides it, as the inbox hides what nobody can read.
--   * No reminder: reminders are a permanent non-goal (PRD §6, D-4).
--
-- A new table with no rows: one transaction, as 0012.

CREATE TYPE saved_state AS ENUM ('in_progress', 'archived', 'completed');

CREATE TABLE saved_messages (
    id            UUID PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id    UUID NOT NULL,
    message_id    UUID NOT NULL,
    state         saved_state NOT NULL DEFAULT 'in_progress',
    saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT saved_messages_once UNIQUE (user_id, message_id),
    CONSTRAINT saved_messages_message_channel_fkey
        FOREIGN KEY (message_id, channel_id) REFERENCES messages (id, channel_id)
        ON DELETE CASCADE,
    CONSTRAINT saved_messages_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE
);

-- A person's saves in a workspace, by state, newest first: what the Saved view pages through.
CREATE INDEX idx_saved_messages_list ON saved_messages (user_id, workspace_id, state, id DESC);
-- Every foreign key indexed (D-89).
CREATE INDEX idx_saved_messages_message ON saved_messages (message_id, channel_id);
CREATE INDEX idx_saved_messages_channel ON saved_messages (channel_id, workspace_id);
CREATE INDEX idx_saved_messages_workspace ON saved_messages (workspace_id);
