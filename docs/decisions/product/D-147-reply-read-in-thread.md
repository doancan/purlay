# D-147. A reply is read in its thread, not by scrolling the feed past it — amends D-99 §4

*Amended by D-282: Catch-up reads only the displayed range, with a join scope and independent thread receipts.*

**Context.** An audit reproduced it twice. Bob asked in #incidents; Carol answered **in the thread**;
Alice then wrote something unrelated in the channel. Bob opened the channel and scrolled to the bottom
without opening the thread — and Carol's `thread_reply` went from unread to read, its badge, the tab
title's count and the inbox's unread state with it. Bob never saw the answer. D-99 §4 marked read every
notification at or behind the read position, and a reply's id sorts in the channel's order with the
roots, so any reply older than the newest feed message counted as read. Written when a thread opened
inline under its root, it never considered replies; since D-122 a thread is a panel the feed does not
show, and the rule re-created exactly the failure D-29 exists to prevent — an answer to your question
that you are never told about.

**Decided.**

1. **The read position reads the feed.** `PUT …/read` marks read the caller's notifications for the
   **roots** at or behind it — a mention, a direct message, a followed channel's message, a resolution.
   A notification for a **reply** — `thread_reply`, a mention inside a thread, a reply in a direct
   message — is read by reading its thread, or in the inbox (D-106), and by nothing else.
2. **Reading a thread is a request.** `PUT /api/messages/:messageId/thread/read` with
   `{ lastReadMessageId }` (`ReadThreadRequest`) reads the caller's notifications for that root's
   replies up to and including the reply named, recounts the channels touched by the inbox's own path,
   and tells the caller's devices `CHANNEL_STATE`. Anybody who can see the root may; a reply has no
   thread, `404` as `GET …/thread` answers. Nothing is stored but the notifications: a thread has no
   read position of its own (see *Rejected*). The client sends it while the thread is in the panel, the
   page is in front of the person and the channel has something waiting, for the newest reply it has
   from the server — so a reply that arrives after it looked is still waiting.
3. **What is unread follows.** `unread_count` is every message by somebody else past the read position
   **and every reply at or behind it whose notification still waits** — the feed was read past it, the
   thread was not. That keeps `unread_mention_count` within it (I-6, unchanged) without capping the badge
   to zero the moment the feed is read: the badge, the tab title (`UX.md` §2) and the inbox dot (D-110)
   keep saying it needs you. Every writer agrees, so the stored numbers stay what a recount finds: the
   read position recounts both terms; reading the inbox or a thread takes back one unread for each reply
   behind the position it read; a reply that arrives behind the position (an id up to a minute old,
   D-33) is not pre-read and is counted for the people it needs; an edit that adds a mention to such a
   reply counts it too; deleting it takes back from both numbers.

**Rejected.**

- *A read position per thread* — a `thread_members`-style row per person per thread. It would answer
  "where did I stop in this thread", which nobody has asked of a panel that shows the whole thread, at
  the cost of a table, a migration and a second recount. The notification rows already say what is
  waiting; reading a thread only has to read them.
- *Leaving the notification unread and the counters as they were.* The inbox would have kept the
  answer, but the badge is the lesser of the unread messages and the waiting notifications (I-6): with
  the feed read to the bottom the unread count is zero and the badge would still have vanished — the
  half of the defect that interrupts nobody, which is the half that matters.
- *Dropping I-6.* It is a `CHECK` the badge's meaning rests on; the fix is to count what is unread
  correctly, not to let the two numbers disagree.
- *Opening the thread reads everything in it, without a bound.* A reply arriving between the panel
  drawing and the request reaching the server would be read for somebody who never saw it.

**Cost of reversing:** the root-only condition in `read-state.ts`, the second term of its recount, the
reply cases in `delivery.ts`, `edit.ts` and `tombstone.ts`, the endpoint, `ReadThreadRequest`, the
thread panel's `use-read-thread.ts`, and their tests. No schema or stored value depends on it.
