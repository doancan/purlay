-- 0048_drop_email_sign_ins
--
-- The table of sign-in messages (migration 0038, D-138) goes: a sign-in link is Better Auth's magic
-- link now, kept in `verifications` (migration 0047, D-179), and nothing has written this table since.
-- Left in place it would be a second home for the same fact, and a sweep, an erasure and an export
-- exclusion kept running against rows nobody makes.
--
-- What it held moves nowhere. A row was a link of fifteen minutes or a word that an address signs in
-- with GitHub, and the per-address count; the count is Purlay's own counter in `rate_limits` now, and
-- a link left in this table opens nothing since the routes that read it are gone. No data is carried
-- over (D-179 §8): there is no real server data yet.

DROP TABLE email_sign_ins;
