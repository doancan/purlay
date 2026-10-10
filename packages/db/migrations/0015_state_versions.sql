-- purlay: no-transaction
-- 0015_state_versions
--
-- Three frames carry a *whole* state and ask the client to replace what it holds:
-- `THREAD_UPDATED` (a root's summary), `REACTIONS_UPDATED` (a message's set) and
-- `CHANNEL_STATE` (one person's position and counters). Whole states are why a missed frame is
-- repaired by the next one — and why a *late* one is harmful: two writes commit in one order
-- and are published, after their commits and from different requests, in another, and the
-- client then replaces the newer state with the older one and keeps it until something else
-- moves. The frames' `ts` cannot order them (it is read when the frame is published, not when
-- the write committed, and two writes in one millisecond tie).
--
-- So each row that such a frame is made from counts its own changes: `state_version` goes up by
-- one in the same statement that changes the state, under the row lock that statement already
-- takes, so the order of the versions *is* the order of the commits. The frame carries the
-- version its state was read at, and a client keeps the newest it has applied for each thing
-- and drops a frame that is not newer (D-99 §2, amended).
--
--   channel_members.state_version  the person's position and counters in one channel
--   messages.state_version         the message's thread summary and its reactions together
--                                  (both are written under a lock on the message's row, so one
--                                  counter orders them; a client keeps one per frame kind)
--
-- A constant default is a catalogue change in PostgreSQL 11 and later: no table rewrite, no
-- lock beyond the instant of the ALTER, so this is safe on a table with rows. It still runs
-- outside the migrator's transaction and bounds its lock wait (D-86), as 0010 and 0013 do, so
-- a long transaction ahead of it fails the migration instead of queueing every query on the
-- table behind it; and it can be run again after a crash at any point.

SET lock_timeout = '10s';

ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages        ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 0;

RESET lock_timeout;
