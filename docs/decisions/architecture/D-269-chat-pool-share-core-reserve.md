# D-269. Chat has a share of the pool, and the core keeps a reserve the modules cannot take — builds on D-250, D-260, D-266; amends D-255 §9 and D-260 §1

**Context.** With the share held at the connection (D-266) chat could have one, and chat declared `none`: a busy chat
could hold every connection and queue the core's own reads. Measured on a real process at a pool of ten
(`DATABASE_POOL_MAX`'s default), with fourteen closed-loop readers of a chat table that was locked in turns and twelve
readers of issues' table likewise, and a probe of `GET /api/me` (the core: a session and a membership) every fifty
milliseconds: with chat unbudgeted the probe's p95 was **about 750 ms** (it waited for a connection) whenever chat was
busy, against 15–25 ms quiet.

**Decision.**

1. **The modules together may take the pool less a reserve for the core**: a fifth, at least one, none in a pool of one
   (`coreReserve`, `platform/module-budget.ts`). A request takes a slot of its module's share and one of the modules'
   together, so two busy modules cannot queue the core's reads between them.
2. **Chat has what the modules may take together less one** (`features/chat/budget.ts`): seven of ten, so that no module
   can take every connection the modules share and issues, as chat from issues, is never locked out; a queue timeout of
   three seconds (`POOL_DEFAULTS.connectionTimeoutMs`: what the pool itself waits, so a send is refused no sooner than
   before) and the pool's own statement limit (no `set` on its connections). Not configurable, as issues' is not: a
   constant each, in the module's own `budget.ts`, changed by a decision.
3. **A freed slot goes to the oldest request waiting**, not the longest wait (`slots`, ranked by when the request began). A
   send needs a connection several times, once per statement, and first in, first out queued it again behind newer
   requests at each: measured, that cost chat's own sends under its own saturation about five seconds (below).
4. **A socket frame is held to its module's share as a route is**: the router notes the module of the frame's operation
   from the manifests' `frames` (`noteModule`), so chat's sends are chat's, not the core's.
5. **No module is exempt.** `module-budgets.test.ts` lists the modules that declare `none`, with the reason; it is empty.

**Measured** (the same scenario, a pool of ten, p95 of a message's `ACK` over sixty sends at a pace of eight a second while
the others ran; the probe is the core; each cell is the runs it was measured in, in order; "of 60" is how many sends were
acknowledged, the others being refused as busy):

| | chat busy: `ACK` p95 | chat busy: core p95 | chat and issues busy: `ACK` p95 | chat and issues busy: core p95 |
|---|---|---|---|---|
| before (chat unbudgeted) | 699, 849 ms | 755, 761 ms | 726, 963 ms | 758, 762 ms |
| chat seven of ten, oldest request first (chosen) | 1,740, 817 ms | 21, 18 ms | 2,294 (54 of 60), 710 ms | 31, 17 ms |
| the same, first in first out | 5,353 (34 of 60), 5,088 (34), 4,690 (38) ms | 45, 51 ms | 5,450 (34), 5,877 (25), 6,079 (28) ms | 91, 81 ms |
| chat eight of ten, oldest first | 1,115 ms | 26 ms | 967 ms | 20 ms |

What this says is the core's column: with the reserve its reads stayed at 17–91 ms in every run, where without it they
waited about 750 ms for a connection. Chat's own `ACK` under its own saturation varies two- to three-fold between runs on
a shared machine, and the cap and the reserve cost it something: seven and eight are not told apart, but oldest first and
first in first out are, in six runs against five, by a factor of three or more and by sends refused, so oldest first
ships. With issues alone busy chat's `ACK` p95 (26–92 ms over four runs of the chosen share) stayed within the spread of
its quiet figure (29–269 ms). Chat busy with its own readers on a locked table is the worst case for chat's own sends:
they queue behind its slow reads whatever the cap, and the cost over no cap at all, at this pool, is the price of the
core's reserve. Seven rather than eight leaves issues a connection chat can never take: issues may be refused as busy
while chat saturates the rest, never locked out.

**Rejected.** *Chat unbudgeted, as D-260 left it*: the measurement above. *Chat at what the modules share* (eight): the
same figures within the spread, and issues could be locked out by a busy chat. *A larger reserve* (a third): the core's
reads are a few connections' worth at a thousand requests a second, and chat is the product. *First in, first out*: the
table.

**Cost of reversing.** `coreReserve` and `together` in `moduleConnections`, the frame's note, and chat's `budget` back to
`none` with its line in `module-budgets.test.ts`. Nothing is stored.
