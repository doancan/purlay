-- 0089_outbox
--
-- The outbox of facts one module tells another (D-288, D-283 §2): a row is one delivery of one fact to one consumer, written in
-- the publisher's transaction, so a fact exists exactly when the thing it reports does.
--
--   * `fact_id` is the same on every consumer's row of one fact: the consumer's idempotency key for an effect outside the database.
--   * `workspace_id` is on every row: the consumer is handed it and checks a payload's own ids against it.
--   * `consumer` is a module the build carries, which may not be run: `absent` of the fact's declaration says whether such a row
--     is written at all, and `expires_at` is when an undelivered one is given up on.
--   * `attempts` is counted when a row is claimed and not when it fails, so a fact that hangs or kills its node still reaches the
--     ceiling. `next_attempt_at` is pushed out at the claim by the backoff, which is also the lease: a node that dies
--     between claim and delivery leaves a row that shows again.
--   * `last_error` is a class of error, never the payload, which carries ids and a short label but is not for a log.
--
-- A new table with nothing in it: its indexes are made with it. The size of a payload is held at 8192 bytes by the publisher,
-- measured as compact JSON; `jsonb` writes its text with a space after each separator, so the check here has room for that and is
-- the backstop, not the limit.
--
-- Rollback: nothing reads the table before a module publishes. `DROP TABLE outbox` in a new migration undoes it, and facts
-- undelivered at that moment are lost.

CREATE TABLE outbox (
    id              UUID PRIMARY KEY,
    fact_id         UUID NOT NULL,
    workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    producer        TEXT NOT NULL,
    consumer        TEXT NOT NULL,
    payload         JSONB NOT NULL,
    state           TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL,
    finished_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,

    CONSTRAINT outbox_id_is_uuidv7
        CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT outbox_fact_is_uuidv7
        CHECK (fact_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT outbox_type_is_named
        CHECK (char_length(type) <= 80 AND type ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'),
    CONSTRAINT outbox_producer_is_a_module
        CHECK (producer ~ '^[a-z][a-z0-9-]{0,31}$'),
    CONSTRAINT outbox_consumer_is_a_module
        CHECK (consumer ~ '^[a-z][a-z0-9-]{0,31}$'),
    CONSTRAINT outbox_payload_is_small
        CHECK (octet_length(payload::text) <= 16384),
    CONSTRAINT outbox_state
        CHECK (state IN ('pending', 'delivered', 'dead', 'skipped')),
    CONSTRAINT outbox_attempts_count
        CHECK (attempts >= 0),
    CONSTRAINT outbox_error_is_short
        CHECK (char_length(last_error) <= 300),
    -- A row that is no longer pending says when it stopped, and one that is pending does not.
    CONSTRAINT outbox_finished
        CHECK ((state = 'pending') = (finished_at IS NULL)),
    CONSTRAINT outbox_one_delivery_a_consumer
        UNIQUE (fact_id, consumer)
);

-- Rows are updated twice in their short life (claimed, then finished): room on the page for the update to stay on it, and a vacuum that
-- keeps up with a table that is mostly churn.
ALTER TABLE outbox SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02);

-- What a drain takes: a consumer's rows that are due.
CREATE INDEX idx_outbox_due ON outbox (consumer, next_attempt_at) WHERE state = 'pending';
-- What the sweep takes: the rows that stopped, oldest first.
CREATE INDEX idx_outbox_finished ON outbox (finished_at) WHERE state <> 'pending';
-- What the sweep gives up on: a row that waited past its time.
CREATE INDEX idx_outbox_expires ON outbox (expires_at) WHERE state = 'pending';
-- What an operator is told of: the dead rows of each consumer.
CREATE INDEX idx_outbox_dead ON outbox (consumer) WHERE state = 'dead';
-- The key's own check when a workspace's row goes.
CREATE INDEX idx_outbox_workspace ON outbox (workspace_id);
