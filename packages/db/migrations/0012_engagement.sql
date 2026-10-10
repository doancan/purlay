-- 0012_engagement
--
-- What people do to a message beyond writing it: react to it, name someone in it,
-- and be told. The three tables the wedge needs (D-98, D-99). Attachments are the
-- fourth member of the group `SCHEMA.md` §7 describes and are not built yet; they
-- arrive in their own migration with their endpoints.
--
-- New, empty tables, so this runs inside the migrator's transaction: nothing here
-- holds a lock on a table that has rows.
--
-- Append-only: never edited after it has been applied. The migrations are the
-- single source for the data model; packages/db/src/schema.ts is generated from
-- them and never written by hand. (D-45, CONTRIBUTING.md §1.6)
--
-- Tenant isolation is a constraint here from the first row (D-90) rather than a
-- convention to retrofit: a mention or a notification is in the workspace of its
-- channel and the channel of its message, and the database refuses a row that is
-- not. Every foreign key column leads an index the planner can use for it (D-89),
-- so deleting a message or a channel does not scan these tables.

-- A reaction. Unicode emoji only; no custom emoji management, ever. (D-4)
CREATE TABLE reactions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    emoji      VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (message_id, user_id, emoji)
);

-- Deleting a message finds its reactions by `message_id`: the unique key above leads with it, so
-- it is the index (a second one on the same column is refused by the schema test).
CREATE INDEX idx_reactions_user ON reactions (user_id);

-- Who a message names, resolved at write time so no fan-out re-parses a body. (D-12)
-- `@here` and `@channel` never reach this table: the parser refuses them.
CREATE TABLE mentions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id        UUID NOT NULL REFERENCES channels(id)   ON DELETE CASCADE,
    message_id        UUID NOT NULL REFERENCES messages(id)   ON DELETE CASCADE,
    mentioned_user_id UUID NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (message_id, mentioned_user_id),

    -- The message is in this channel, and the channel in this workspace. (I-1, I-4)
    CONSTRAINT mentions_message_channel_fkey
        FOREIGN KEY (message_id, channel_id) REFERENCES messages (id, channel_id)
        ON DELETE CASCADE,
    CONSTRAINT mentions_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_mentions_user
    ON mentions (mentioned_user_id, workspace_id, created_at DESC);
CREATE INDEX idx_mentions_workspace ON mentions (workspace_id);
CREATE INDEX idx_mentions_channel   ON mentions (channel_id);

-- A person was told. Written even when Deep Work suppresses delivery, so nothing is
-- lost and a digest stays possible. (D-15) One row per person, message and kind: a
-- resolution is a second thing to tell the author of the root, not a replacement
-- for the mention that already did. (D-29, D-99)
CREATE TABLE notifications (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id   UUID NOT NULL REFERENCES channels(id)   ON DELETE CASCADE,
    message_id   UUID NOT NULL REFERENCES messages(id)   ON DELETE CASCADE,

    type         notification_type NOT NULL,

    -- Written but not delivered. Distinguishes "we chose not to interrupt you"
    -- from "nothing happened".
    suppressed_by_deep_work BOOLEAN NOT NULL DEFAULT FALSE,

    read_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (user_id, message_id, type),

    CONSTRAINT notifications_message_channel_fkey
        FOREIGN KEY (message_id, channel_id) REFERENCES messages (id, channel_id)
        ON DELETE CASCADE,
    CONSTRAINT notifications_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE
);

-- The badge query: unread notifications for one person, newest first.
CREATE INDEX idx_notifications_unread
    ON notifications (user_id, workspace_id, created_at DESC)
    WHERE read_at IS NULL;

-- Reading a channel marks its notifications read and recounts what is left (D-99 §4):
-- one person, one channel, past a position.
CREATE INDEX idx_notifications_channel_unread
    ON notifications (user_id, channel_id, message_id)
    WHERE read_at IS NULL;

CREATE INDEX idx_notifications_workspace ON notifications (workspace_id);
CREATE INDEX idx_notifications_channel   ON notifications (channel_id);
CREATE INDEX idx_notifications_message   ON notifications (message_id);
