# D-128. Saved items: a person's own list of messages to come back to, with no reminder — #484

**Context.** The Superdesign screens add a Saved view with In progress, Archived and Completed, and an
optional reminder time. D-125 put saved items in Phase 2. `PRD.md` §6 lists reminders among the
permanent non-goals (D-4).

**Decision.**
1. **A save is a person's, of a message they can read**: one `saved_messages` row per person and
   message, in a state — `in_progress`, `archived` or `completed`. Saved and let go by the message's
   id, found through the caller's visible channels in one query; a deleted message cannot be saved,
   and a deleted message's save can still be let go.
2. **Shown through visibility now**: the lists show saves in channels the person can see, of messages
   not deleted, as the inbox does (D-106). A save in a channel they left is kept and hidden, and comes
   back if they do.
3. **At most `SAVED_MAX` (1000) shown in a workspace**, counted under the person's membership row
   locked, so two saves at the bound cannot both be the last; saving again is never refused. Past it,
   `409 SAVED_LIMIT`. The ids list is bounded by it and not paged.
4. **Saving again keeps what was there**: its id, its time, and its state unless a state is given.
5. **The person's own devices are told** `SAVED_UPDATED` on their `user:` topic, with nothing in it but
   the workspace; nobody else learns anything.
6. **Amended 2026-10-28 at the owner’s request:** reminders are now a separate personal feature.
   A pending reminder has its own time and cancellation, survives clients closing, and produces a
   `reminder` inbox entry. It does not change a save’s state or invent a new unread message.
   The former rule follows for historical context: **No reminder.** Reminders are a permanent non-goal (`PRD.md` §6); lifting that is the owner's, by
   a decision of its own.

**Rejected.** *A message to one's own note-to-self conversation* (D-5's answer to a scratchpad) — it
copies the words out of their thread and their channel, and has no state. *Keyset on (saved_at,
message_id)* — a cursor naming a save since let go would find nothing; the save's own UUIDv7 does not
need to exist to compare. *Refetching on focus* — the client keeps that off on purpose; a frame says
when.

**Cost of reversing:** migration 0026's table and type, four routes, the frame, and the client's Save.
