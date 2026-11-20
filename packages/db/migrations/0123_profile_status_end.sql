-- purlay: no-transaction
-- 0123_profile_status_end
--
-- A status line that clears itself, with an emoji (D-330): when it ends, and the one emoji beside its words. Both
-- NULL for a line that stays until changed, and for every row there is today — so nothing is backfilled and an old
-- server reading a new row sees the line it always saw. The service checks the emoji and the end; the database
-- holds the length only, as it does for the words (0029).
--
-- Adding a nullable column with no default rewrites no row. Outside the migrator's transaction, as 0029 is (D-86),
-- with a short lock wait; each step can run again.

SET lock_timeout = '10s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS status_emoji VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_until TIMESTAMPTZ;

RESET lock_timeout;
