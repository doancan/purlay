-- purlay: no-transaction
-- 0063_channel_retention
--
-- A channel may keep its history longer than its workspace does, forever included — never shorter
-- (D-225). Two columns, so neither means its opposite:
--
--   * `min_retention_days`: the fewest whole days the channel keeps, whatever the workspace's window.
--     NULL: no floor of its own. The workspace's floor of 30 (`retention_days_sane`, D-27) holds here too.
--   * `retain_forever`: the channel keeps everything. Never beside a number of days.
--   * A direct message has neither: it is not a channel anybody configures (D-123).
--
-- What the purge keeps is the longer of the two windows, computed by the purge on every batch
-- (`modules/retention/purge.ts`), never trusted from the stored number: a workspace lengthened past a
-- channel's floor afterwards keeps the workspace's window, and one shortened keeps the channel's. That
-- "longer, never shorter" is not a CHECK: it compares two rows' columns, and the workspace's changes on
-- its own.
--
-- No index: the purge already reads by `idx_messages_workspace_age` and looks each row's channel up by
-- its primary key (D-225).
--
-- Rollback: nothing reads these columns but this feature, and NULL/false is "follow the workspace", which
-- is what every channel did before. `ALTER TABLE channels DROP COLUMN min_retention_days, DROP COLUMN
-- retain_forever` in a new migration undoes it, after which the purge would apply the workspace's window
-- to every channel again — a channel set to keep longer would lose what is past it the next night, so
-- that is a decision, not a cleanup.
--
-- On a table with rows, outside the migrator's transaction (D-86), in 0029's order: the columns, then
-- each check NOT VALID and validated. A constant default is a catalogue change. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE channels ADD COLUMN IF NOT EXISTS min_retention_days INTEGER;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS retain_forever BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_retention_sane;
ALTER TABLE channels
    ADD CONSTRAINT channels_retention_sane CHECK (
        (min_retention_days IS NULL OR min_retention_days >= 30)
        AND NOT (retain_forever AND min_retention_days IS NOT NULL)
        AND (type <> 'direct_message' OR (min_retention_days IS NULL AND NOT retain_forever))
    ) NOT VALID;
ALTER TABLE channels VALIDATE CONSTRAINT channels_retention_sane;

RESET lock_timeout;
