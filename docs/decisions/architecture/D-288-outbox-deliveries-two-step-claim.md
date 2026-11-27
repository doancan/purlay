# D-288. The outbox is a table of deliveries, published in the publisher's transaction and claimed and delivered in two steps — builds on D-35, D-250, D-274, D-281, D-283; amends D-283 §2 and §3

*Amended by D-325: §12's "no command-line twin" is reversed; `bun run outbox:requeue` and `outbox:discard` write through the console's writer.*

**Context.** D-283 decided that a fact between modules is an outbox row and left the details to the step that builds it: what the
row is, what `publishFact` refuses, what a claim and a delivery do when two nodes run at once, a node dies, a handler throws or a
payload no longer fits. Step 14c of `MODULES.md` §10 builds the table and the publishing (§1 to §3, §6 and §7 below); the claim
and the delivery (§4 and §5) are step 14d with the worker that runs them for a module (§8); the sweep, the metrics and the overview
line (§9) are 14e. All of it is decided here so that each step is held to one text. Nothing in the product publishes yet, on the
owner's decision (D-283 §2): a fake third module's tests are the consumer, and the first production publisher, a system message in
a chat channel, waits for the feature that wants it. The outbox is for facts of human scale, an assignment or a link, and never a
fact for each message (D-35).

**Decision.**
1. **A row is one delivery.** `outbox` (`0089_outbox.sql`, the core's, a new table with its indexes made with it): `id` and `fact_id`
   (UUIDv7, the application's, as a message's id is), `workspace_id` on every row with a key to `workspaces`, `type`, `producer`,
   `consumer`, the `payload`, `state` (`pending`, `delivered`, `dead`, `skipped`), `attempts`, `next_attempt_at`, `last_error`
   (a class of error, at most 300 characters, never the payload), `shape` (the version of the fact's declaration that wrote it, from 1),
   `correlation_id` (the request that published it) and `caused_by` (the fact whose delivery published it) so a log line follows the
   chain from request to fact to consumer, and `created_at`, `finished_at` and `expires_at`. One row for each
   (fact, consumer), `UNIQUE (fact_id, consumer)`. Times are the application's clock's, as in the core's other tables, so a test moves
   them. `finished_at` is set exactly when `state` is not `pending`, by a `CHECK`. The table is never exported. Its erasure decision is
   `nobody`, since no column names a person and an id in a payload names the anonymised account after an erasure (D-256); its
   retention is `swept` by `sweep:outbox` (§9), probed by `table-lifecycle.integration.test.ts`.
   A deleted workspace's rows are taken by the purge, since its tombstone's key never cascades (D-242).
2. **`publishFact(transaction, context, fact, payload)`** writes a row for each module of the build that consumes the type, in the
   caller's transaction. It takes `Transaction` and not an executor, and checks at run time that it is one, since a cast could unsay
   the type. It refuses, with an error that ends the publisher's transaction and so leaves nothing of the fact: a publisher that is
   not the fact's owner or does not list the type under `publishes`; a request of another module than the publisher's (`currentRequest`);
   a payload that does not fit the declaration, saying where and never what; a payload past 8192 bytes of compact JSON. The table's own
   check is 16384, since `jsonb` writes a space after each separator, and is the backstop and not the rule. A fact nobody consumes writes
   nothing. A consumer the workspace is not granted (D-289) gets no row either, judged by the composition's function of the grants
   (`effective`) for the consumers this process runs; one it does not run is judged where it is run, at its delivery, and the claim
   leaves a row of a workspace that is not granted its consumer as it is, untouched, so a grant given later finds it.
3. **`absent` is in the declaration.** `'drop'` writes no row for a consumer the publishing process does not run and counts it
   (`purlay_outbox_dropped_total`); `{ holdDays: n }`, `n` a whole number from 1 to 14 (`FACT_HOLD_DAYS_MAX`, held by
   `factOwnerProblems`), writes it and expires it after `n` days. A row for a consumer that is run and whose fact is `drop` expires after
   a day, because a notice delivered later than that is wrong, and the module may be turned off in the meantime.
4. **The claim** takes up to a batch of due rows of the (consumer, type) pairs this node has a handler for, and of the shapes it knows
   (`shape` at most the declaration's), with `FOR UPDATE SKIP LOCKED`, oldest due first, adds one to `attempts`
   and sets `next_attempt_at` to now plus `min(5 s * 2^(n-1), 1 h)` within 20% either way, and commits. The backoff is the lease: a
   row is not given to a second node before it. A row that has already used eight attempts without ending is made `dead` there,
   `AttemptsExhausted`, and its handler is not asked again: a fact that hangs or kills the node that runs it reaches the ceiling by
   that and is not the node's last words for ever.
5. **The delivery** locks the claimed row in the consumer's own transaction (`FOR UPDATE SKIP LOCKED`, `state = 'pending'`) and leaves it,
   as `gone`, if it is delivered or held. It checks the payload again, **against the schema of the shape the row was written in** (the row's `shape`), and
   hands the handler the payload in the declaration's current shape. A row of the current shape is checked against `schema`; a row of an
   earlier shape against the `schema` of the declaration's `reads[shape]` and made current by that reader's `upcast`, whose result is
   checked against `schema` too. A payload that does not fit its own shape, a shape no reader describes, and an upgrade that throws or
   makes what the current shape refuses are `dead` at once, `PayloadRefused`: none is going to get better. A type or a shape newer than
   this node's is never claimed, so a newer node's row waits, untouched and with no attempt burned, for a node that does, and expires
   as any row does if none comes. A change to a payload that an older node would refuse (a new required field, a value more in an
   enum, a narrower bound) raises the declaration's `shape`; an optional field does not. **Shapes only grow:** the declaration that
   raises the shape keeps a reader for every shape the last release could write, so the newer node of a rolling deploy delivers
   the rows the older node published instead of ending them; `module-compat.test.ts` holds this against the release snapshot's
   `facts` (each fact's shape and the shapes it reads), and a reader is dropped only by a dated exception, as a dropped type is.
   (The first text of this item checked every row against the newest schema, which lost a fact for each row an older node had
   published under a shape that added a required field, #1265.) The handler runs under a savepoint with the transaction, the fact's id and its **workspace as the row
   has it**, and a throw rolls the savepoint back, records the class of the error and leaves the row pending for its backoff, or
   makes it `dead` when it was the eighth attempt (the ceiling is `OUTBOX_ATTEMPTS_MAX`). A handler that returns `'skipped'` ends the row
   as `skipped`. Otherwise the row is marked `delivered` in the same transaction, outside the savepoint, so a failure of the mark
   is a failure of the transaction and takes the handler's effect with it. A dead row is logged at `error` with the module, the fact
   type and the fact id, and never the payload.
6. **Only the outbox's own files name the table.** `platform/outbox.ts` and, from step 14d, `platform/outbox-drain.ts`; `core-tables.test.ts`
   reads every other file of the core for it, and a module's typed handle does not hold it (D-271).
7. **What the release holds (amends D-283 §3).** The release snapshot holds `publishes` and `consumes`: a type a module no longer
   publishes or no longer consumes is a break that needs a dated exception, since a row an older node writes waits for a handler that
   is gone. `uses` is not held: asking a question less breaks nobody. A snapshot written before facts existed promised none. It also holds each declared fact's `shape` and the shapes it reads (§5). The contract
   bundle's module structure gains `publishes`, `consumes` and `uses`, from the manifests; `CONTRACT_VERSION` does not move.

8. **A consumer runs as a worker of its module (step 14d).** For each module that runs and consumes a type, `compose` adds one worker,
   `outbox:consume`, to the workers the module already has (D-281): the module's share of the pool, its `workerDeadline`, the error
   boundary and `purlay_worker_failures_total{module,worker}` come with it, and no scheduler is new. It claims a batch of at most 20
   of its module's rows and delivers them one after another, every two seconds. The wait of a fact is therefore two seconds and the
   time of the work; it is measured, and a local nudge from the publisher is added only if the measure asks for it.
9. **The sweep and the metrics (step 14e).** `sweep:outbox`, a core job of every process: rows delivered or skipped after a day, dead
   after thirty *(amended 2026-11-09, §12: dead and discarded after `OUTBOX_DEAD_KEPT_DAYS`, 180 unless set)*, and pending rows past `expires_at`, which it counts as expired, in batches of at most 5000 rows. Gauges for depth, age
   of the oldest and dead rows by module, and counters for deliveries, failures and drops by module and fact, whose labels are the
   closed sets of the manifests. The overview of the server lists a module with dead rows or a pending row older than fifteen minutes.
   `DEPLOY.md` names the volume at which the table should be partitioned: more than a million rows a day, or vacuum that falls behind.
10. **A workspace may have only so many facts waiting for one consumer** *(added 2026-11-08, after the enterprise review's third
    blocker: one workspace publishing a flood delayed every other's facts for hours).* `publishFact` counts, in the publisher's
    transaction, the pending rows of the workspace for each consumer it is about to write, and when any is at `OUTBOX_PENDING_MAX`
    (5000 unless set, from 1 to 1,000,000; `CONFIG.md`) it refuses the **whole** fact with `FactBacklogFull`, which names the fact type,
    the workspace and the consumer, writes a row for no consumer, and counts `purlay_outbox_refused_total{module,fact}` (the consuming
    module and the fact type, both from manifests). A refusal is an error and never a drop: uncaught it ends the publisher's
    transaction, so what the fact reports is not committed either and a fact is never lost while its cause stays; a module that
    catches it holds a transaction that is still usable and decides for itself (refusing its own request, as a rule). It applies to
    every fact, since the outbox is for facts of human scale (§2) and 5000 waiting for one consumer in one workspace is a hundred
    times that rule, a defect or an attack and not a use. Only pending rows count: delivered, skipped and dead rows are room. The
    ceiling is soft, because the count takes no lock: publishes in flight at once may pass it by their number. The count stops at
    the ceiling (`LIMIT`), so it costs at most that many index entries, and it is served by `idx_outbox_pending_workspace`
    (`0091`): on a million rows a workspace with 150,000 delivered rows of history and three pending was counted in 0.06 ms with the
    index and 130 ms without it (0093 replaces that index with the one of §11, which counts as fast). Over HTTP an uncaught refusal is
    answered `503` `FACT_BACKLOG_FULL` with `Retry-After: 30` (an additive code; the body names neither the workspace nor the module,
    and the log at `warn` does). The claim's fairness across workspaces is the next item.
11. **A claim goes by turns across workspaces** *(added 2026-11-08)*. The claim of §4 took the oldest due rows of the consumer, so a
    workspace whose backlog was older than everyone's filled every batch of 20 until it was empty (ten thousand facts at ten a
    second is a quarter of an hour; the ceiling of §10 bounds it, and this keeps even that from being a wait for the rest). It now
    picks, in one statement and without locking: the `batch` workspaces whose oldest due row has waited longest, found by walking
    `idx_outbox_pending_by_workspace` (`0093`, on consumer, workspace and due time) from one workspace to the next; each one's due rows
    oldest first, up to a batch, ranked within the workspace by `row_number()`; and the first `batch` of them by rank and then by age.
    A workspace therefore has one place in a batch while another has a fact due, a larger share when fewer are waiting, and the whole
    batch when none is, and within a workspace the order is still oldest first. The rows picked are then taken with
    `FOR UPDATE SKIP LOCKED` and asked again whether they are due, so two nodes claiming at once still never hold one row: one that
    picked the same rows finds them leased or held and takes none that round, which a claim of a few milliseconds every two seconds
    makes rare. Measured on a million pending rows over 5,000 workspaces (one with 300,000): 46 to 54 ms steady (127 ms with a cold
    cache), where the first FIFO claim took 0.4 ms and a window `row_number() over (partition by workspace_id)` over every due row took
    830 ms. The cost is a probe for each workspace that has anything pending for the consumer, about 10 µs each, and does not grow with
    the depth of any one. A workspace not granted the consumer (§2) is found by asking the grants of the workspaces picked, inside the claim, and is left out
    of the pick, which is made again without it (it looks at four workspaces for each place and makes the pick five times at most, so some four hundred such workspaces are passed over): its rows are never
    locked and hold no place in a batch, where before 50 due rows of one workspace without the grant left every granted workspace with
    no claim at all.
12. **The server's administrator can look at the outbox, and nobody else** *(added 2026-11-09, #1197)*. A dead fact was only counted, so
    the question an auditor asks first, what failed at 3 a.m. and who decided what became of it, had no answer but hand SQL on a
    table the code hides. `GET /api/server/outbox` lists deliveries as **metadata**: the row's id and the fact's, type, shape, workspace,
    producer, consumer, state, attempts, the class of the last error, and the times; never the payload. It filters by `state` (`dead`, the
    default; `stuck`, a pending row older than the overview's fifteen minutes; `discarded`), `consumer`, `type` and `workspaceId`, oldest
    first by id, a keyset page of at most 100. `GET /api/server/outbox/:id` shows one delivery whole. **The payload is shown, and the read is
    audited**: a fact cannot be judged, fixed and requeued or discarded, without seeing what it said, and redacting it would send the
    operator back to SQL; so the administrator sees it, and `server.fact_inspected` records who, the fact's id (`target_fact_id`, new, no
    key since the row is swept and the entry is not), its workspace and its consumer, never a word of it, in the transaction of the read and after
    the administrator is rechecked under the lock every authority change takes (D-292 §2). Each read is an entry, so reading twice is two
    reads. Both routes sit behind the guard of the rest of `/api/server`, before parsing: an owner, a member and a stranger get the same `404`.
    The SQL is in `platform/outbox-operate.ts`, one more of the files that name the table (§6).
    **Requeue and discard** *(same item, built after the read side)*: `POST /api/server/outbox/requeue` and `/discard` take up to fifty
    delivery ids and the administrator's **reason** (1 to 200 characters, not blank), and answer a result for each id. A requeue makes a
    dead, discarded or stuck delivery `pending` again with no tries used, due now, and its expiry held at least seven days ahead, since a dead
    row's own may have passed and the sweep would take it at once; a discard ends a dead or pending delivery as `discarded` (new state,
    migration 0095, `finished_at` is when), kept for the audit and sweepable at the retention horizon. A delivery that is over,
    `delivered` or `skipped`, is **refused** in both: it was acted on, and acting twice is the fault the table prevents. Repeats are
    `unchanged` and write nothing: the rows are locked in id order and judged under the lock, so two requests at once for one row are
    one change and one entry, and a delivery in flight is waited for and then found delivered. Every change is one entry on the
    trail, `server.fact_requeued` or `server.fact_discarded`, with the fact's id, workspace, consumer and the reason in `note` (the column
    D-296 added for an administrator's words), in the change's transaction after the administrator is rechecked under the lock. The
    reason is the administrator's own and never the fact's. **No command-line twin:** a command has no authenticated administrator,
    so its entries would say that nobody did it, which is what this exists to prevent; the routes are the operator's tool (`DEPLOY.md`
    gives the requests).
    **Retention:** a dead fact is a business fact that was not delivered, and it used to disappear after thirty days without anyone
    having decided it. `sweep:outbox` now keeps `dead` and `discarded` rows until `OUTBOX_DEAD_KEPT_DAYS` (180 unless set, 30 to 3650) after they
    ended, and counts them apart (`dead`, `discarded`) in the hourly log line of the job, the only place a CLI job reports; the gauge
    `purlay_outbox_dead` is unchanged. **Alert rules as code** (`docker/alerts/purlay-outbox.rules.yml`): dead above zero for fifteen minutes,
    the oldest pending fact past the overview's fifteen minutes (a warning) and an hour (a page), a backlog that keeps growing, a delivery
    failure rate, publishes refused by the backlog ceiling, requests refused for a grant, and the consumer's worker failing. A test parses the
    file and fails when it names a metric the code does not have, so renaming a metric breaks CI; the thresholds are in `DEPLOY.md`.
    The find's skipped sources have no metric yet (`MODULES.md` §10), so no rule is written for them.
13. **A row's producer is the type's owner** (an audit of 2026-11-08, red-team F9). `publishFact` checks who may publish a type, but a row
    written any other way (SQL of a module's own, a restored backup) was delivered on trust. The delivery now reads the row's `producer`
    and, when it is not the owner of the type's declaration, ends the row `dead` with `ProducerRefused` before its handler is asked:
    counted as any dead row is (`purlay_outbox_failures_total`) and said once at `error` with the producer and the owner, never the
    payload. The bound on a chain of facts is D-283's own, item 11.
14. **A delivery has its own deadline, and a full batch is followed by another** *(added 2026-11-08)*. The worker's deadline (a
    minute unless the manifest says) bounded the whole batch, so one handler that waited held the nineteen after it and, when it
    ran out, cut them all off with their tries spent. Each delivery now runs under its own deadline, `OUTBOX_ROW_DEADLINE_MS` (three
    seconds, so twenty slow rows still end with the worker's default minute): past it the delivery's signal aborts, what the handler
    asked of the database is cancelled and what it asks next is refused, so its transaction cannot commit and the row is not marked; the
    fact is counted as failed and waits for its backoff, its attempt having been counted at the claim (§4). The deadline does not
    release anything, since the claim holds nothing but the backoff: a fact that hangs every time costs three seconds of a worker eight
    times over about twenty minutes (the backoff of five seconds doubling), not a minute eight times, and is then `dead`. A handler that
    waits on something that is not the database and ignores the signal is not waited for, and still holds its connection until it
    returns. A delivery that throws outside its handler (a handler that swallowed a database error and returned leaves an aborted
    transaction) is `failed` too and is the only loss of the batch. And a drain that took a full batch is followed at once by another,
    up to ten drains or twenty seconds an iteration and never past the worker's deadline, where it was twenty facts for each two
    seconds, about ten a second, though the code does over a thousand; an idle module still claims once every two seconds. Exactly
    once for the database effects and at least once for the rest are as §5 says: the handler's effect and the mark are still one
    transaction.

**Rejected.** *Counting the attempt when the handler fails*

**Rejected.** *Counting the attempt when the handler fails*: a handler that hangs or kills its node is never counted and the fact is
tried for ever. *A lease column apart from `next_attempt_at`*: the backoff is a lease already, and a second clock would have to agree
with it. *Running the handler outside the delivery's transaction and marking after*: an effect with no mark is run twice, and a mark
with no effect loses the fact. *Writing `dead` for every first failure of a payload that does not fit*: that one is not going to
get better, and a retry only delays the line in the log. *Leaving rows of an earlier shape to nodes that can read them, without readers*: the node that wrote them stops when the deploy ends, so they would wait to expire; a reader is a few lines and loses nothing. *Validating every row against the newest schema*: a required field added is the very change that raises the shape, so it killed each row an older node had published (#1265). *Holding `uses` in the snapshot*: nobody is hurt by a question asked less.
*A global ceiling per producer now*: not measured (D-283 §2); the ceiling of §10 is per workspace and consumer because that is who is harmed. *Dropping or skipping a fact whose backlog is full*: the publisher would report a thing nobody was told, silently; the refusal ends its transaction instead. *A rate in facts a second*: it needs a window and a count shared by the nodes, and what hurts a neighbour is the depth, which one indexed count reads. *A window over every due row, ranked by workspace* (§11): the same answer in 830 ms on a million rows, every two seconds for every consumer of every node. *A fixed share of each batch for a workspace, then the rest oldest first*: with two heavy tenants the older one takes the whole remainder, which is the flood again. *Locking the candidate rows in the pick*: it locks every row it ranks (up to a batch for each of twenty workspaces) and writes to each, to use a twentieth of them. *A lock to make the ceiling exact*: every publish of a workspace would queue on one row, for a limit whose job is to stop a flood, not to be a count. *`LISTEN`/`NOTIFY` or Redis to wake a drain*: the poll is bounded and the correctness never rested on a wake-up.

**Cost of reversing.** One table of transient rows, which may be dropped once no fact is published, and a guard in `module-compat`,
which a dated exception lifts for a fact that is removed on purpose. The facts in flight at the moment of a drop are lost.
