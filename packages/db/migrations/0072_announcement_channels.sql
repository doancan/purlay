-- purlay: no-transaction
-- 0072_announcement_channels
--
-- A channel whose feed only the workspace's owners and admins post in (D-243): an announcement channel.
--
--   * `only_admins_post`: a root message by somebody whose workspace role is `member` is refused; a reply
--     in a thread, an edit of one's own message and a GitHub feed's event are not. FALSE, as every channel
--     was until now.
--   * A direct message has none: it is not a channel anybody configures (D-123), and its people are all
--     the conversation there is.
--
-- No index: the flag is read by the channel's primary key on a send, and never searched by.
--
-- Rollback: `ALTER TABLE channels DROP CONSTRAINT channels_only_admins_post_not_dm, DROP COLUMN
-- only_admins_post` in a new migration, after the code that reads it is gone — every channel then takes a
-- root from any of its members again.
--
-- On a table with rows, outside the migrator's transaction (D-86), in 0063's order: the column (a constant
-- default is a catalogue change), then the check NOT VALID and validated. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE channels ADD COLUMN IF NOT EXISTS only_admins_post BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_only_admins_post_not_dm;
ALTER TABLE channels
    ADD CONSTRAINT channels_only_admins_post_not_dm CHECK (
        type <> 'direct_message' OR NOT only_admins_post
    ) NOT VALID;
ALTER TABLE channels VALIDATE CONSTRAINT channels_only_admins_post_not_dm;

RESET lock_timeout;
