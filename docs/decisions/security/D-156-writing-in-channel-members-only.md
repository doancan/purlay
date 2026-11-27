# D-156. Writing in a channel is a member's — #690

**Context.** The client gives a person who has not joined a public channel no composer — a bar that
says they are reading without being a member, and **Join** — but the API checked only that the channel
was visible to them (ARCHITECTURE §7.5), and every member of the workspace can see a public channel. A
script signed in as somebody outside `#design` posted to it, every message `201`; the channel's members
were notified by a person its member list does not show, and the writer had no read position, no
unread place for a reply, nothing in their sidebar. The spec said nothing either way. Decided in the
owner's standing instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **Writing requires membership** — Slack's `not_in_channel`. Sending a message or a thread reply to
   a channel the caller can see and is not in is `403 NOT_A_CHANNEL_MEMBER`, over HTTP and the socket's
   `MESSAGE_SEND` alike, since both are `sendMessage`; nothing is written and nobody is told. Seeing
   stays as it was: reading, searching and the thread panel are anybody's who can see the channel.
2. **One code for every write of a visible non-member**, from the one guard (`requireChannelMember`):
   adding a reaction, editing one's own message, resolving or reopening a thread — each changes what the
   members see, and a reaction or an edit can tell somebody — and what was already a member's (D-104,
   D-123, D-130, D-137): pins, the incident, the channel's name and topic, bringing people in. Those
   were `403 FORBIDDEN`; they keep the status and gain the code, so a client can say *join to do this*
   rather than *not allowed*. A direct message is unchanged: who is in it is fixed, and its refusals say
   so as before.
3. **Taking one's own back is not writing**: deleting one's own message (or an earlier version of it),
   taking back one's own reaction, and saving for oneself stay open to somebody who has left. A
   moderator's delete is an owner's or an admin's, as it was (D-103 §7).
4. **The client already behaves this way** (the bar and **Join**); what it gains is the reason. A send
   in flight that meets the refusal is `failed` with *you are not in this channel; join it to write
   here*, and Retry sends it again (UX §3.1); every other surface says the same through the shared
   failure table, which the compiler holds to every code.
5. **A read, not a lock.** The guard reads the membership row. A send locks the channel's memberships
   in one order after its own row is written (#668), and a purge or a delete takes them all first; a
   lock taken before either would be a second order beside theirs, and the deadlock #668 and #669
   removed. So a leave in the same instant as a write can let that one write land — from somebody who
   was in the channel when it was checked.

**Rejected.** *Writing joins* (#690's option 2) — a message would quietly change who is in the
channel, and the member list and its notifications would follow from a side effect. *Keeping it as it
was* (option 3) — a member list that does not include the people writing is the surprise an admin of a
regulated workspace (audit, export, erasure by member) does not expect. *A second code only for sends,
`FORBIDDEN` for the rest* — two answers to one condition. *Holding the membership row `FOR KEY SHARE`*
— see 5: it deadlocked against the retention purge in its own race test.

**Cost of reversing:** the guard's calls in `sendMessage`, `reviseMessage`, `setReaction` and
`setResolved`, and the code — back to `FORBIDDEN` for the rest; no migration.
