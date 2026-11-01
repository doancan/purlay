-- 0073_session_lifetime
--
-- The server's session lifetime policy (D-244), two settings of the server's own beside the sign-in policy (0068):
--
--   * `session_idle_timeout_hours`: a session not used for this many hours is signed out. NULL, as every server was
--     until now: a session is never signed out for being unused.
--   * `session_max_age_days`: a session lives at most this many days from its sign-in, whatever its use. NULL, as
--     every server was until now: a session lives as long as `SESSION_TTL_DAYS` made it (`sessions.expires_at`).
--
-- Which values may be chosen is `@purlay/types`' (`SESSION_IDLE_TIMEOUT_HOURS`, `SESSION_MAX_AGE_DAYS`), checked by
-- the application before a value is saved; the database refuses only what no policy could mean — zero or less.
-- Neither is written into `sessions`: a session's end is judged from its own `created_at` and `last_used_at` each
-- time it is read, so a change applies to every session there is, from the next request.
--
-- Rollback: `ALTER TABLE server_settings DROP COLUMN session_idle_timeout_hours, DROP COLUMN session_max_age_days` in a
-- new migration, after the code that reads them is gone — every session then lives as long as `SESSION_TTL_DAYS`,
-- unused or not, as before.
--
-- The table holds one row, so this runs inside the migrator's transaction: a nullable column is a catalogue change.

ALTER TABLE server_settings ADD COLUMN session_idle_timeout_hours SMALLINT;

ALTER TABLE server_settings ADD COLUMN session_max_age_days SMALLINT;

ALTER TABLE server_settings
    ADD CONSTRAINT server_settings_session_lifetime_positive
        CHECK (session_idle_timeout_hours > 0 AND session_max_age_days > 0);
