-- purlay: no-transaction
-- 0064_github_delivery_bodies
--
-- A delivery is posted once by its body as well as by its id (D-231 §1). `X-GitHub-Delivery` is not
-- signed — the HMAC covers the body alone — so a signed body sent again under an id made up posted again.
--
--   * `body_digest`: the SHA-256 of the body as sent, hex, written in the transaction that posts it. Never
--     the body: a copy of the database holds no event that was not posted.
--   * `github_deliveries_feed_body_key`: one body once per feed. Per feed, since the signature is the
--     feed's: the same bytes to another feed are that feed's delivery.
--   * NULL on the rows already there, whose bodies were never kept. NULLs are distinct to a unique index,
--     so they never collide; the sweep forgets them within `GITHUB_DELIVERIES_KEPT_DAYS`, the same window
--     the ids are remembered for (D-134 §5).
--
-- Rollback: nothing reads the column but the insert that writes it. `DROP INDEX CONCURRENTLY
-- github_deliveries_feed_body_key` and `ALTER TABLE github_deliveries DROP COLUMN body_digest` in a new
-- migration undo it, after which a replayed body under a new id posts again.
--
-- On a table with rows, outside the migrator's transaction (D-86), in 0027's order: the column, the check
-- NOT VALID and then validated, the index built CONCURRENTLY — dropped first, since an interrupted build
-- leaves an invalid one behind. A nullable column without a default is a catalogue change. Each step can
-- run again.

SET lock_timeout = '10s';

ALTER TABLE github_deliveries ADD COLUMN IF NOT EXISTS body_digest TEXT;

ALTER TABLE github_deliveries DROP CONSTRAINT IF EXISTS github_deliveries_body_is_a_digest;
ALTER TABLE github_deliveries
    ADD CONSTRAINT github_deliveries_body_is_a_digest CHECK (body_digest ~ '^[0-9a-f]{64}$') NOT VALID;
ALTER TABLE github_deliveries VALIDATE CONSTRAINT github_deliveries_body_is_a_digest;

RESET lock_timeout;

DROP INDEX CONCURRENTLY IF EXISTS github_deliveries_feed_body_key;
CREATE UNIQUE INDEX CONCURRENTLY github_deliveries_feed_body_key
    ON github_deliveries (feed_id, body_digest);
