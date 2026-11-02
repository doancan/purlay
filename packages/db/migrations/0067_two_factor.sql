-- purlay: no-transaction
-- 0067_two_factor
--
-- Two-step verification for an account that signs in with a password (D-236): a code from an authenticator
-- app after the password, or one of ten backup codes. The sign-in library's two-factor plugin keeps it, under
-- Purlay's names (`createAuth`, `apps/api/src/modules/auth/better-auth.ts`), so these are its schema.
--
--   * `users.two_factor_enabled`: whether a password sign-in asks for the second step. Set by the library only
--     once a code from the app was right; FALSE for every account there is.
--   * `two_factors`: one row per person who began to turn it on. `secret` is the authenticator's key and
--     `backup_codes` the unused codes as JSON, both sealed by the library under the server's derived secret
--     (never the key or a code as it is shown); `verified` is FALSE until the first right code, and a row
--     that is not verified asks nothing of a sign-in. `failed_verification_count` and `locked_until` are the
--     library's lockout of wrong codes at sign-in. One row a person (`two_factors_user_key`): the library
--     looks it up by the person and writes it once.
--
-- Rollback: `DROP TABLE two_factors` and `ALTER TABLE users DROP COLUMN two_factor_enabled` in a new migration,
-- after the plugin is gone — every account then signs in with its password alone, as before this.
--
-- On a table with rows, outside the migrator's transaction (D-86): a column with a constant default is a
-- catalogue change; the new table has no rows. Each step can run again.

SET lock_timeout = '10s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE;

RESET lock_timeout;

CREATE TABLE IF NOT EXISTS two_factors (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret                     TEXT NOT NULL,
    backup_codes               TEXT NOT NULL,
    verified                   BOOLEAN NOT NULL DEFAULT FALSE,
    failed_verification_count  INTEGER NOT NULL DEFAULT 0,
    locked_until               TIMESTAMPTZ,

    CONSTRAINT two_factors_user_key UNIQUE (user_id),
    CONSTRAINT two_factors_failures_counted CHECK (failed_verification_count >= 0)
);
