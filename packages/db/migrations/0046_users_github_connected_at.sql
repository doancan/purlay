-- 0046_users_github_connected_at
--
-- When GitHub was connected to an account made by an email link (D-172).
--
-- An account made by GitHub and one made by email are told apart by this column and nothing else once
-- the second has a `github_id` too, and two rules turn on the difference:
--
--   * Email sign-in is for an account made by email (D-138 §2). One that has since connected GitHub
--     keeps it — connecting adds a way in and takes none away — while an account GitHub made still
--     never signs in by link.
--   * A GitHub sign-in refreshes the username and display name of an account GitHub made (D-38). An
--     account made by email keeps the ones it has: they were never GitHub's, and connecting does not
--     hand them over.
--
-- NULL for every account made by GitHub, every account made by email that has not connected, and
-- after erasure, which clears it with `github_id` (I-11). No existing account has connected, so
-- there is nothing to fill.

ALTER TABLE users ADD COLUMN github_connected_at TIMESTAMPTZ;
