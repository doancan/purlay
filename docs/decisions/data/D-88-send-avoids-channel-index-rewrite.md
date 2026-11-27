# D-88. A send does not rewrite the channel row's indexes, and a retried send is announced again

`sendMessage` updated `channels.last_message_at` on every send, and that column was the second key of
`idx_channels_workspace` (#244). Measured on 2,000 sends to one channel: **0 of 2,000 updates were HOT**, and the
channel's indexes grew from 57,344 to 155,648 bytes, in step with traffic instead of with channels. The write
came from the application's clock with nothing to stop it going backwards, so two concurrent senders, or two
nodes whose clocks differ, could move the channel's recency back. It also took the channel's row lock for
the rest of the transaction.

**Decided: the column leaves the index.** Migration `0008` rebuilds `idx_channels_workspace` on
`workspace_id` alone (concurrently, in the way the migrator allows, D-86). A workspace has tens or hundreds
of channels, so sorting what the index finds costs nothing next to the write it removes. The same 2,000
sends then made **1,999 HOT updates, and the indexes stayed at 57,344 bytes**.

**Decided: the update is monotonic and skipped when it would not advance.** `where last_message_at is null
or last_message_at < $sent_at`: a send whose clock is behind the channel's writes nothing and takes no lock,
and one that is ahead cannot be undone by a slower neighbour. It is the last statement of the send, so the
row lock it takes lasts as little of the transaction as possible. `updated_at` is deliberately not touched;
it records edits to the channel, not traffic through it.

**Decided: a retried send publishes `MESSAGE_CREATED` again.** `send()` announces the stored message every
time it is called with an id it already holds. The failure that makes this correct: the write commits, the
publish fails, the sender is told so and retries. If the retry stayed silent the room would never hear of a
message that is in the database, and nothing else would tell it while its sockets stay open. The cost is one
frame that changes nothing, because clients de-duplicate by id (D-65), and a retry is rare and backed off.
Both behaviours have a test.

**Rejected — publishing only when the row was inserted.** It makes the failure above permanent, and it
trades a duplicate frame that is harmless for a lost one that is not. It becomes right if a delivery
guarantee exists elsewhere (a transactional outbox), and the reopening condition is that. **Rejected — a
`GREATEST(...)` in the `SET`:** it is monotonic as well, but it still writes the row, takes the lock and
leaves the old tuple behind when nothing advanced. **Rejected — rounding `last_message_at` to the minute so
most sends skip the write:** the sidebar's order between two busy channels would then be wrong. **Rejected —
a separate `channel_activity` table:** moves the same write to another row, and costs a join on every
sidebar read for a problem the index change already removes. **Rejected — `fillfactor`:** HOT pruning
reclaimed the old versions on its own (1,999 of 2,000); a setting that was not needed is not added.

**Reversibility:** free. The old index is one `CREATE INDEX`.

**Amended 2026-10-09 (second-round audit): what a retry publishes is the stored row as it is now.** Once
messages can be deleted, a retried send of an id the database already holds would, if it published what the
retry carried, republish the original content of a message that has since been tombstoned (D-9). The
constraint on the retry's publish: **it reads the stored row and publishes that — tombstone included — and
never the content the retry sent.** Today's `send()` returns the stored row on a repeated id; the delete
endpoint's work is to keep it so, and its test must retry a send of a deleted message and see a tombstone.
