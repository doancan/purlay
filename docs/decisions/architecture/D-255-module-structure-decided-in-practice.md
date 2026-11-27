# D-255. Decided in practice (module structure) — builds on D-250, D-254

**Context.** Two modules now run, and building the second one settled several things the first decision either
left open or got wrong, each of them decided in a pull request and written in no decision. Two sentences of D-250
rule 8 and one of D-254 §6 are no longer true, and a document that keeps saying them is a defect (`MODULES.md` §8).
This records what is true. D-250 and D-254 stand otherwise, and their text is not rewritten: each sentence this
changes carries a note that points here.

**Decision.**

1. **A cluster is told, not stopped.** *Amends D-250 rule 8.* Where nodes share Redis each records its module set in one
   shared record that lapses by itself (`realtime/module-set.ts`); a node that finds another set logs it once, and
   once more when the nodes agree, and **keeps serving**; readiness does not change. A node does not refuse beside a
   peer with another set. Nodes of different sets **share the one bus channel**, because a channel per set would stop
   a sign-out on one node from closing the sockets of another. What keeps a node out of a module it does not run is
   the closure of §2, not the channel. A rolling deploy of a new set therefore passes, and the advice to an
   operator is to finish the roll (`DEPLOY.md`).
2. **Closed means a path nobody has.** *Amends D-250 rule 3's "not mounted".* Every route of the build is registered, because the
   application is one typed chain and its type is what the web client reads; a module that is not run is closed by
   the manifest: its `routes` are answered as any unknown path, before the rate limit and the session; its `frames`
   as an operation nobody has; its `events` are dropped at delivery, from the node's own services and from a node
   that does run it (a person's own topic is held by every socket, so a topic would not keep them out); its `jobs`
   exit `0` with a line. At the edge the order is the same: a closed webhook is not asked for the body rules of a
   webhook, so it answers whatever its headers say as `/api/no-such-thing` does. A route-ownership test holds the
   manifests and the registered routes together.
3. **Data is held whether or not a module runs, and `tableExists` is how.** A module's erasure, purge, export and
   retention contributions are in every process's composition (every bundled module's) and each asks `tableExists`
   (`@purlay/db`) at the moment it needs a table the module's own set makes, never remembered, since another node may
   apply the set while this one runs. Chat's own-set tables and issues' table are held this way (D-254 §4). A process
   that runs a module on a database without its set is not a cell: readiness refuses it. The alternative, a
   contribution split into a part held always and a part held where the set is applied, would need the process to
   know the database's sets when composed.
4. **An attached file is chat's.** What is attached to a message is judged by chat's `readAttachment`: with chat not run,
   `GET /api/attachments/:id` and `/thumbnail` answer `ATTACHMENT_NOT_FOUND` for it as for an id that never existed,
   while an upload nobody attached stays its uploader's. The core names no module; the manifest widens the reader.
5. **The session carries the modules; the public handshake does not.** *Amends D-254 §6.* `GET /api/me` lists
   `modules`; `GET /api/client` names none (PR #963). A closed route's body and code are those of an unknown path. Its
   status is not: for a caller with no session a route of a running module answers `401` and one of a module not run
   answers `404`, an unknown path always `404`, so the set is observable anonymously from that status (shown by
   sweeping every route against `MODULES` of none, chat, issues and both), and from `capabilities`
   (`scheduledMessages`, `messageReminders`, `personalMessageDeletion`, D-58), true only when chat runs and kept
   because a native client needs them before it signs in. This is accepted and documented (`MODULES.md` §3); the way
   to remove the status signal is to answer `401` before `404` for every `/api/*` path without a session. The macOS
   client reading `modules` is issue #958.
6. **The contract migration of the attachment link is chat's.** The three-release move of `attachments.message_id` and
   `channel_id` (`MODULES.md` §10, step 8) ends with a step in **chat's own set**, `chat/0005` (the release
   after `v0.3.0`, which contains the expand), not in the core's migrations: a core migration never names a module's
   table (D-250 rule 5), and the columns are the link's. It removes the dual write and its allow-list.
7. **Manifests do not shrink silently.** `module-compat.test.ts` holds the manifests to the last release's, kept in
   `released-manifests.json`: no new requirement, no capability, route, job, frame or id gone, unless a dated entry
   under `exceptions` in that file says so, where a reviewer sees it. `bun run release` rewrites the snapshot and
   clears the exceptions.
8. **Issues stays minimal.** D-254 stands: no link, no frame, no comments, no notification *(Amended 2026-11-07, D-283 §8: an
   assignment notice and a search source are decided; the link, the frame and the comments stand)*. Its removal threshold is
   **decided by the owner at each release, against the measured use**; a measurable rule is required before a package
   is sold (D-250 rule 9) and does not exist yet.
9. **Pool isolation is wired for issues, and a gate holds chat against starvation.** *D-250 rule 7 said it would be built
   before a second module ships; the second module shipped without it, and that was recorded as a debt.* The debt is
   paid: `budgeted` (`platform/module-budget.ts`: a cap on open transactions, a queue timeout, a `statement_timeout`) is
   handed to the issues routes (a third of the pool, never more than the pool minus one), chat is not budgeted *(amended D-269: chat has a share of its own and
   the core keeps a reserve the modules cannot take; D-266: the share is held at the connection, not as a cap on open transactions)*, and
   `budget:latency` runs the send path with issues holding its share and fails if chat's p95 passes eight times the
   quiet p95 of the same run (measured on a 2-core runner: 2.4 to 3.7 times with the budget, about twenty times
   without). What it does not hold: a busy module's CPU and event-loop cost on a shared process, which can still cost
   chat about three times its p95 on a small host.

**Rejected.** *Refusing to serve beside a peer with another set* (D-250's text): a rolling deploy of a new set would
be impossible without an outage, and a typo would be an outage anyway. *A bus channel per set*: a sign-out must reach
every socket. *Leaving unmounted routes out of the chain*: it breaks the typed client. *Listing modules in the public
handshake*: a caller who has not signed in would read the instance's packages.

**Cost of reversing.** Documentation and tests only; §1 and §2 are held by `module-set.test.ts` and `modules-off*`, and a
change of either is a change of those.
