-- purlay: no-transaction
-- 0066_quiet_hours
--
-- A person's quiet hours (D-234): a window of the day, on chosen days of the week, read in the time zone of
-- their profile (`users.time_zone`), when the server holds back what would interrupt them as Deep Work does.
--
--   * `quiet_from`, `quiet_to`: minutes after midnight, 0–1439. `from` later than `to` runs past midnight.
--   * `quiet_days`: the days a window starts on, a bit each from Sunday (1) to Saturday (64), never none.
--   * All three NULL, or all three set (`users_quiet_hours_whole`); the two ends never equal.
--
-- Per person, not per workspace: an evening is the person's in every workspace they are in.
--
-- Rollback: nothing reads these but the delivery's Deep Work check and the setting itself; NULL is "no quiet
-- hours", what every account had. `ALTER TABLE users DROP COLUMN quiet_from, DROP COLUMN quiet_to, DROP COLUMN
-- quiet_days` in a new migration undoes it.
--
-- On a table with rows, outside the migrator's transaction (D-86): nullable columns without a default are
-- catalogue changes; the checks are added NOT VALID and then validated. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_from SMALLINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_to SMALLINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_days SMALLINT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_quiet_hours_whole;
ALTER TABLE users
    ADD CONSTRAINT users_quiet_hours_whole CHECK (
        (quiet_from IS NULL AND quiet_to IS NULL AND quiet_days IS NULL)
        OR (
            quiet_from BETWEEN 0 AND 1439
            AND quiet_to BETWEEN 0 AND 1439
            AND quiet_from <> quiet_to
            AND quiet_days BETWEEN 1 AND 127
        )
    ) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_quiet_hours_whole;
