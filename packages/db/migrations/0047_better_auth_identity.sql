-- 0047_better_auth_identity
--
-- The tables Better Auth keeps its identity in (D-179): the library owns sign-in and sessions, and
-- these are what its schema check demands beyond the `users` and `sessions` that already exist. It
-- compares the database with what it expects on its first request and refuses to run on a missing
-- table or column, so the shapes here are Better Auth's own core schema under Purlay's names; the
-- mapping is `createAuth` in `apps/api/src/modules/auth/better-auth.ts`.
--
--   * `users.email_verified`: a sign-in by a provider that vouches for an address sets it, and an
--     address that is not verified is never linked to by one that is (D-179 §5). FALSE for every
--     account there is: nothing has verified one before now, and an invitation is accepted only by
--     an account whose address is.
--   * `users.is_server_admin`: who may change the server's settings. A column of ours and not the
--     library's Admin plugin, which is not installed and whose other columns nothing would use.
--   * `accounts`: one row for each way a person signs in — a provider's account, or the password
--     of a credential account. `(provider_id, account_id)` is that identity, so a provider's account
--     is one row however many times it signs in.
--   * `verifications`: the library's short-lived tokens, a sign-in link among them.
--   * `rate_limits`: its counters for sign-in attempts, kept here so that they survive a restart and
--     are shared by every process; in memory a restart would hand back every attempt.
--
-- `accounts.access_token`, `refresh_token` and `id_token` exist because the schema check demands
-- them, and are never written: a hook of `createAuth` nulls them, since Purlay never calls GitHub on a
-- person's behalf and a stored token would be a credential kept for nothing (D-179). `sessions` needs nothing: `updatedAt` maps to
-- `last_used_at`. Its `revoked_at` stays and is not used, as the library deletes the row of a
-- session that ends.
--
-- No data moves. Every table is new, and the two columns of `users` have a default.

ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN is_server_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE accounts (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_id              TEXT NOT NULL,
    account_id               TEXT NOT NULL,
    access_token             TEXT,
    refresh_token            TEXT,
    id_token                 TEXT,
    access_token_expires_at  TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    scope                    TEXT,
    password                 TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (provider_id, account_id)
);

CREATE INDEX idx_accounts_user ON accounts (user_id);

CREATE TABLE verifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier  TEXT NOT NULL,
    value       TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_verifications_identifier ON verifications (identifier);

CREATE TABLE rate_limits (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key           TEXT NOT NULL UNIQUE,
    count         INTEGER NOT NULL,
    -- Milliseconds since the epoch, as the library writes it: BIGINT, so a string in `schema.ts`.
    last_request  BIGINT NOT NULL
);
