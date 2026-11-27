# D-132. Starred channels: a member's own, kept above the rest — #489

*Amended by D-284: A person groups their own channels under named headings across devices — #1198.*

**Context.** The Superdesign screens keep a few channels in a Starred section above Channels, and
offer a pick of channels to join on accepting an invitation. D-125 put both in Phase 2.

**Decision.**
1. **A star is a member's own**, on their membership row (`channel_members.starred_at`, migration
   0030), as their read position and notification level are: on the channel as `starred` for them,
   false for anybody not in it.
2. **Set and let go** with `PUT`/`DELETE /api/channels/:channelId/star`, idempotent; a channel the
   caller is not in is `404`, the notification level's rule (D-107). Not a direct message's: a person
   is found under People, a group under Conversations — and one is refused as not found, on purpose,
   as a channel that is not one to star. One conditional statement decides and writes, so two stars
   at once change the row once and tell once.
3. **The other tabs are told** with `CHANNELS_UPDATED` on the person's own topic, carrying the
   workspace only, and read their channels again — only on a change.
4. **The Starred section** is above Channels and takes its channels out of it; by name, since a
   place you keep should stay where you put it; absent while nothing is starred. Star is in the
   channel's header (in the Channel menu on a narrow window), its name constant and `aria-pressed`
   saying whether it is; painted at once and put back when refused, only while it is still as that
   asked. A channel's requests go one after another, so the last click is what stays, and once
   answered the channels are read again. `Alt+↑/↓` and the palette walk the sidebar's own order.

5. **Channels to join on arriving**: accepting an invitation leads to `/w/:slug/welcome`, the
   workspace's public channels not yet joined, by name; the three with the latest messages are marked
   Active and picked, a silent channel is never recommended. Joined together with the existing join,
   or skipped; a join that fails part way says which channels by name, and why, and keeps those
   picked unless they are gone. They are joined four at a time — each is a write on the budget the
   person's first message spends — and the marks are set once, so a list read again does not move
   them. A person who leaves while the joins are on their way is not moved, and a failure is said
   where they are.

**Rejected.** *The star in `ChannelState`* — every frame that carries a read position would have to
read the star too, and a star changes nothing a read position says. *A frame carrying the star* —
two tabs' changes heard out of order would leave the wrong one; read again, order does not matter.
*Starred by activity* — the section would reorder itself under the pointer.
*Recommendations by members or by an admin's choice* — the first needs a count on every channel
row, the second a setting nobody has asked for; the latest message says where the team is talking.

**Cost of reversing:** migration 0030's column, two routes, the frame, the section, and the welcome
step.
