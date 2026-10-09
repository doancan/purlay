-- purlay: no-transaction
-- 0009_foreign_key_indexes
--
-- A foreign key is enforced by a query on the referencing table: deleting a row of
-- the parent asks the child "do you still have rows pointing at this?", and a cascade
-- asks it for every one. With no index on the referencing column, each of those is a
-- scan of the whole child table, once per deleted parent row. On 1,000,000 messages,
-- deleting 100 of them took 4.9 s, and deleting one channel did not finish in 60 s,
-- because `messages.parent_id` and `channel_members.last_read_message_id` had nothing
-- to look in (D-89).
--
-- What was missing, by column:
--   messages.channel_id, messages.workspace_id   the partial indexes cannot answer an
--                                                unfiltered "any row for this channel"
--   messages.parent_id, messages.resolved_by     likewise, or no index at all
--   channel_members.last_read_message_id         none
--   channels.created_by, workspaces.created_by   none
-- The nullable ones are indexed only where they are set, which is what a lookup by value
-- needs and keeps the index small. `sessions.revoked_at` is not a foreign key; the purge
-- of dead sessions (D-87) looks for revoked rows by it.
--
-- `idx_workspaces_slug` is dropped: it indexed the column the UNIQUE constraint already
-- indexes, so every write to `workspaces` paid for it twice and no query could prefer it.
--
-- The `idx_messages_*` partial indexes stay; they answer the feed, the thread, the search
-- and the open questions, none of which the indexes below can.
--
-- Written the way it has to run on a large table, which is the point of the file: it leaves
-- the migrator's transaction (D-86) so every index is built CONCURRENTLY and writers are
-- not blocked, and it can be run again after a crash at any point. An interrupted build
-- leaves an INVALID index that `IF NOT EXISTS` would treat as present, so each is dropped
-- first.

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_channel;
CREATE INDEX CONCURRENTLY idx_messages_channel ON messages (channel_id);

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_workspace;
CREATE INDEX CONCURRENTLY idx_messages_workspace ON messages (workspace_id);

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_parent;
CREATE INDEX CONCURRENTLY idx_messages_parent
    ON messages (parent_id) WHERE parent_id IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_resolved_by;
CREATE INDEX CONCURRENTLY idx_messages_resolved_by
    ON messages (resolved_by) WHERE resolved_by IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_channel_members_last_read;
CREATE INDEX CONCURRENTLY idx_channel_members_last_read
    ON channel_members (last_read_message_id) WHERE last_read_message_id IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_channels_created_by;
CREATE INDEX CONCURRENTLY idx_channels_created_by
    ON channels (created_by) WHERE created_by IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_workspaces_created_by;
CREATE INDEX CONCURRENTLY idx_workspaces_created_by
    ON workspaces (created_by) WHERE created_by IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_revoked;
CREATE INDEX CONCURRENTLY idx_sessions_revoked
    ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;

DROP INDEX CONCURRENTLY IF EXISTS idx_workspaces_slug;
