-- 0134_outbox_expired
--
-- How many facts `sweep:outbox` gave up on because nobody came for them before their expiry, by consumer and fact type (D-353). The
-- sweep runs as a process of its own in the scheduler's container, so a counter in its memory is never scraped: it adds what it took
-- to this table in the statement that deletes the rows, so a fact is counted exactly when it goes, and every node reads the totals
-- for `purlay_outbox_expired_total{module,fact}`, which only grows. One row for each pair a sweep ever took, a closed set from the
-- manifests, so it does not grow with the facts. Ids of a module and a type and a count: nothing names a person or a workspace.
--
-- Rollback: `DROP TABLE outbox_expired`; the sweep then fails on its first expired fact until the release before it is running.
CREATE TABLE outbox_expired (
  consumer text NOT NULL CHECK (char_length(consumer) BETWEEN 1 AND 48),
  type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 96),
  expired bigint NOT NULL CHECK (expired >= 0),
  last_expired_at timestamptz NOT NULL,
  PRIMARY KEY (consumer, type)
);
