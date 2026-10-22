-- 0055_backfill_existing_identities
--
-- What an install from before Better Auth (0047) needs so that the people already in it can sign in as
-- they did (D-179 §7). Two things 0047 could not know, both found by upgrading a database made by the
-- previous release:
--
--   1. **An `accounts` row for each GitHub person.** The library finds a GitHub sign-in by
--      `(provider_id, account_id)` and nothing else. A person whose only trace of GitHub is
--      `users.github_id` was not found, and the library then tried to make a user on the same address
--      and refused (`email-taken`): the people who had signed in with GitHub all along were locked out.
--      One row each, `provider_id = 'github'`, `account_id` the id as text — the form the library
--      writes. No token is stored (0047). A person who has such a row is left alone, so is a `github_id`
--      another row already holds.
--   2. **`users.email_verified = TRUE` for the people who proved their address then.** 0047 set FALSE
--      for everyone, but before it an account was made only by a GitHub sign-in that took the primary
--      *verified* address, or by spending a link mailed to the address: every account there was had
--      proven it. Left FALSE, the sign-in link is never sent to such a person (a link to an unproven
--      address is refused, D-179 §4) and an invitation cannot be accepted by them. Only the people who
--      existed when 0047 ran are touched — `created_at` before its row in `kysely_migration` — so an
--      account made since, the setup's administrator included, keeps the proof it has earned. An
--      erased account is left as it is.
--
-- Idempotent, and a database with nobody in it gains nothing.

INSERT INTO accounts (user_id, provider_id, account_id, created_at, updated_at)
SELECT u.id, 'github', u.github_id::TEXT, COALESCE(u.github_connected_at, u.created_at), NOW()
FROM users u
WHERE u.github_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.provider_id = 'github')
ON CONFLICT (provider_id, account_id) DO NOTHING;

UPDATE users
SET email_verified = TRUE, updated_at = NOW()
WHERE email_verified = FALSE
  AND deleted_at IS NULL
  AND created_at < (
    SELECT m.timestamp::TIMESTAMPTZ FROM kysely_migration m WHERE m.name = '0047_better_auth_identity'
  );
