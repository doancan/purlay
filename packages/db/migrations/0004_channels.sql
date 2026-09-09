-- 0004_channels
--
-- Channels, private channels and DMs share one table (D-6). `channel_members` waits for 0006 because it references `messages`.
--
-- Append-only: never edited after it has been applied. The migrations are the
-- single source for the data model; packages/db/src/schema.ts is generated from
-- them and never written by hand. (D-45, CONTRIBUTING.md §1.6)

CREATE TABLE channels (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

    -- NULL for DMs, which are identified by their members, not by a name.
    -- COLLATE "C" so that lower(name) folds identically on every deployment: under a Turkish
    -- locale lower('İ') does not produce 'i', and channel-name uniqueness would otherwise
    -- depend on how the server was provisioned. (D-40)
    name         VARCHAR(64) COLLATE "C",
    topic        TEXT,
    type         channel_type NOT NULL DEFAULT 'public',

    -- Sorted, colon-joined pair of user UUIDs. Set only for DMs; the partial
    -- unique index below uses it to stop a second DM opening between the same pair.
    dm_key       TEXT,

    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Denormalized so the sidebar can order channels without touching `messages`.
    last_message_at TIMESTAMPTZ,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ,

    CONSTRAINT named_unless_dm CHECK (
        (type = 'direct_message' AND name IS NULL)
        OR (type <> 'direct_message' AND name IS NOT NULL)
    ),
    CONSTRAINT dm_key_iff_dm CHECK (
        (type = 'direct_message') = (dm_key IS NOT NULL)
    )
);

-- Channel names are unique per workspace, case-insensitively, and only among
-- live named channels. Deleting #api frees the name for reuse.
CREATE UNIQUE INDEX idx_channels_unique_name
    ON channels (workspace_id, lower(name))
    WHERE type <> 'direct_message' AND deleted_at IS NULL;

-- One DM per pair per workspace.
CREATE UNIQUE INDEX idx_channels_unique_dm
    ON channels (workspace_id, dm_key)
    WHERE type = 'direct_message';

CREATE INDEX idx_channels_workspace
    ON channels (workspace_id, last_message_at DESC NULLS LAST)
    WHERE deleted_at IS NULL;
