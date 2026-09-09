-- 0006_channel_members
--
-- Membership, read position and the denormalised unread counters (D-13). Last, because `last_read_message_id` references `messages`.
--
-- Append-only: never edited after it has been applied. The migrations are the
-- single source for the data model; packages/db/src/schema.ts is generated from
-- them and never written by hand. (D-45, CONTRIBUTING.md §1.6)

CREATE TABLE channel_members (
    id         UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,

    last_read_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,

    -- Maintained on write. A COUNT(*) per channel per sidebar render is the
    -- N+1 the project rules forbid. (D-13)
    unread_count         INTEGER NOT NULL DEFAULT 0,
    unread_mention_count INTEGER NOT NULL DEFAULT 0,

    -- Defaults to 'mentions': quiet by default is the product, not a preference. (D-12)
    notification_level notification_level NOT NULL DEFAULT 'mentions',

    joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (channel_id, user_id),
    CONSTRAINT unread_counts_non_negative
        CHECK (unread_count >= 0 AND unread_mention_count >= 0)
);

CREATE INDEX idx_channel_members_user ON channel_members (user_id);
