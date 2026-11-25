-- 0127_outbox_trace
--
-- The trace a fact was published in (#1307, D-336): the request's `traceparent` as W3C Trace Context writes it, so the delivery of the
-- fact, on another node and a minute later, is a span of the same trace as the request that told it. NULL for a fact written where
-- tracing is off, where the trace is not recorded, or outside a request (a worker's, a delivery's own: its chain is `caused_by`).
-- Ids and a flag, nothing of a person or a payload.
--
-- A nullable column with no default is added without rewriting the table, and the shape is checked on what is written.
--
-- Rollback: `ALTER TABLE outbox DROP COLUMN traceparent`. The delivery then starts a trace of its own.
ALTER TABLE outbox ADD COLUMN traceparent text;
-- NOT VALID and then VALIDATE: the check does not hold the table's lock while it reads rows, and none has a value yet.
ALTER TABLE outbox ADD CONSTRAINT outbox_traceparent_shape CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$') NOT VALID;
ALTER TABLE outbox VALIDATE CONSTRAINT outbox_traceparent_shape;
