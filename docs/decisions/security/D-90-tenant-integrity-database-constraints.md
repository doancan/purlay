# D-90. Tenant integrity is a constraint where a constraint can say it

D-21 calls a tenant leak the one defect class that cannot be recovered from, and until now the rule that
prevents it was a convention (#242). In one transaction a message was inserted with `workspace_id` of
workspace A and `channel_id` of a channel in B; a reply with a channel and workspace unlike its parent's;
a DM with `dm_key = 'garbage'`; and a `messages.id` that was a v4. The database accepted all of them,
because the rules (`SCHEMA.md` I-1, I-3, I-4, I-5) were enforced by the services that were meant to write.
A writer that is not one of them (a job, an import, a script, a later endpoint written in a hurry) was not stopped.

**Decided: composite foreign keys, so the tenant check cannot be skipped.** `channels` gains
`UNIQUE (id, workspace_id)` and `messages` gains `UNIQUE (id, channel_id)`, which are what a composite key must
point at. Then: `messages (channel_id, workspace_id)` references `channels` (a message is in its channel's
workspace); `messages (parent_id, channel_id)` references `messages` (a reply is in its parent's channel,
hence workspace); `channel_members (last_read_message_id, channel_id)` references `messages` (a read position
is a message of that channel). Each replaces the single-column key it contains and keeps its action (cascade,
restrict, set null), so a pair of triggers per row is not paid twice. The read-position key is
`ON DELETE SET NULL (last_read_message_id)`: the plain form nulls both columns, and `channel_id` is not null.

**Decided: two CHECKs.** `messages_id_is_uuidv7` is the contract's `isMessageIdShape` in SQL (version 7, RFC
variant), and a test compares the two on seven ids so they cannot part. `dm_key_form` requires two lower-case
ids, the first not above the second byte-wise (`COLLATE "C"`). It is `<=`: a conversation with oneself is a
product question, and a constraint should not be the place it is answered.

**Decided: added the way it has to be added to a large table.** `0010` leaves the migrator's transaction
(D-86). The unique constraints are built `CONCURRENTLY` and attached; each key and check is added `NOT VALID`
and `VALIDATE`d in the next statement; a lock wait is bounded at 10 s. On the 1,000,000-message database,
with a reader and a writer running throughout, the migration took 9.7 s: the slowest `SELECT` was 6 ms, the
slowest `INSERT` 57 ms, and none of about 900 statements waited out a 2 s lock timeout. A test reads the
catalogue and fails on any constraint left unvalidated.

**Decided: a refusal test for each**, naming the constraint and the SQLSTATE the database answered with,
inside its own transaction (a refused statement aborts it). `ON DELETE RESTRICT` answers `23001`, not `23503`.
Two tests are not refusals but guard the other direction: deleting a message clears only the read position that
named it, and deleting a channel still takes its messages and memberships.

**What stays service-level**, and why, is `SCHEMA.md` §11: thread depth (a key cannot say "the row I point at has
a null column"); counters kept equal to other rows (a trigger on the hottest table); the timestamp inside an id
(a `CHECK` must be immutable); that a DM's two ids are members of its workspace; and I-6, which could be a
`CHECK` but belongs with the read-state service that defines it.

**Rejected — triggers for the tenant rules.** A trigger runs on every write to the hottest table to do what a
key does with an index, and it is the form of rule that gets disabled during a bulk load. **Rejected — dropping
`messages.workspace_id` and deriving it through the channel:** every workspace-scoped read would join, and D-3
makes the tenant filter structural so that it cannot be forgotten. **Rejected — a `CHECK` calling a function to
look the channel up:** a constraint cannot see another table's rows, and a function that pretends to is not
checked on the other table's update. **Rejected — `MATCH FULL`:** every column is `NOT NULL` or null together
with the one that matters, and the default already skips an unset `parent_id`.

**Reversibility:** each is one `DROP CONSTRAINT`. Once the keys exist, a writer that violates them fails, which is
the point and is also what a bulk loader must be told.
