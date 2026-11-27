# D-141. An object whose row is gone is queued until the store lets it go — #592

**Context.** Retention, erasure, the orphan sweep and a discarded upload delete attachment rows first
and their objects after the commit (D-109 §5, D-139 §2). An object the store refused was logged and
counted, and then forgotten; a process stopped between the commit and the delete lost the key without a
line. For retention and erasure that is personal data kept past the point the operator chose (D-27).

**Decision.**
1. **A table of keys waiting to be deleted** (`object_deletions`, SCHEMA §9.4), written in the
   transaction that deletes the rows naming them. Retention and erasure write it in `dropFiles`, the one
   place both delete files; the orphan sweep and a discarded upload write it beside their own delete. A
   delete that fails takes its queue rows with it.
2. **Drained after the commit**: each key the store accepts leaves the queue in one statement, each it
   refuses is logged by key and stays with its attempt counted. The callers' counts of what was left —
   retention's `filesLeft`, its failed run — are as they were.
3. **`sweep:deletions`, hourly at :50**, tries every waiting key again in key order from where it got to,
   so keys the store keeps refusing never hold back the ones after them, and fails its run while any is
   left, which `jobs:status` reports. A key whose object the store had already deleted, when the database
   then failed before the queue row went, is deleted again — harmless: a store's delete is idempotent.
4. **Not queued:** an export's archive, which its own row names until it is gone (`sweep:exports`,
   D-140); and the objects of an upload whose row never committed — nothing names them, and a stop
   between the store's write and the row's insert leaves them. Closing that window means writing the
   key before the object, on every upload; it is not done here. *Amended (#607):* it is done. An
   upload writes its keys to the queue before its objects, due an hour later so an upload still on its
   way is never deleted under it, and the transaction that inserts its row takes them out again; an
   upload refused or raced lets them go at once. The cost is two small writes per upload, beside a
   file of up to 25 MiB. Nor would a hard delete of a workspace or
   a message reach the queue through the cascade from `attachments` — no such delete exists, and one
   added must queue its files as `dropFiles` does.

**Rejected.** *Retrying inline* — a store down for an hour would hold a purge's batch, and a stop still
loses the key. *A store lifecycle rule* — the object store is the operator's and of their choosing
(D-109); the application cannot rely on one being set, and it would not say which keys are owed.
*Oldest first by `enqueued_at`* — a batch the store keeps refusing is read again on every pass; key
order with a cursor goes past it.

**Cost of reversing:** drop the table and call the store directly again; nothing else reads it.
