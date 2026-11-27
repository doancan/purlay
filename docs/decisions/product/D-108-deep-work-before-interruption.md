# D-108. What Deep Work does before there is anything to interrupt with

D-15 made Deep Work a server-side state that suppresses delivery and expires. There is no push and no
sound yet, so "delivery" needed saying. Served by #59; decided in the owner's standing instruction to
decide and proceed, and open to their reversal.

**1 · Started until an instant, never open-ended.** `{ active: true, until }` with `until` ahead of the
server's clock and at most `DEEP_WORK_MAX_HOURS`; `{ active: false }` ends it. The contract refuses an
`active` with no `until`; the window is the server's to check, being a question about its clock.

**2 · It ends by itself, by comparison.** Every reader — the membership in `/api/me`, the delivery that
writes a notification — asks whether `until` is still ahead of its clock. No job ends it, so no
scheduler can be missing (#72) and no node can disagree about the moment.

**3 · Nothing is lost.** While it lasts a notification is written and counted exactly as without it,
and written `suppressed_by_deep_work` — which is what an interrupting delivery (Web Push, a sound) will
honour when it exists, and what a digest can be built from. Resolutions of the person's questions are
written the same way. The client silences what it shows of them (the badges) and says, in the header,
until when (`UX.md` §8).

**Rejected: suppressing the badge counters on the server.** The counters are what a read recounts;
holding them back would make them disagree with the rows, and lose what came in during the quiet.
**Rejected: an open-ended Deep Work.** D-15 asks for expiry so it cannot be left on; a bound is the
expiry nobody has to remember to set.

**Amended 2026-10-13 (#526).** A change of Deep Work is published as `DEEP_WORK_UPDATED`, with the
workspace and until when, on the person's own `user:` topic: their other tabs and devices draw the
same bar at once instead of after a reload. Nobody else is told — it is the person's own quiet. A
tab whose socket was down reads the memberships again on reconnect.
