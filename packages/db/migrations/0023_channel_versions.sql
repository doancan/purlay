-- purlay: no-transaction
-- 0023_channel_versions
--
-- A channel's name and topic are told to the room as a whole-state frame, `CHANNEL_UPDATED`
-- (D-123): two renames published from different requests can arrive in the opposite order to the
-- one they committed in, and the older name would replace the newer on every screen that heard it.
-- So the channel row counts its own changes, as `channel_members` and `messages` do (0015): one up
-- in the statement that renames, under the row lock it already takes, and a client drops a frame
-- older than what it has applied.
--
-- Not in any index, so a send's `last_message_at` write is still heap-only (D-88). A constant
-- default is a catalogue change; outside the migrator's transaction with a bounded lock wait, and
-- safe to run again, as 0015 is.

SET lock_timeout = '10s';

ALTER TABLE channels ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 0;

RESET lock_timeout;
