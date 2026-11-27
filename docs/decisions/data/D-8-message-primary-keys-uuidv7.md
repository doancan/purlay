# D-8. Message primary keys are UUIDv7 (time-ordered)

`gen_random_uuid()` (v4) is replaced by v7 for `messages`. Pagination is keyset on `id` alone.

**Why this is the highest-leverage decision in the document:** ordering underpins scroll
position, the unread marker, `last_read_message_id`, and optimistic reconciliation. With
random v4 PKs and a `created_at DESC` cursor, two messages in the same millisecond have
*undefined* order — the cursor drifts and users skip or re-see messages. UUIDv7 sorts by time,
is a stable cursor on its own, and can still be generated client-side — which means the
optimistic placeholder ID and the permanent ID share a format and the reconciliation loop
gets simpler, not harder.

**Rejected:** per-channel `BIGINT` sequence (cleanest ordering, but serializes inserts per
channel); composite `(created_at, id)` cursor (works, but inflates every index).

**Reversibility:** free today. After the first production message, a painful migration.
