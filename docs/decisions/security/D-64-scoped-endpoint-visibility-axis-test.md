# D-64. Every scoped endpoint says where it sits on the visibility axis, and the test follows

D-34 put the second axis in the guard, and the guard was tested — at the guard. Whether each
endpoint actually reached it was proven by one loop, and that loop's stranger was in another
workspace: it crossed the first axis twice and the second never. A private channel was not seeded
anywhere above the guard.

**Decided: the axis is a required field of the case D-63 already demands.** `channel` — it names a
channel, and a workspace member who cannot see it gets the never-existed answer for each of the
three intra-workspace refusals: private and not theirs, a DM they are not in, deleted. `workspace-wide`
— it reads across channels, and no id of a hidden channel may appear anywhere in the response.
`none` — with the sentence saying why. Required means the compiler refuses a case that has not
decided; and a path containing `:channelId` may not choose `none`.

**The control is the same caller on a channel they can see**, not the owner on the hidden one. The
owner differs from the outsider in more than visibility; the outsider differs from themselves only in
which channel the request names. For a workspace-wide read the control runs the other way: the
owner's identical read does contain the hidden ids, so an absence is one the read could have
broken.

**Search and open questions are named, because they are where the leak was found.** Neither is
built. When either is served it must be `workspace-wide`, and neither may be declared `UNSCOPED`;
until then the check holds them by name and fails if either leaves `API.md`, so it cannot pass by
skipping them. That is how the issue's demand on two Phase 1 endpoints is met in Phase 0: not by a
test of something that does not exist, but by a build that will not serve them without one.

**Rejected: seeding hidden channels only when Phase 1 creates them.** The guard is written whole
(`ARCHITECTURE.md` §7.5) so that it is right before the first private conversation exists; a test
that waits for the creating endpoint proves it right only afterwards.
