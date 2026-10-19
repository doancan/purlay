-- 0044_thread_follows
--
-- A person's own choice about one thread (D-161): told of its new replies, or not. Without a row a
-- person follows a thread they started or have answered (D-29); a row is a choice they made, either
-- way, and it stands until they make another — replying again does not take it back.
--
--   * One row per person and root. The root is in this channel, and the channel in this workspace
--     (I-1, I-4): the composite keys `saved_messages` has, so a choice cannot point across a tenant.
--     That the message is a root is the service's rule, as a reply's parent is (I-1).
--   * Cascades with the message row (a retention purge), the channel, the workspace and the person.
--     A soft delete keeps it: a deleted root keeps its thread (D-103 §7), and so who follows it.
--
-- A new table with no rows: one transaction, as 0026.

CREATE TABLE thread_follows (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id    UUID NOT NULL,
    message_id    UUID NOT NULL,
    following     BOOLEAN NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT thread_follows_pkey PRIMARY KEY (user_id, message_id),
    CONSTRAINT thread_follows_message_channel_fkey
        FOREIGN KEY (message_id, channel_id) REFERENCES messages (id, channel_id)
        ON DELETE CASCADE,
    CONSTRAINT thread_follows_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE
);

-- A reply reads its thread's choices by the root: one indexed lookup per reply, as D-29's is. It
-- also indexes the composite key (D-89).
CREATE INDEX idx_thread_follows_message ON thread_follows (message_id, channel_id);
-- Every foreign key indexed (D-89); `user_id` leads the primary key.
CREATE INDEX idx_thread_follows_channel ON thread_follows (channel_id, workspace_id);
CREATE INDEX idx_thread_follows_workspace ON thread_follows (workspace_id);
