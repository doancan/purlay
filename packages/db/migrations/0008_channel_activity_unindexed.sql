-- purlay: no-transaction
-- 0008_channel_activity_unindexed
--
-- `idx_channels_workspace` ordered a workspace's channels by `last_message_at`, and
-- every send writes that column. A column that is part of an index cannot be changed
-- by a heap-only update, so each send wrote a new version of the channel row and a new
-- entry in every one of the channel's indexes: 0 of 2,000 updates were HOT, and the
-- indexes grew with traffic instead of with channels (D-88).
--
-- The index now covers only `workspace_id`, and is not partial: it is also the index
-- the foreign key to `workspaces` needs, and deleting a workspace asks it for every
-- channel, deleted or not. A workspace has tens or hundreds of
-- channels, so the sidebar sorts what the index finds; the sort is the cheaper side of
-- the trade, and `last_message_at` is free to move.
--
-- Written the way it would have to run on a table that is large and busy, although
-- `channels` is neither: it opts out of the migrator's transaction (D-86) so the index
-- is built CONCURRENTLY, and it can be run again after a crash at any point. The new
-- index is built under a second name, the old one dropped, and the new one renamed;
-- the leftover of an interrupted build is an INVALID index, so it is dropped first.

DROP INDEX CONCURRENTLY IF EXISTS idx_channels_workspace_next;

CREATE INDEX CONCURRENTLY idx_channels_workspace_next
    ON channels (workspace_id);

DROP INDEX CONCURRENTLY IF EXISTS idx_channels_workspace;

ALTER INDEX idx_channels_workspace_next RENAME TO idx_channels_workspace;
