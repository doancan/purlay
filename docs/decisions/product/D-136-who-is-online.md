# D-136. Who is online, for the people one shares a workspace with — #480

**Context.** D-120 moved online presence out of Phase 1 and asked dogfooding whether anyone misses
it; D-125 put it in Phase 2's second group, and the owner ordered it built before dogfooding has
started. Typing (D-114) answers "is anyone in this channel now"; this answers "is this person here".

**Decision.**
1. **Online is having Purlay open**: at least one socket on this node, any tab. Not "active" — no
   idle guess, no "away" (D-131 §5 left "away" to this; it is not built: a guess at attention reads as
   a fact about a person). Deep Work does not hide it. **Told to the people who share a workspace with
   the person**, and only them: a stranger never hears it, nor somebody removed a moment ago (membership
   is read as it is told). Accepted, and the owner's to change: a person in two workspaces who has one
   open is online to the other's members too — a socket is no workspace's, and telling which
   workspace would cost a frame from every client on every switch (O-4); it never says which.
2. **A grace before offline**: the person's last socket closing makes them offline only after
   `PRESENCE_GRACE_MS` (30 s); a socket back inside it tells nobody anything — a reload, a reconnect,
   a laptop's lid is not somebody leaving. A second socket says nothing new. The hub's own count of
   each person's sockets (the per-person cap's) is what says first and last, so nothing counts twice.
3. **Every change has a version** that only grows on the node, even across a clock stepped back; a
   client keeps the largest it has heard per person, so an "online" heard after the "offline" that
   followed it, or a snapshot read before a change, cannot undo it. `PRESENCE` is a list, so changes
   can be told together one day without a new frame.
4. **A workspace's presence** (`GET /api/workspaces/:workspaceId/presence`) is its members online,
   for a member: read when the workspace opens, and again a grace after the client reconnects — a node
   that restarted knows nobody until their sockets return, so the client keeps what it knew through the
   grace rather than showing the team offline. What the client cannot know it does not draw: a gap in
   its own connection longer than the grace, a read that failed, or a person who left the workspace
   forgets what was heard of them — no dot, never a stale one. Online is a dot on the avatar where a
   person is shown (People, a conversation's heading, their profile), and the word beside it for a
   screen reader; offline and unknown draw the same: nothing.
5. **One node** (D-25): each node knows only its sockets, so on two a person online on one is offline
   to the other — wrong, which `ARCHITECTURE.md` §6.1 allows only until the shared adapter over the bus;
   the reads are async so that adapter needs no caller to change. A stopping node tells nobody its
   sockets left: they are coming back elsewhere.
6. **Push while present** (D-126 §5) is not built here: it needs presence and a decision of its own.
   *Decided in D-143:* it reads attention, not presence — an open tab is not a person looking at it.
7. **A change that could not be told is tried again**, three times with a doubling wait, and only
   while it is still the newest change for that person: a co-member would otherwise be wrong about
   them until their next change, which may be hours away. Each failure is logged; a stopping node
   cancels the retries waiting.

**Rejected.** *Presence per workspace* — the client would say which workspace is open on every
switch, a frame per person per switch for a distinction a team of thirty rarely has. *Away after idle*
— a guess presented as a fact. *Offline at once* — every reload would blink a person off and on for
the whole team. *No snapshot, frames only* — somebody who opened Purlay before you would never be seen.

**Cost of reversing:** the frame, one route, the registry's online half; no migration.

*Amended 2026-11-03 by D-257:* §1's "no idle guess, no away" is withdrawn: away is built, idle for five minutes or
chosen, as a state and never a duration.
