-- 0126_outbox_ledger
--
-- Which fact was delivered to which consumer, and when, kept after the outbox's own row is swept (`sweep:outbox` takes a delivered
-- row a day after it ended): so an operator can answer an audit's "was fact X delivered to module Y?" without keeping the transient
-- table large (#1305). Written only when the operator turned it on (`OUTBOX_LEDGER_DAYS`), in the transaction that marks the row
-- delivered, once for each `(fact, consumer)`: a fact requeued and delivered again is the same row. **No payload**: a payload may
-- name people, and this holds ids, the type and the time only, so it has no erasure path of its own. `skipped` and `dead` are not
-- delivered and are not written.
--
-- No key to `outbox`: the row it records is gone by design. The key to the workspace is the table's own: a purged workspace keeps its
-- row as a tombstone and the cascade never fires, so the purge empties the table by name (`CORE_REMAINING_TABLES`).
--
-- Rollback: `DROP TABLE outbox_ledger`; the delivery then writes nothing more. Nothing else reads it but `outbox:ledger` and the sweep.
CREATE TABLE outbox_ledger (
  fact_id uuid NOT NULL,
  consumer text NOT NULL CHECK (char_length(consumer) BETWEEN 1 AND 48),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 96),
  producer text NOT NULL CHECK (char_length(producer) BETWEEN 1 AND 48),
  delivered_at timestamptz NOT NULL,
  PRIMARY KEY (fact_id, consumer)
);
-- What `outbox:ledger` reads: a workspace's deliveries, newest first. Also the key's own check when a workspace's row goes.
CREATE INDEX idx_outbox_ledger_workspace ON outbox_ledger (workspace_id, delivered_at DESC);
-- What the sweep takes: the oldest first, whatever the workspace.
CREATE INDEX idx_outbox_ledger_delivered ON outbox_ledger (delivered_at);
