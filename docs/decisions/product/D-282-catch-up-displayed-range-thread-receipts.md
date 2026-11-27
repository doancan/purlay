# D-282. Catch-up reads only the displayed range, with a join scope and independent thread receipts — amends D-99 §4, D-147, D-212 and D-216

**Date:** 2026-11-07. **Why:** #1193 reproduced four failures through real HTTP/browser requests: a never-read
channel with 25 roots showed only its newest 20; historical messages before a join appeared as new; reading an
unfollowed thread did not clear its reply; reading threads out of order could not preserve another thread and an unseen
root. A valid backdated client UUID (D-33) also made a read recount resurrect history written before the join.

- **The feed position remains a UUIDv7 keyset position.** `channel_read_scopes.unread_since` records the injected server clock
  of a new membership, at the same instant as `joined_at`. Ordinary unread messages must be written at or after it.
  `unread_history_from` additionally reopens the UUID range requested by **Mark unread from here**. The two conditions
  are a union: reopening old history never advances a feed position past an unseen new message whose client UUID sorts
  earlier. A rewind keeps an already earlier feed position and truncates thread receipts only beyond its requested range.
- **Old unknown scopes are preserved conservatively.** Existing memberships have no `channel_read_scopes` row: the old model
  cannot distinguish a never-read join from an explicit historical rewind. A first explicit read recount makes that
  scope unbounded from the UUIDv7 epoch, preserving the historical range rather than inventing a read receipt. A legacy
  catch-up can therefore include additional old context. No migration scans or rewrites every person's counters. Ordinary
  inbox reads and incremental counter writers retain a legacy membership's existing behavior until that scope is made
  explicit. New memberships always record their actual join floor.
- **A thread has its own private receipt.** `thread_reads` holds one monotonic UUID boundary per member and root, not one
  row per message or recipient. The bound supplied to `PUT /api/messages/:messageId/thread/read` must be a reply of that
  root in that channel (`MESSAGE_NOT_FOUND` otherwise). Reading it clears notifications only through that bound and
  recounts without advancing the feed or any other thread. A repeated or older bound cannot move the receipt backwards.
  A fresh notification for a previously read reply can make it need the person again. As with the feed, UUID order, not
  a new commit-order scheme, defines the receipt (D-33).
- **Feed reads do not acknowledge undisplayed replies.** An activated scope's `thread_read_baseline_id` plus the
  per-root receipt bound its read replies, independently of the current feed position. A legacy membership captures its
  old feed position into that baseline atomically on activation, preserving the thread history the old model had already
  read. This is lazy and requires no backfill. New memberships start with no thread baseline. The explicit **Mark every
  channel read** action (D-238) advances that baseline for unnotified replies; replies whose notifications wait still wait.
  An explicit inbox acknowledgement of a reply already behind the feed also clears that reply, preserving D-147 without
  advancing any other thread. Marking a range unread truncates both the baseline and individual receipts beyond it.
- **One unread predicate.** Read recounts, catch-up selection, arrivals, late mentions, private hiding and global deletion
  agree about the join scope, the historical range, the feed position and the thread receipt. A waiting reply notification
  remains unread behind either position. Hiding or deleting a reply already read in its thread cannot subtract a different
  unread root. Stored mention counts remain bounded by unread messages (I-6).
- **Catch-up is explicit and bounded.** Its channel read returns the oldest unread roots and waiting thread roots, each in
  a bounded page. Opening the screen reads nothing. **Mark read** advances only through roots actually displayed; waiting
  replies open their own thread. Existing attachment, link, event and tombstone renderers preserve file-only messages and
  source navigation. Initial and refresh failures never claim that everything is read or allow a hidden cached page to be
  marked read.
- **Private lifecycle.** `channel_read_scopes` and `thread_reads` are chat-owned tables keyed to the membership.
  The set adds no column to a legacy core table (D-275); where it was never applied, exports skip these absent
  private tables independently, without discarding the workspace context of an older module’s retained messages. Applied development migrations are kept append-only: chat/0010 moves the three prototype
  columns into the scope table, preserving known scopes, and drops those columns from `channel_members`. Receipts leave with the channel membership and with their root, and chat's account-erasure hook
  deletes them. Workspace exports omit both private tables; the person's own export includes them. The cursor
  has no foreign key to its last reply, which retention may remove while its root survives. The root/channel and membership
  keys enforce tenant/channel consistency; no other member can read this private state through the API.

**Rejected:** treating `last_read_message_id = NULL` as always the start of history or always the join (one loses an
explicit historical rewind); moving the channel prefix to clear one thread (it reads unseen conversations); subtracting
one blindly after hiding a read reply (it steals another unread); per-message receipt fan-out and a global delivery
sequence (neither is needed for the existing UUID keyset contract).

**Cost of reversing.** A forward chat migration and a recount. `channel_read_scopes` and `thread_reads` (chat/0007 to chat/0010) hold the join floor and the per-thread receipts; dropping them returns catch-up to the single feed position, and with it the failures this decision fixed (history written before a join shown as new, a thread read that clears nothing it should). Applied migrations stay (chat/0010 dropped the three prototype columns of `channel_members`, so going back is a new migration, not an edit).
