# D-212. "Mark unread from here" — the one way the read position moves backwards — amends D-99 §4

*Amended by D-282: Catch-up reads only the displayed range, with a join scope and independent thread receipts.*

**Decided (the owner, 2026-10-30).** The owner asked for the core features of Slack, Teams and Discord
the product lacked; marking a message unread is the first. The read position only ever moved forward
(D-99 §4), which is right for reading and leaves a person no way to say "come back to this".

- **`PUT /api/channels/:channelId/unread` `{ fromMessageId }`**, a member's only. The position moves
  back to the newest message before it, or to none; a reply marks its thread's root, since the position
  reads the feed (D-147). Both counters are recounted from the rows in the same locked turn as a read's
  (`markUnread` beside `markRead`), so they cannot disagree with them. Already unread from there or
  earlier, nothing moves and no version is spent. The caller's devices are told by `CHANNEL_STATE`.
- **Notifications are not touched.** What the inbox has read stays read there (D-106); the badge counts
  what still waits, as it always has.
- **The open channel is held.** Looking at a channel reads it (`use-mark-read.ts`), and the next message
  to arrive at the bottom would read it straight past the mark. A channel marked unread is held for the
  rest of the visit — nothing is sent at the bottom or on leaving — and reads as before when opened again.
  The hold is set before the request, so a read already waiting for its pause cannot slip in; refused,
  the hold is lifted and a toast says why.

**Considered and rejected.** Letting `PUT …/read` move backwards (a stale device behind the others would
then undo their reading: forward-only is what makes that request safe to repeat); re-opening the
notifications of the messages marked (the inbox and the feed are read apart, D-106).

**Cost of reversing.** One endpoint and `markUnread`; the menu item and the hold in `use-mark-read.ts`.
