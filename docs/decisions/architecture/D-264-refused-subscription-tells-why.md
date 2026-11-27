# D-264. A refused subscription tells the person who was in the channel why it is gone, and nobody else — builds on D-34, D-85, D-123, D-172

**Context.** A channel archived, left or taken from a person while their socket was open tells them why
(`ACCESS_REVOKED` with a `reason`, D-123, D-172). If the socket was down when it happened, the frame went to nobody,
and the reconnect's `SUBSCRIBE` was refused `CHANNEL_NOT_FOUND` with no reason: the page they were reading said
*not found*, the answer D-34 gives for a channel that was never there. Two ways to close the gap were open: the
refusal carries the reason (`gone`) for people who were in the channel, or the missed `ACCESS_REVOKED` is sent again.

**Decision.** The refused `SUBSCRIBE` is followed, in the same answer, by the `ACCESS_REVOKED` the person missed —
one frame per reason, naming only the channels of that subscription they **were in and are not** — and the `ERROR`
itself is untouched. A person who never was in a channel, or asked for one that does not exist, gets the `ERROR`
alone: the same bytes, which `departed-subscribe.integration.test.ts` compares. What decides it:

1. **Archived**: the person is still a member of a channel that is deleted (an archive keeps the memberships,
   D-123 §2).
2. **Left, removed**: leaving and being taken out delete the membership, so each now writes one row in
   `channel_departures` (`chat/0006`), replaced by the next departure and cleared when the person leaves the
   workspace. The row is read for nothing else.
3. Neither is told to a person who is not in the channel's workspace now, nor for a workspace being deleted; a
   membership that exists again outranks an older departure.
4. **One query for every refusal**, whoever asks and whatever the channel, so the two answers cannot be told apart by
   how long they take either. If it fails, the person is told *not found* as before and the failure is logged:
   a reason is not worth failing the refusal for.

The wire is **unchanged**: no new frame, no new field; a client built before this reads the refusal as always and
`ACCESS_REVOKED` as it always did, and one that knows `reason` shows it. Erasure deletes the rows (chat's hook);
they are in no export (a channel a person is not in is not theirs to take); they go with the channel.

**Rejected.** *`gone` on the refusal's `details`* — a second place a reason can come from, an error variant in the
contract (HTTP's included), and per-channel detail on an error that is about a whole frame; the notice already has a
shape and a client that handles it. *Deriving left and removed from the audit trail* — a leave is not on it (D-123 §1),
putting it there shows every workspace admin who leaves which private channel, and the trail is kept for the life of
the workspace. *A client that says what it believed it was in* — it cannot be believed, and it still needs the server
to know. *Telling any member of the workspace* — D-34.

**Cost of reversing.** One function and its call in `router.ts`, the two writes in `settings.ts`, and a migration that
drops a table nothing else reads.

*Amended 2026-11-11 by D-303:* HTTP-discovered loss requests a separate, owned departure proof.
It does not retain membership, content or pending sends while awaiting an explanation.
