# D-99. The wedge's backend: what a write touches, and what "needs you" means

*Amended by D-212: "Mark unread from here" — the one way the read position moves backwards.*

*Amended by D-282: Catch-up reads only the displayed range, with a join scope and independent thread receipts.*

> **Amended 2026-10-19 by D-147.** §4: the read position reads the feed — the notifications of the roots
> at or behind it — and never a reply's, which is read in its thread or the inbox; a reply waiting
> behind the position counts as unread until then. §1's two numbers and I-6 are unchanged in meaning.

D-98 pulls threads, resolution, read state, mentions, reactions and DMs forward and orders the work
contract-first. The schema has the columns; four rules were not written down anywhere, and each is a
correctness question rather than a style one, so they are decided here before two people implement them
in parallel.

**1 · "Needs you" is one number.** `unread_mention_count` is what is waiting for *this person*: an
`@username` naming them, any message in a direct message, and a reply in a thread they started or have
already answered (D-29, which has its own words for why the third counts). `unread_count` is every
message by someone else past their read position, replies included. The first never exceeds the second
(I-6), and it becomes a `CHECK` now that the service that defines it exists (`SCHEMA.md` §11 said it
would). A resolution *notifies* the root author (a `thread_resolved` row) and moves no counter: it is not
a message, so counting it would put the two numbers in disagreement the first time they are recomputed.

**2 · The send is one transaction (D-35, completed).** In order: insert the message (a reply first
checks that its parent exists, is in the same channel, is a root and is not deleted — I-1); bump the
parent's `thread_reply_count` and `thread_last_reply_at`; set `channels.last_message_at`; parse
`@username` and write `mentions`; write `notifications` (one row per person per message, the strongest
class wins: mention, then direct message, then thread reply; never the sender; none for a membership at
`notification_level = 'none'`); and increment the counters in **one** `UPDATE … RETURNING` over the
channel's other members. Commit. *Then* publish `MESSAGE_CREATED` on the channel, `THREAD_UPDATED` for a
reply, and `CHANNEL_STATE` on each recipient's `user:` topic from the rows the `UPDATE` returned. The
server's numbers travel; no client increments its own (D-13), so two devices cannot drift.

**3 · Mentions are parsed, and `@here` is refused.** `@name` is a mention when it is not inside inline
or fenced code, is not preceded by a word character, `@` or a backtick, and names a person who can see
the channel (every workspace member for a public channel, the members for a private one or a DM);
matching is case-insensitive on `username`. An unknown name stays text. `@here`, `@channel` and
`@everyone` fail the send with `VALIDATION_FAILED` on `content` — the parser's rejection D-12 promised —
and the composer says so before the request, the server being the authority. Mentioning yourself is
text, not a notification.

**4 · The read position moves forward only, and the counters are recomputed, not patched.** `PUT
…/read` is refused for a message not in the channel (I-3, as `MESSAGE_NOT_FOUND`), is a no-op for a
position at or behind the current one, and otherwise sets `last_read_message_id`, sets `unread_count` to
the count of messages by others past it and `unread_mention_count` to the lesser of that and the unread
notifications of the mention classes past it, marks the notifications at or behind it read, and
publishes `CHANNEL_STATE` to the person's other devices. A decrement could underflow under a race; a
recompute from rows cannot. The recount is bounded by what is unread and uses an index that leads with
`(channel_id, id)` — the migration adds it if the measurement says the existing one is not enough.

**5 · Resolution.** Any member who can see the channel may resolve or reopen (`ARCHITECTURE.md` §7.4),
on a root with at least one reply; anything else is `THREAD_NOT_RESOLVABLE` (I-8, and "only roots
resolve"). Resolving a resolved thread, or reopening an open one, answers the message and publishes
nothing: it changed nothing. `GET …/unresolved` lists roots with replies and no resolution from the
channels the caller can see (D-34), newest first.

**6 · Reactions.** `PUT` and `DELETE` are idempotent, answer the message's whole set, and publish
`REACTIONS_UPDATED` only when the set changed. The emoji is one Unicode emoji (the contract's `emoji`
format); a message holds at most twenty distinct ones, which bounds a frame an attacker could otherwise
inflate. One person puts at most three on a message (D-249).

**7 · Direct messages.** `POST …/dms` takes a person who is a member of the workspace (`USER_NOT_FOUND`
otherwise), gets or creates the channel for the sorted pair (I-5), makes both members, and publishes
`CHANNEL_ADDED` to the other person only when it created one. A note to self is a DM with one member.

**8 · One reader of messages.** History, thread, open questions, replay and the send's answer all build a
`Message` through one function that fetches reactions and mentions for the whole page in two queries —
never one per row (the rule D-13 states for counters applies to every page). Replay still carries roots
only; a client reconnecting refetches the threads it has open, because a reply missed during the gap is
not a root and has no cursor in the feed.

**9 · Doors.** Replies are sent over the socket (`MESSAGE_SEND` gains `parentId`) or HTTP; resolution,
reactions and read state are HTTP only and are heard on the socket. They are infrequent, they have no
optimistic row that must paint inside a frame, and a second implementation of each over the socket is a
second place for them to differ.

**Amended 2026-10-10 (review of the first implementation).** None of this reverses a rule above; each
closes a case the first implementation answered wrongly or left to chance.

- *Rule 1 and 4 — a message behind the reader is not unread.* A client may send an id up to a minute in
  the past (D-33), so a message can sort *below* a position someone has already read past. It is
  counted for a member only when their position is before it; otherwise it is stored, its notification
  is already read, and the recount (`id > position`) agrees with what was stored. Before, the stored
  number sat above the recount and the badge could not be cleared by reading. The recount also skips
  deleted messages and the notifications of deleted messages.
- *Rule 2 — who is told of a reply.* The root's author and the most recent **50** earlier repliers
  (`THREAD_PARTICIPANTS_MAX`), and only those who can still see the channel now — a member of the
  workspace, not deleted, and for a private channel or DM still in it (D-34). A resolution notifies
  the root's author on the same condition. The bound is on what one reply can write; older
  participants still have the thread.
- *Rule 2 — publishing after the commit.* Published in stages (the room, then the thread, then each
  person's numbers), the publishes of a stage concurrently in chunks of 32; a publish that fails is
  logged and does not fail a write that committed, nor stop the ones behind it. A repeated send
  re-tells from the rows; a repeated `PUT /read` re-tells the caller's devices (rule 4 is otherwise
  unchanged: the position never moves back). D-88's "a retry announces again" is kept and extended.
- *Rule 2 — whole-state frames are ordered.* `THREAD_UPDATED`, `REACTIONS_UPDATED` and
  `CHANNEL_STATE` carry `version` from `state_version` on the row they are made from (migration
  `0015`); the client drops an older one (`API.md` §5). Reactions therefore now update the message row
  once, as the last write of their transaction, and contend with a reply to the same message for that
  instant; the advisory lock still serialises reactions with each other.
- *Rule 5 — the open-questions index.* `idx_messages_unresolved` holds only roots with a reply (migration
  `0014`): 6,975 buffers and 37 ms became 41 buffers and 0.07 ms where the caller sees every channel and
  the questions are rare, and no worse where they are common.
- *Rule 7 — a direct message with an erased account* keeps its channel and `peer.id` and shows a
  placeholder. *Idempotence is `200`, creation `201`* (`API.md` §4); it is not a conflict.
- *Ids have one spelling.* The wire form of every UUID is lower-case; an upper-case id is a validation
  error rather than a second spelling of the same id that string comparison, ordering and the read
  position would each treat differently.

**Rejected — counting unread on read.** D-35 rejected it; the recount in rule 4 is a different thing (it
runs when a person reads, bounded by what they had not).

**Rejected — a `thread_resolved` increment.** Rule 1.

**Rejected — letting the client keep its own counters and reconcile.** Two sources of one number.
