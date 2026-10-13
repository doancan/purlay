-- purlay: no-transaction
-- 0027_attachment_channels
--
-- A channel's files (#485, D-129): every attachment of a message in it, newest message first. An
-- attachment knew its message and its workspace, not its channel, and no index could find a
-- channel's files without walking every message of the channel.
--
--   * `channel_id` — NULL while unattached, the message's channel once linked; set where the link is
--     made (`linkAttachments`), backfilled here for the rows already linked.
--   * `attachments_channel_iff_message` — linked and channelled together, or neither.
--   * `attachments_message_channel_fkey` — the message is in this channel (I-1), as `mentions` holds.
--   * `idx_attachments_channel` — a channel's linked files by message, newest first: the Files page.
--
-- Written for a table that has rows, outside the migrator's transaction (D-86), in 0010's order:
-- the column, the backfill, each constraint NOT VALID and then validated, the index built
-- CONCURRENTLY. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS channel_id UUID;

UPDATE attachments
SET channel_id = messages.channel_id
FROM messages
WHERE attachments.message_id = messages.id
  AND attachments.channel_id IS NULL;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_channel_iff_message;
ALTER TABLE attachments
    ADD CONSTRAINT attachments_channel_iff_message
    CHECK ((message_id IS NULL) = (channel_id IS NULL)) NOT VALID;
ALTER TABLE attachments VALIDATE CONSTRAINT attachments_channel_iff_message;

ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_message_channel_fkey;
ALTER TABLE attachments
    ADD CONSTRAINT attachments_message_channel_fkey
    FOREIGN KEY (message_id, channel_id) REFERENCES messages (id, channel_id)
    ON DELETE CASCADE NOT VALID;
ALTER TABLE attachments VALIDATE CONSTRAINT attachments_message_channel_fkey;

DROP INDEX CONCURRENTLY IF EXISTS idx_attachments_channel;
CREATE INDEX CONCURRENTLY idx_attachments_channel
    ON attachments (channel_id, message_id DESC, id DESC) WHERE message_id IS NOT NULL;

RESET lock_timeout;
