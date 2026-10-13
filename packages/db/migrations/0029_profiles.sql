-- purlay: no-transaction
-- 0029_profiles
--
-- A person's profile (#488, D-131): a title, a time zone, and a short status line, each the
-- person's own to set or clear. Their name and avatar stay GitHub's.
--
--   * Each NULL until set; never an empty string, and never longer than the contract allows.
--   * `time_zone` is an IANA name, checked by the service against the runtime's own list: the
--     database holds the length only, so a name the runtime learns later is not refused here.
--
-- On a table with rows, outside the migrator's transaction (D-86), in 0027's order: the columns,
-- each check NOT VALID and then validated. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS title VARCHAR(80);
ALTER TABLE users ADD COLUMN IF NOT EXISTS time_zone VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text VARCHAR(100);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_not_blank;
ALTER TABLE users
    ADD CONSTRAINT users_profile_not_blank CHECK (
        (title IS NULL OR btrim(title) <> '')
        AND (time_zone IS NULL OR btrim(time_zone) <> '')
        AND (status_text IS NULL OR btrim(status_text) <> '')
    ) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_profile_not_blank;

RESET lock_timeout;
