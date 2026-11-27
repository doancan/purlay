# D-296. The server's administrator can stop a module for every workspace at run time, and every node believes it within two seconds — builds on D-250, D-255, D-281, D-288, D-289, D-292; amends `MODULES.md` §3 and §10

**Context.** The only way to stop a misbehaving module in production was to change `MODULES` and restart every node (D-255): a rolling
restart, minutes long, during which two sets are live and `PEERS_BEHIND` refuses the restrictions an operator may also want. A grant
(D-289) is the wrong tool: it is per workspace, written for a sale, and `always` modules (chat) cannot be withdrawn by it. An operator
of an editions platform needs a switch that is immediate, reversible, audited, server-wide, and that leaves the data where it is.
`MODULES.md` §10 listed it as not built, with the incident that would start it.

**Decision.**

1. **One table, `suspended_modules`**, owned by the core (`TABLE_OWNERS`): `module` (the key, in the module id's grammar and with no
   foreign key, as `workspace_modules.module` is), the operator's `reason` (1 to 200 characters), a `source` label, the administrator
   (`suspended_by`) and `suspended_at`. A row is a stop; deleting it is the resume. A table and not a column of `server_settings`: that
   row is one for the whole server, replaced by patches of the setup and the console and absent on a server that has never written it,
   and a stop wants a reason and a time for each module.
2. **The set is `closure_requires((running − suspended) ∩ granted(workspace))`.** `effectiveModules` takes the stop as one more input
   and stays pure. A module that declares `entitlement: 'always'` is not spared: chat can be stopped, which takes the product down,
   so the writer asks for it to be confirmed (item 7).
3. **A stopped module is a module that is not run, for the moment.** Its routes answer the `ROUTE_NOT_FOUND` of an unknown path,
   byte for byte and before authentication, so a caller with no session learns nothing a process without the module does not tell
   (`Composition.closed`); its `jobs` are closed (`closedJob`), its worker iterations, `outbox:consume` among them, do not run, and a
   row waits where it is; its operations and events on the socket are refused and not heard (`closedFrame`, `closedEvent`); `find`
   reports its sources `skipped: off`; the notification sink writes nothing for it; a fact for it as a consumer follows the fact's
   own `absent` word, dropped and counted or held for the days it says, and a row written earlier waits for the module; its ports
   read as `undefined`; `GET /api/me` and `GET /api/client` stop naming it and the capabilities that depend on it. A downgrade of one
   workspace and a stop of the server are the same function, so they cannot disagree about what "off" means.
4. **What stays.** Every row, and with it export, erasure, the workspace purge and retention (`retention` jobs are not `jobs` and
   run as they do for a module that is not run, D-250 rule 5). Migrations still apply. A resume brings everything back, and loses
   nothing but the notices and the dropped facts of the time between, which are what "not run" means.
5. **`requires` is closed over.** The table holds exactly what the administrator named. A module that requires a stopped one leaves
   the set with it (`closure_requires`) and returns when it does; the console says which. Refusing the stop until the dependents are
   stopped was the other choice: it is slower in an incident, and the stored state would then say something the administrator did not
   decide twice. No module of the build requires another today, so this is held by the pure function's tests.
6. **Every node reads the table through a cache of at most `SUSPENSION_TTL_MS` (2 seconds).** `Suspension.fresh()` reads when the
   last read is older than that, one read at a time however many ask; a request, a worker iteration and a timer of the node ask it, so
   a quiet node and a busy one both keep within the TTL; `current()` answers with no wait for what cannot await (a route table, a
   socket's frame). The hot path pays one comparison; the query is one in two seconds a node. A read that fails keeps the set last
   read and says so once: a database that blinks must not lift a stop that was put on for an incident. A node that has just
   committed a change knows it at once. There is **no invalidation message**: nothing in settings travels over the bus (the settings
   swap is a holder in the process), the bus carries frames and not state (D-7), and a hint that could be lost would add a second way
   for nodes to disagree; the TTL is the whole contract and correctness never depends on Redis.
7. **The writer** is one service every writer calls, in the caller's transaction, behind the administrator's lock, audited with the
   operator's reason in `server_audit_log.note` (`server.module_suspended`, `server.module_resumed`, the module in
   `target_module`); a repeat is no change. It refuses a module the build does not carry, and a module that is `always` or whose
   stop would take one down with it unless the request says `force: true`, which is the confirmation. Its callers are
   `POST /api/server/modules/:moduleId/suspension` (guard before parsing, behind the administrator's lock), which answers the
   modules that stopped, or came back, with it, and, in the change that follows, `bun run module:suspend` and `module:resume`
   and `GET /api/server/modules`. The node that wrote a stop believes it at once.
   The reason is the one place the trail holds words: the operator's own, 200 characters at most, because the row that held them is
   gone once the stop is lifted.
8. **A stop waits for the cluster.** A node of a release that predates the table does not stop anything, so the write is refused
   `409 PEERS_BEHIND` while a live peer does not advertise that it reads the table, as a restrictive grant is (D-292 §6). Resuming
   is never refused for it. A second record in Redis (`suspensionNodes`) says which nodes read the table, beside the grants one,
   because a release can read grants without reading stops.
9. **Safe mode and a stop are different tools.** `MODULES=none` is the core alone, chosen at deploy, for every node, and restarts
   them. A stop is chosen at run time, per module, by the administrator, and ends at the next resume. Neither deletes anything.

**Measured.** On the machine this was built on (one Postgres, three trials each): `budget:latency` before and after, the lowest of three
p95s, ACK 25.8 → 27.0 ms and fan-out 25.9 → 27.0 ms (noise across trials 25.8 to 49.9 ms in the first run, 27.0 to 47.3 in the second),
issues' list with chat busy 9.6 → 5.2 ms, and the run passes the first as a baseline. Per call, a cached `fresh()` costs 82 ns, `closed(path)` 62
ns with and without a cache, and `effectiveModules` 184 ns with an empty stop and 183 without: the stop adds a comparison to a request, and
one query to the table in two seconds to a node. No statement is added to a request.

**Rejected.** *A feature-flag service or a percentage rollout:* D-250 refused a flag over shared code, and this is not one: it is the
module not being run. *An environment variable read again:* it is the restart under another name. *A Redis key:* correctness would depend
on Redis, which it does not anywhere else in the core. *One read of the table for every request:* the cost the cache removes, for a
state that changes by hand a few times a year. *A column on `server_settings`:* item 1. *Letting a workspace's owner stop a module:*
the switch is the server's.

**Cost of reversing.** Drop the reader: every node serves what `MODULES` and the grants say, as before, and the table is inert.
