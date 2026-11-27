# D-335. A ledger of deliveries between modules, opt-in and without payloads (#1305)

**Context.** Delivery between modules is at-least-once and consumers are idempotent (D-288), and `sweep:outbox` takes a delivered row
a day after it ended so the table stays the size of what is in flight. Nothing remained to answer an audit's "was fact X delivered
to module Y?" once the row was gone.

**Decision.**
1. **A table, `outbox_ledger (fact_id, consumer, workspace_id, type, producer, delivered_at)`**, primary key `(fact_id, consumer)`,
   written with `ON CONFLICT DO NOTHING` in the transaction that marks the outbox row `delivered`: a delivery is never marked without
   its line and a line never stands without its delivery. `skipped` and `dead` are not delivered and write nothing.
2. **Opt-in**: `OUTBOX_LEDGER_DAYS` (1 to 3650). Unset: no ledger, nothing written, zero extra statements for a delivery. The retention
   is the setting's: `sweep:outbox` takes lines older than it, in batches. Turning the ledger off keeps what is there.
3. **No payload, ever.** A payload may name people; ids, the type, the producer and the time do not, so the table needs no erasure
   path, is in no export and is emptied by the workspace's purge by name.
4. **The operator's read**, `bun run outbox:ledger <slug> [--fact] [--consumer] [--limit]`, scoped to the workspace by its address,
   newest first, at most 200 lines, with a note when the ledger is off.

**Rejected.** *Keeping delivered outbox rows longer:* the table is hot and mostly churn (`fillfactor`, vacuum settings), and its rows
hold payloads. *Always on:* one more insert for every delivery on every server, for a need only some have. *A signed or hash-chained
ledger:* the trigger names proving a delivery, and an append-only table in the operator's own database is the proof the project offers
for the audit log; tamper evidence is a separate decision. *An HTTP route and a console page:* a new server route needs its entries in
the route-ownership, core-claim and cross-tenant tables and a screen.

**Cost of reversing.** `DROP TABLE outbox_ledger`, unset `OUTBOX_LEDGER_DAYS`, remove one command, one worker flag and one sweep call.
