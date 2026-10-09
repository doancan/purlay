-- purlay: no-transaction
-- 0010_tenant_integrity
--
-- Tenant isolation was a convention the service kept. One transaction inserted a
-- message with `workspace_id` of workspace A and `channel_id` of a channel in B, and a
-- reply whose channel and workspace differed from its parent's: the database accepted
-- both, and so a `dm_key` of 'garbage' and a `messages.id` that was a v4 (D-90). D-21
-- calls a tenant leak the one unrecoverable defect class; this makes the three that can
-- be a constraint into constraints.
--
--   messages (channel_id, workspace_id) -> channels (id, workspace_id)
--       a message is in the workspace of its channel (I-4)
--   messages (parent_id, channel_id) -> messages (id, channel_id)
--       a reply is in its parent's channel, and so its parent's workspace (I-1, in part)
--   channel_members (last_read_message_id, channel_id) -> messages (id, channel_id)
--       a read position is a message of that channel (I-3)
--   messages_id_is_uuidv7       the id carries version 7 and the RFC variant (D-8)
--   dm_key_form                 two lower-case member ids, sorted, joined with ':' (I-5)
--
-- Each composite key replaces the single-column key it contains: the new one enforces
-- the same cascade or restriction and the tenant rule besides, so keeping both would pay
-- for two triggers per row. The read-position key clears only `last_read_message_id` when
-- its message goes (`SET NULL (column)`); the plain form would also clear the channel_id
-- that membership cannot exist without.
--
-- What stays in the service, and why, is in SCHEMA.md §11: a UUIDv7's timestamp cannot be
-- checked against the clock by a CHECK (it must be immutable), depth of a thread and the
-- reply counter would need a trigger or a rewrite of `messages`, and they are not here.
--
-- Written for a table that has rows, and run outside the migrator's transaction (D-86):
--   * the two unique constraints the keys point at are built as indexes CONCURRENTLY and
--     then attached, which takes the exclusive lock for the attach and not for a build;
--   * every key and check is added NOT VALID, which checks new rows at once and takes a
--     lock that lasts only as long as the statement, and validated in the next statement,
--     which scans without blocking readers or writers. Had this run inside the transaction, the lock of the
--     first statement would have been held across the scan: that is what 0007 did, with
--     nothing to lose because the table was empty.
--   * a lock wait is bounded, so a long transaction ahead of an ALTER fails this
--     migration instead of queueing every query on the table behind it.
--
-- "Brief" is not "nothing". Each ALTER TABLE has to be granted its lock, which means waiting
-- for every transaction already using the table, and a send holds `messages` and then
-- `channels` where this file asks for them in the other order. Under load the two can wait
-- for each other: at about 5,000 writes a second the migrator was ended with "deadlock
-- detected" (at about 150 a second ten runs in ten were untouched). The migrator now runs a
-- migration again when PostgreSQL ends it that way, which is safe here because of the next
-- paragraph, and a migration like this one is still best run at low traffic (D-86).
--
-- It can be run again after a crash at any point: everything it adds is dropped first.
-- A row that already breaks a rule fails the VALIDATE, loudly, and nothing is half-applied
-- that would hide it: the constraint is present and unvalidated until someone fixes the row
-- and runs this again.

SET lock_timeout = '10s';

-- Drop what this file adds, so it can run again.
ALTER TABLE channel_members DROP CONSTRAINT IF EXISTS channel_members_last_read_channel_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_parent_channel_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_workspace_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_id_channel_id_key;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_id_workspace_id_key;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_id_is_uuidv7;
ALTER TABLE channels DROP CONSTRAINT IF EXISTS dm_key_form;
DROP INDEX CONCURRENTLY IF EXISTS messages_id_channel_id_ix;
DROP INDEX CONCURRENTLY IF EXISTS channels_id_workspace_id_ix;

-- The targets of the composite keys.
CREATE UNIQUE INDEX CONCURRENTLY channels_id_workspace_id_ix ON channels (id, workspace_id);
ALTER TABLE channels
    ADD CONSTRAINT channels_id_workspace_id_key UNIQUE USING INDEX channels_id_workspace_id_ix;

CREATE UNIQUE INDEX CONCURRENTLY messages_id_channel_id_ix ON messages (id, channel_id);
ALTER TABLE messages
    ADD CONSTRAINT messages_id_channel_id_key UNIQUE USING INDEX messages_id_channel_id_ix;

-- A message is in the workspace of its channel.
ALTER TABLE messages
    ADD CONSTRAINT messages_channel_workspace_fkey
    FOREIGN KEY (channel_id, workspace_id) REFERENCES channels (id, workspace_id)
    ON DELETE CASCADE NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_channel_workspace_fkey;

-- A reply is in its parent's channel. RESTRICT: a thread is not taken with its root (D-9).
ALTER TABLE messages
    ADD CONSTRAINT messages_parent_channel_fkey
    FOREIGN KEY (parent_id, channel_id) REFERENCES messages (id, channel_id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_parent_channel_fkey;

-- A read position is a message of that channel.
ALTER TABLE channel_members
    ADD CONSTRAINT channel_members_last_read_channel_fkey
    FOREIGN KEY (last_read_message_id, channel_id) REFERENCES messages (id, channel_id)
    ON DELETE SET NULL (last_read_message_id) NOT VALID;
ALTER TABLE channel_members VALIDATE CONSTRAINT channel_members_last_read_channel_fkey;

-- The single-column keys these contain.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_id_fkey;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_parent_id_fkey;
ALTER TABLE channel_members DROP CONSTRAINT IF EXISTS channel_members_last_read_message_id_fkey;

-- The shape of a message id: version 7, RFC variant. The same pattern as the contract's
-- `isMessageIdShape` (packages/types/src/message-id.ts); a test makes the two agree.
ALTER TABLE messages
    ADD CONSTRAINT messages_id_is_uuidv7
    CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_id_is_uuidv7;

-- The shape of a DM key: two lower-case ids, the first not above the second, byte-wise.
-- `<=`, not `<`: nothing here forbids a conversation with oneself, and a constraint that
-- decided it would be deciding a product question.
ALTER TABLE channels
    ADD CONSTRAINT dm_key_form
    CHECK (
        dm_key IS NULL
        OR (
            dm_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND split_part(dm_key, ':', 1) COLLATE "C" <= split_part(dm_key, ':', 2) COLLATE "C"
        )
    ) NOT VALID;
ALTER TABLE channels VALIDATE CONSTRAINT dm_key_form;

RESET lock_timeout;
