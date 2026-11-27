# D-194. A client that was away asks what changed since it last heard, by the server's clock — builds on D-65, D-82, D-33

*Amended by D-268: What the person's own topic would have said is read again when the socket opens, the first time too.*

**Context.** A reconnecting client is replayed the root messages above the newest id it holds (D-65). That cannot
tell it about an edit, a deletion, a reaction taken back, a reply, a resolved thread: none makes a new id, and a
message that arrives late sorts *below* the newest id a client holds (D-33, and D-65's "a cursor is not a watermark").
The web client re-reads what it shows on every acknowledgement and so never notices; a second client built from the
contract would show a deleted message for as long as it ran, and nothing in the contract said it must not.

**Decision.**
1. **`messages.changed_at`** (0058): the instant the server last wrote the row, on the database's clock, to the
   millisecond. Stamped by a **trigger** on every `UPDATE` and by the column's default on every insert, and left
   alone when a statement sets it itself (a backfill, a test). It is a trigger, not a column each writer sets, because
   the writers include the ones nobody remembers — a retention job, an erasure, a repair by hand — and a client that
   is not told of one of them is wrong without knowing it.
2. **`GET /api/channels/:channelId/changes`**: with nothing, the watermark (`asOf`) and no data; with `since` — the
   `asOf` the client holds — the first page of what changed after it; with `after`, the next. Each page is `data`
   (the messages as they now stand: roots and replies, a deleted one as its tombstone), `nextCursor` and `asOf`. The
   cursor carries the walk's watermark, so `asOf` is one value however many pages the walk took, and a walk ends at the
   clock it began at: a change made while a client reads belongs to the next walk, which begins from that `asOf`.
3. **A walk begins `CHANGES_OVERLAP_MS` behind `since`** (the replay's, D-65): a write stamps its row before it
   commits, so a row stamped before a reader's watermark can be committed after the read. Rows inside the overlap are
   told again; a client keeps messages by id and discards what it holds, as for a replay.
4. **Who may read it** is who may read the history: the same guard, the same refusal for a channel the caller cannot
   see. Nothing about a person's other channels is in it.

**Rejected.**
- *Replaying edits and deletions inside `SUBSCRIBE`*: a protocol change for the web as well, and a replay budget
  (D-65) that a long absence would spend on one channel.
- *A change-log table*: a write on every reaction, a retention rule of its own and a second statement of what
  `messages` already says.
- *`state_version` as the cursor*: a per-row count, not an order across rows.
- *The id as the cursor*: the failure above, again.
- *Pins, memberships, the channel list*: not messages. They are read again, as before (`ARCHITECTURE.md` §5.4).

**Accepted.**
- A walk from an old watermark pages through everything the channel did in the time, which is as large as the channel
  was busy; a client away for longer than it cares to page reads the history again instead.
- **A row that is deleted is not in the walk.** The retention purge removes message rows (D-139 §3), and a deleted
  row has no stamp to be read by: a client that held a purged message keeps showing it until it reloads, exactly as
  every open screen does after a purge (the job has no bus). What the purge *updates* — a root whose thread it
  recounted, a root it made a tombstone — is told. Carrying removals would be a log of ids and a rule for how long to
  keep it, for a workspace that has opted into a window and a message that is already outside the one it shows; it is
  not built, and what would reverse it is below.
- A walk begins `CHANGES_OVERLAP_MS` behind its watermark, so a write that stays uncommitted for longer than that
  can be missed. The pool bounds a statement at 30 s and an idle transaction at 15 s (`POOL_DEFAULTS`), so a write of
  the application is stamped and committed well inside it; a transaction held open longer by hand is followed by a
  reload.

**Reverses if** the replay learns to carry changes itself, in which case this endpoint is the catch-up for what the
replay's budget could not carry; or if a purge that a client must see is wanted, in which case the removals are logged
by the purge and carried on the first page of a walk.
