# D-298. A full queue of pushes lets go of its oldest, and says how many — builds on D-143, D-25, D-126

*Amended by D-354: §3's map half (`dropOldest`) is removed, its caller having moved to PostgreSQL with D-307; the line's half stays.*

**Context.** The push sender keeps two queues in memory: the devices waiting for their turn (at most `POSTS_AT_ONCE` in flight, a thousand
waiting) and the notices held while their person is in Deep Work or quiet hours (a thousand, each for at most a day, which is how long a
push service keeps a push for a device that is off). Past the bound a push was dropped and counted, but the one dropped was the one that
had just arrived: the held queue kept its first thousand and refused the next, and the line of devices refused the devices of the
notice being sent. Under overload that keeps the stalest pushes and discards the one a person is waiting for.

**Decision.**

1. **Both queues let go of their oldest.** The line of devices drops from its front until it fits; a fan-out larger than the line keeps its
   newest `queueMax` devices. The held notices are a map in the order they were held, and the oldest go first. The oldest is also the
   nearest to the end of its day, so the push most likely to be worth nothing is the one lost. Each drop is counted as `dropped` under the
   sender's module and the log says how many (`push dropped: too many waiting`, `push dropped: too many held`), as it did.
2. **The bound is a dependency.** `queueMax` defaults to the thousand and is given smaller by a test of the bound: three devices prove what a
   thousand real encryptions took five seconds to, which is how long a test is given.
3. **The two small pieces are shared and tested alone** (`platform/bounded.ts`: `dropOldest` for a map, `dropOldestOf` for a line).
4. **A release of held notices does not start while the last is running** (a tick of the minute timer; a manual call is still allowed),
   so a slow database cannot make the next tick ask for what this one is sending. And the sweep of who is in front of a page stops at the
   first word still good, since the map is kept oldest first and a renewed word goes to the end: a call costs what has run out and not
   everyone active.

**Rejected.** *Dropping the newest (tail drop):* a notice queue is not a request queue, nothing is waiting on the answer, and the newest is
what the person was just told of. *A priority by kind:* the sender has no ranking of kinds and a mention is not always more urgent than
a direct message; adding one is a product decision this does not make. *Collapsing pushes per conversation (a collapse key):* worth
having, and a different change: the notices already collapse in the inbox (D-143), and a push service's own collapse key is not read by
every browser. *A queue outside the process:* D-25 keeps the sender on one node until measured, and what is held is forgotten on a
restart by design (the notice is in the inbox).

**Cost of reversing.** Nothing is stored. Restore the `slice` of the first thousand and the two queues drop the newest again.

**Amended by D-307:** accepted browser delivery work, per-device attempts and admission now survive
restart in PostgreSQL; RAM wake-ups no longer own the work. Current source/device authority is checked
on every bounded attempt, and disabling cancels accepted work without cascading through busy devices.
