# D-89. Every foreign key has an index, and a test reads the catalogue to keep it so

`SCHEMA.md` §1 said every workspace-scoped table has an indexed `workspace_id`, and `messages` did not (#241). On
1,000,000 messages (10 workspaces, 200 channels, 200 users) the cost of that was measured: **deleting 100
messages took 4,756 ms**, and deleting one channel of 5,000 messages did not finish in 60 s, because enforcing
a foreign key is a query on the referencing table, one per deleted parent row, and `messages.parent_id`,
`messages.channel_id`, `messages.workspace_id`, `messages.resolved_by` and
`channel_members.last_read_message_id` had no index that query could use. The `idx_messages_*` indexes are
partial, and the enforcement query filters on the column alone, so none of them applies. The retention purge
(D-27), channel deletion and workspace deletion were unusable at scale.

**Decided: migration `0009` indexes every foreign key column**, `CONCURRENTLY` and outside the migrator's
transaction (D-86), re-runnable after a crash. A nullable column is indexed only where it is set. The five
`idx_messages_*` partial indexes stay, since they answer the feed, the thread, the search and the open
questions. The same 1,000,000-row database after: **8.7 ms** for the 100-message delete and **90 ms** for the
channel, both through index scans (plans in the pull request); the four new `messages` indexes add 14 MB to
376 MB and make 20,000 single-row inserts 5 % slower (1,107 to 1,168 ms).

**Decided: `idx_workspaces_slug` is dropped.** It indexed the column the `UNIQUE` constraint already indexes,
partially, so no query could prefer it and every write paid for it.

**Decided: a test reads the catalogue.** Every foreign key's first column must lead a valid btree that is whole,
or partial only on `col IS NOT NULL`; and no non-unique index may be a leading prefix of another whole one.
Both ran red against the previous schema, listing exactly the seven columns and the one redundant index. The
check reads what exists in the database, so it is a rule about tables not yet written.

**Decided: the search index stays, and its cost is written down** (`SCHEMA.md` §6.2). `idx_messages_search`
is 206 MB of the 376 MB of indexes on `messages`; removing it made inserts 1.8 times as fast on high-entropy
text and 1.45 to 1.6 times on prose, 15 to 25 µs a message. Search is a Phase 1 feature (D-10) and the index is
what makes it work in one database, so the cost is accepted. It is reopened when insert latency shows up in a
measurement of the send path, or when search moves out of the database.

**Rejected — one composite index `(workspace_id, channel_id)` in place of two.** It serves the workspace key and
a composite key, but not a lookup by `channel_id` alone, which is what the existing channel foreign key asks;
the two single-column indexes are 7 MB each. **Rejected — turning `idx_messages_thread` into the `parent_id`
index** by dropping its `deleted_at` predicate: a tombstoned reply keeps its place in the thread (D-9), so the
predicate may be wrong already, and that is a decision for the thread feature, not for this change.
**Rejected — a full-column index on each nullable key:** most rows are null, and the index would be mostly
nothing.

**Reversibility:** free; each index is one statement either way.
