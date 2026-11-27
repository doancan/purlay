# D-130. A channel's pins: a member's to change, everyone's to see — #485

**Context.** The Superdesign screens give a channel a Pins list beside its Files (D-129): the few
messages a team keeps at hand — the runbook, the decision, the link everyone asks for.

**Decision.**
1. **A pin is the channel's**, one per message (`pinned_messages`, migration 0028): pinned by
   whoever, it is the same pin, and pinning again leaves it as it was. Its message is in its channel
   and its channel in its workspace by the composite keys `mentions` has (I-1, I-4). Who pinned it
   outlives their account as nobody.
2. **A member's to change** — `PUT`/`DELETE /api/messages/:messageId/pin` find the message through
   the caller's visible channels in one query; seeing a public channel is not being in it, so a
   visible non-member is `403` (`NOT_A_CHANNEL_MEMBER` since D-156), as renaming it is (D-123 §1). **Everyone's to see**:
   `GET /api/channels/:channelId/pins` through the channel's context.
3. **At most `PINS_MAX` (50) a channel**, counted over pins of messages not deleted, under the
   channel's row locked (`NO KEY UPDATE`, the lock a send's own write takes): two pins at the bound
   cannot both be the last. Past it, `409 PINS_LIMIT`; pinning what is pinned is never refused. The
   list is bounded by the same number and not paged.
4. **A deleted message takes its pin with it**, in the same transaction as its mentions (D-103): a
   tombstone kept at hand is nothing to keep, and kept, the rows would grow with every deletion. One
   deleted as it was being pinned leaves a pin that neither the list nor the bound counts, and an
   unpin still lets it go.
5. **Heard as `PINS_UPDATED`** on the channel's topic, with nothing but the channel in it, only when
   something changed; a client reads the pins again, so two changes heard in either order leave the
   same list. A resubscription and a deletion read them again too.
6. **Not audited**: a pin is a member's everyday act, not an administrative one (D-26).
7. **A conversation has pins, and a reply can be one**: the list carries the reply's thread root, so
   it opens where it was said. A pin's message is always whole in the list, and a client changes its
   copy there as it changes the feed's — an edit, a reaction, a thread.
8. **The feed marks a pinned message from the same list the panel shows**, read once when the
   channel opens; Pin is a member's control beside Save, painted at once and put back when refused.
   What the person has asked and the server has not yet answered is held beside that list for the
   channel visit, never written into it (D-18): a refusal drops its own request only, whatever
   anyone else changed meanwhile, and an answer read while a request is on its way cannot take the
   painted change back. One request a message at a time; Retry only where trying again could help.

**Rejected.** *A `pinned` field on every message* — every frame that carries a message would have to
say it, and every page; the pins are read once for a channel. *Anyone who can see the channel pins* —
a public channel would be decorated by people who are not in it. *The pin's state in the frame* — a
second pin's frame overtaking the first's would leave the wrong list; read again, the order does not
matter. *Counting deleted messages' pins* — the bound would be taken by what nobody sees.

**Cost of reversing:** migration 0028's table, three routes, the frame, and the client's pins.
