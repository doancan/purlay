-- 0062_channel_bookmarks
--
-- A channel's bookmarks (D-218): links its members keep at hand — a document, a dashboard, a repository —
-- shown under the channel's header.
--
--   * One row per address in a channel: the same address added again is the same bookmark.
--   * The channel in this workspace (I-4): the composite key `pinned_messages` has, so a bookmark cannot
--     point across a tenant.
--   * `added_by` outlives its person as NULL: the bookmark is the channel's, not theirs.
--   * Bounded where it is written: the address to what a URL may be, the title to what a chip shows; the
--     count per channel by the service (`BOOKMARKS_MAX`), under the channel's lock.
--   * Cascades with the channel and the workspace.
--
-- A new table with no rows: one transaction, as 0028.

CREATE TABLE channel_bookmarks (
    id            UUID PRIMARY KEY,
    channel_id    UUID NOT NULL,
    workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    url           TEXT NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
    title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
    added_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT channel_bookmarks_channel_workspace_fkey
        FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
        ON DELETE CASCADE,
    CONSTRAINT channel_bookmarks_channel_url_key UNIQUE (channel_id, url)
);

-- Every foreign key indexed (D-89). The unique key leads with the channel, so it is also what lists a
-- channel's bookmarks; the order they are shown in is `added_at`, read from at most twenty rows.
CREATE INDEX idx_channel_bookmarks_workspace ON channel_bookmarks (workspace_id);
CREATE INDEX idx_channel_bookmarks_added_by ON channel_bookmarks (added_by);
