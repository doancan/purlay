-- 0045_users_github_login
--
-- The GitHub login, as GitHub last gave it, in a column of its own (D-169).
--
-- `WORKSPACE_CREATORS` names GitHub logins, and was matched against `username` — but a username is
-- this instance's name for a person, not GitHub's: a login another account already holds here is
-- stored with a `-N` suffix, an email link names its account after the address, and an erased-looking
-- login is given `user-` before it. So a stranger who signed in by email as `alice@…` first made the
-- real alice `alice-1`, and refused; and a listed `bob-1` let GitHub's `bob` in.
--
--   * TEXT, not the username's 39: it is GitHub's value, compared as given, and a login cut to fit
--     would be another login.
--   * NULL for an account made by an email link, and cleared by erasure with `github_id` (I-11).
--   * Written on every GitHub sign-in, and taken from any other account holding the same login in
--     any case: GitHub says whose it is now, so an account renamed away from it keeps no claim.
--   * Not UNIQUE: two sign-ins at once may each hold it for a moment, which only refuses neither.
--     The index is on the lowered login, as it is compared.
--   * Filled for existing GitHub accounts only where the username is the login unaltered — no
--     `-N` and no `user-` before it. Any other is NULL until its person next signs in: refused for
--     a while rather than let in on a name that may be somebody else's.

ALTER TABLE users ADD COLUMN github_login TEXT COLLATE "C";

UPDATE users
   SET github_login = username
 WHERE github_id IS NOT NULL
   AND deleted_at IS NULL
   AND username !~ '-[0-9]+$'
   AND username NOT LIKE 'user-%';

CREATE INDEX idx_users_github_login ON users (lower(github_login)) WHERE github_login IS NOT NULL;
