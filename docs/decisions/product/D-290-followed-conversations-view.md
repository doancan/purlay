# D-290. Followed conversations are a personal, read-only view of the existing follow relation — builds on D-34, D-103, D-161, D-282

**Context.** A person in purchasing, a warehouse, administration or a software team needs to return to a conversation
without searching notification history. D-161 already decides which threads they follow; a personal list must use
that same relation and the existing channel authority and receipt rules.

**Decided.**

1. **One relation.** A stored `thread_follows` choice, true or false, wins. Without a choice, the root's author and a
   person with a live reply follow it. Authored or explicitly followed roots with no replies are included. An explicit
   unfollow stays off after another reply. The list creates no preference rows. A deleted root keeps its tombstone;
   a personally hidden root is omitted before pagination.
2. **Chat owns the door.** `GET /api/workspaces/:workspaceId/followed-threads` is in chat's HTTP plugin and manifest.
   The session and current workspace membership are required before the query is validated. The root query uses
   the channel guard's visibility subquery in the same statement, including current workspace membership and live
   workspace/channel checks. Private channels and DMs require membership; visible public nonmember follows remain
   available. A stale context is no substitute for the membership joins.
3. **Bounded composite pages.** `FollowedThreadsQuery` takes `limit` (1–100, default 20), `unreadOnly`, and both
   `beforeActivityAt` and `beforeRootId` or neither. Activity is the last reply time, or creation time for an unanswered
   root, descending, with root UUID descending as the tie-break. `nextCursor` contains `{ activityAt, rootId }` or null.
   SQL preserves all six PostgreSQL fractional digits. The dedicated `cursor-time` format accepts canonical UTC
   timestamps with three or six fractional digits and valid calendar dates; the existing `date-time` format is unchanged.
   Repeated parameters, incomplete cursors, extra fields and invalid values are refused at the HTTP boundary.
4. **Unread is a receipt, never a guess.** Each row contains `root: Message`, `activityAt`, and `unread`: either
   `{ count: 0, firstUnreadMessageId: null }`, a positive count and first unread reply UUID, or null for a public
   nonmember with no receipt. D-282's existing read scope, independent thread receipts, late notifications and own,
   hidden and deleted reply exclusions decide it. Unknown receipts and already-read threads are excluded before
   paginating an unread-only query. A grouped read hydrates the selected page and the standard message builder
   hydrates its content in batches. Listing acknowledges neither messages nor notifications.
5. **A conversation list in chat.** `/w/:slug/followed` is reached beside All unreads in the channel sidebar and from
   the command palette. The screen loads on demand inside chat's existing module boundary. All/Unread is kept in
   the address. A row shows its source, author, root preview, reply count, activity and unread state; a waiting row
   opens its first unread reply, otherwise its existing thread. Unfollow uses the same serialized choice operation
   as the thread header. Its row disappears immediately. A refused action restores only its own unchanged cached
   view; newer reads or content/authority changes are authoritative. Errors offer recovery and preserve cached rows.
   The next row receives keyboard focus when one is removed, or the heading when the list becomes empty.
6. **Freshness and privacy.** This query family is refreshed at the first socket open, a subscription answer and
   reconnect, as well as a foreground transition for choices made elsewhere. It does not poll while hidden.
   Channel state, new messages, thread updates and revisions refresh it; root edits are patched immediately and
   hidden/revoked rows are removed synchronously. A pending old page or a failed optimistic action cannot bring them
   back. A second visibility notification while already in front starts no extra read.

**Rejected.** A list of only explicit true preference rows would omit authors and participants. Notification history
would omit conversations for which no notice was written. Treating a public nonmember's unread state as zero would
claim a receipt that does not exist. Millisecond-only cursors would skip roots whose activity differs in PostgreSQL's
remaining fractional digits. Per-row receipt or message queries would make the cost grow with page size.

**Cost of reversing.** Remove the read endpoint, view and cache family. There is no new table, migration, dependency,
notification rule or acknowledgement behavior; existing follow choices and independent receipts remain the source.
