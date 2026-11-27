# D-139. Retention, account erasure and content erasure, as built — #83

*Amended by D-356: §5's sign-in is the session's recorded authentication as well as its issuance, so a native handoff keeps its browser's age.*

*Amended by D-225: A channel may keep its history longer than its workspace, never shorter.*

**Context.** D-27 decided the three pieces; building them met edges it is silent on — a thread whose root
is older than the window and whose replies are not, what of a person is theirs beyond `users`, who may
erase, and a process that cannot reach the sockets. D-125 §4 makes them this feature's to decide. A
critique of the first plan found four of its answers wrong; what follows is what survived.

**Decision.**
1. **Retention purges messages, as D-27 says, one by one.** A reply older than the window is
   hard-deleted, and its thread's summary — the reply count and the last reply's time — is recomputed
   from what remains. A top-level message older than the window with no replies left is hard-deleted; one
   that still has younger replies becomes a tombstone (D-9's row change: its words, mentions, pin,
   versions and files go, the row stays to hold the thread) and is deleted the night its last reply goes. I-10's
   "never a message newer than the window" holds, and nothing older survives but an empty row. Age is
   `created_at`, never the id (`MESSAGE_ID_SKEW` lets an id run behind its time). *Rejected:* the thread
   as the unit — one reply a month would keep a whole thread's personal data forever, against D-27 §1's
   wording.
2. **What a purged message added is taken back before it goes**: the unread and mention counters of the
   members it was counted for — the same rule as a delete, set-based and shared with it — and its
   waiting notifications marked read, before the foreign key sets a read position on it to `NULL`.
   Attachments' bytes come off `storage_used_bytes` from the rows the delete returned (I-7 stays exact
   under two runs at once), and their blobs are queued in the same transaction and removed after commit
   — one the store refuses waits for `sweep:deletions` (D-141). `channels.last_message_at` is not
   touched: it only moves forward (SCHEMA §5.1), and if its message went every message went. The
   memberships of a batch's channels are locked first, as every other writer takes them, then the
   messages and a reply's root `SKIP LOCKED` — the purge never waits on a message row, so no reader or
   sender can close a cycle with it — and a reply arriving at that moment either lands first and keeps
   its root, or finds the root gone and is told `404`, on HTTP and on the socket alike.
3. **One audit row per workspace with retention set, per run**, `retention.purged`, actor none, counts as
   strings — written when nothing was purged too. A run with no workspace on retention writes none (the
   trail is a workspace's). No frame: a job has no bus, and an open screen keeps a purged message until it
   reloads.
4. **Retention is set by an owner**, `PUT /api/workspaces/:id/retention`, whole days from 30 to 36500 or
   `null` for forever, audit `retention.changed` with from and to. It is read by an owner only, on its own
   route: the `Workspace` shape is shown to people not yet in it (an invitation's preview).
5. **Account erasure is the person's own act, over HTTP** (`POST /api/me/erase`): the request must come
   from a session signed in within the last fifteen minutes and carry the account's username, typed — the
   one irreversible thing a stolen or forgotten session could otherwise do. In one transaction: the
   `users` columns of D-27 §2 and D-131 (email to `erased-<id>@erased.invalid`, username and display name
   to the reserved `deleted-user-…` made unique as D-38's collision is, `github_id` and the profile
   cleared), every session revoked with its address and agent cleared (D-81), push subscriptions,
   pending sign-in links for the old address (under the address's lock, D-138 §7), saved messages and
   notifications deleted. Messages, reactions, memberships, responders and audit rows stay, under the
   anonymised row; every surface shows the person as one localised "deleted user". After commit their
   sockets are ended. The locks are taken in the order every other writer takes them — the address's
   links, the sessions, the workspaces in id order, then the person — so a send, a sign-in or a role
   change at that moment takes turns with it; and a GitHub sign-in that read the account before it was
   erased writes nothing back onto the tombstone. *Rejected:* an operator's command — the process has no bus, so the person's open
   sockets would keep receiving every message until their session's natural end; erasing for somebody who
   cannot sign in is a separate issue.
6. **A workspace keeps a live owner.** An erased owner does not count as one — neither for the last-owner
   rule (I-2) nor anywhere else — and the last live owner of a workspace that has another live member
   cannot erase themselves: `409 LAST_OWNER`, naming the workspaces to hand over. Each workspace row is
   locked in id order first, so two owners erasing at once cannot each count the other. A workspace
   left with nobody live in it has its open invitation links revoked, or a newcomer holding one would
   join a workspace nobody could ever own again.
7. **Content erasure is an operator's command, per workspace** (`bun run erase:content <user>
   --workspace <slug>`; `--all` for a self-hoster who is the controller of every workspace, D-28): every
   message the person wrote there becomes a tombstone through the same set-based rule as a delete, and
   their attachments go with their blobs and bytes. Events, incidents' postmortems and runbooks (D-137 §3)
   are untouched. One `content.erased` audit row per workspace. No frame, as §3. A message another
   transaction holds when its batch runs is not waited for (`SKIP LOCKED`, as the retention purge) but
   counted: the row says `messagesLocked`, the command exits 1 and is run again — unlike the purge, whose
   next night finishes it, an erasure someone asked for may not read as done while words remain.

**Cost of reversing:** none for the data model — no column was added for any of it; what is purged or
erased is gone, which is the point.
