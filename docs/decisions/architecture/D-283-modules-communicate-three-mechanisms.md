# D-283. Modules tell one another things through three mechanisms, one for each kind of interaction, over a contract the core holds — builds on D-35, D-250, D-254, D-255, D-265, D-272, D-273, D-281; amends D-250 §1 and rule 4, D-254 §1, D-255 §8 and D-272; `MODULES.md` §1, §2, §4, §7, §8, §10 and §12

*Amended by D-352: §1's hint uses the socket `EventBus` alone; the in-process `DomainBus` is removed.*

**Context.** Two modules run and neither can say anything to the other or to a person's inbox except through the core's
slots. `MODULES.md` §4 kept the means D-250 rule 4 promised (a fact with a durable row, ports for notifications and search,
a question whether a capability exists) as design intent, because nothing needed them (D-272). Issues now does: an
assignment is a thing the assignee should be told, and a workspace search that finds only messages leaves out the issues a
person was looking for. A third module will want the rest. Reading the code for this also found two sentences that
disagree: D-250 §1 puts notifications and the search fan-out in the core, and `MODULES.md` §1 and §10 step 5 give them to
chat (the `notifications` table has `message_id` and `channel_id` `NOT NULL`, and is chat's in `TABLE_OWNERS`). Issues is
the second writer that §10 step 5 said a generic inbox waits for.

**Decision.**

1. **Three mechanisms, and which interaction uses which.** The rule is the receiver's: what it must be told, and when.
   - *A read whose answer shapes the caller's request* (is this person in that channel, what does this source find for
     this query) is a **port call** with a deadline and an abort signal. A module that is off answers `undefined`, and the
     caller hides the feature or says `skipped`.
   - *A fact written to a row the core itself keeps, to a receiver that is always there* (an assignment notice in the
     inbox) is a **port call inside the caller's transaction** (`notify(transaction, …)`), announced after commit. The
     notice is atomic with the assignment: committed without it is a lost notice, rolled back with it a phantom. An
     outbox here would add a delay and a failure mode and no safety.
   - *An asynchronous effect on a receiver that may be absent or slow and needs its own transaction and its own after-commit
     step* is a **transactional outbox** in PostgreSQL: written in the producer's transaction, claimed and run by the
     consumer in its own.
   - *A hint* (a cache nudge, presence, "read again") may be lost and uses what exists, the in-process `DomainBus` or the
     socket `EventBus`. No module publishes one today and none is added.

2. **The outbox is for facts of human scale.** A fact names ids and a short label, never the state: the consumer reads
   the current state itself, and a design that needs order puts a `version` in the fact and discards the old. The rule of
   size: an assignment, a link, a status change, under about ten a second across the cluster; **a fact per message is
   forbidden** (chat's send path is one transaction already, D-35, and never uses it). Over that is measured and redesigned,
   not tuned. Semantics, each held by a test of the step that builds it:
   - **A row is one delivery**, one for each (fact, consumer): written at publish for every consumer the *build* carries, so
     every node of one version agrees on the list and there is no global offset to leave a gap (an id order is not the
     commit order). `UNIQUE (fact_id, consumer)`; a payload is at most 8 KiB and checked against the fact's schema at publish
     and again at delivery.
   - **Claim in two steps.** A short transaction takes due rows with `FOR UPDATE SKIP LOCKED`, adds one to `attempts` and
     pushes `next_attempt_at` out by the backoff, and commits. Then, for each row, the consumer's own transaction locks it,
     skips it if it is already delivered, runs the handler **in that transaction** and marks it delivered. A handler's
     database effects and the delivery mark are atomic; an effect outside the database is at least once, keyed by the
     fact's `fact_id`. A node that dies between the steps leaves a row that shows again at `next_attempt_at`. Counting the
     attempt at the claim is what lets a fact that hangs or kills its node reach the ceiling.
   - **Failure.** A handler runs under a savepoint; a throw rolls it back and records an error class (at most 300
     characters, never the payload); at eight attempts the row is `dead`, logged at `error` and counted. A payload that does
     not fit its schema at delivery is `dead` at once. Backoff is five seconds doubling to an hour, with jitter.
   - **No order, at least once.** A consumer is written for a fact it sees twice and out of order.
   - **The receiver is off.** Each fact type declares `absent`: `'drop'` writes no row when the consumer is not run by the
     publishing process (a count says so), `{ holdDays: n }` (14 at most) writes it and lets any node that runs the consumer
     drain it, expiring it after `n` days. A cluster of unlike module sets is the accepted *said, never acted on* state of
     D-255 §1, and a `drop` fact from a node without the consumer leaves nothing.
   - **Drained by a worker of the consumer's own** (D-281), `outbox:consume` of the consuming module, in its share, against
     its `workerDeadline`, counted in `purlay_worker_failures_total`, two seconds apart. No new timer, and no `LISTEN`.
   - **Rows are not forever.** Delivered and skipped rows go after a day, dead ones after thirty, expired ones when they
     expire, by a retention sweep of the core that runs in every process, in batches.

3. **The contract is the core's, and a module binds to it and not to another module.**
   - **Facts** are declared in `@purlay/types` (`FactDeclaration`, `defineFact`; `CORE_FACTS` and a list `<ID>_FACTS` for each
     module, as `ISSUES_AUDIT_ACTIONS` is), named `<owner>.<name>` with the owner `core` or a module id, each with a TypeBox
     schema and its `absent` policy. A test holds every name to its owner's prefix and to one owner.
   - **Ports** are interfaces in `apps/api/src/platform/ports/`: types and null objects only, pure as `module-kit` is, because
     they name an `Executor` and a fact schema cannot. Any module may import them; it already imports `platform`. The two
     that exist today (`WorkspaceChannels`, `PushNotices`) stay where they are.
   - **The manifest** gains three optional fields, each added in the step that reads it: `publishes` (the fact types the module
     owns), `consumes` (the fact types it handles) and `uses` (the capabilities it asks, which another module `provides`). The
     slot gains the other halves: `factConsumers` (one handler for each type in `consumes`) and one implementation for each
     capability in `provides`.
   - **The build refuses**, with every problem listed at once as `jobWork` does: a type published by two modules or by a module
     and the core; a name without its owner's prefix or not in `FACTS`; a type consumed that nothing in the build publishes; a
     consumed type with no handler and a handler for a type not consumed; a `uses` whose provider is neither required nor
     optional, or that nothing provides; a `provides` with no implementation and an implementation with no `provides`.
   - **No `register`, no `capabilities.has`.** Nothing is registered at run time: the running modules are known at start and the
     composition is made once. A module is handed a `ports` object whose members are the type of the port *or* `undefined`, so
     the compiler makes the caller handle the absence, and, once a module first reads one, a scan holds it to the ports its
     `uses` names.
   - **An optional partner does not become a requirement.** `uses` and `consumes` name a provider that is `optional`;
     `module-compat.test.ts` holds `publishes`, `consumes` and `uses` to the last release as it holds `provides`, so a
     published fact type that goes is a break that needs a dated exception.

4. **Two stores of notices, one search.** *Amends D-250 §1.* Chat's `notifications` stays chat's and unmoved: it is bound to a
   message and a channel, read with the channel's visibility, and counted by the channel's unread mentions, so making it
   general would be a risk with no gain to anyone. The core gets a table of its own, `inbox_entries`, for the notices of any
   module (`module`, `kind`, a subject type and id, a few short parameters, `read_at`), a service `modules/inbox/`, and a port
   `NotificationSink` through which a module writes one; the core reads it for the routes, the badge and the push. `kind` is
   text checked against the writing module's `notifications` manifest, not a database enum, because a core enum that every
   module's set alters is the thing `CORE_ENUMS_A_SET_CHANGES` exists to keep short. Only the rows of the modules that run are
   listed. A row for a person who is not a member, or who is the actor, is not written. The workspace search gains a core
   route `GET /api/workspaces/:workspaceId/find` that asks each running module's `SearchSource` at once, each as its own
   module (its share, an abort signal, 1.5 s; 3 s for the route), and answers **groups by source**, never one ranked list, since
   a score does not compare across sources and a cursor across several is a promise nobody keeps. A source that is slow or throws is
   `skipped` with `timeout` or `error`, and the others still answer. *(Amended 2026-11-07, D-285: the reason is `slow` and not
   `timeout`, and the route has no deadline of its own beyond the sources'.)* Chat's `GET …/search` stays as it is: it is the message
   screen's, with its filters and saved searches.

5. **The wire is not opened.** `Topic`, `ServerFrame` and `ClientFrame` keep their closed unions (D-250 open question b stands:
   no module has a frame of its own, D-273 declined a namespaced split, and the native client's behaviour on an unknown frame
   is unverified, #958). The one new frame is the core's, `INBOX_UPDATED`, on the person's topic as `DEEP_WORK_UPDATED` is.
   A fact never reaches a client; its effect does, through the channel that already carries it. The new endpoints are the
   core's (`inbox`, `inbox/read`, `find`) and the new types additive, so `CONTRACT_VERSION` does not move (D-190, D-273). The
   bundle's module structure gains `publishes`, `consumes` and `uses`, derived from the manifests.

6. **Tables and their lives.** Both are the core's in `TABLE_OWNERS`, in migrations of the core's set, new tables with their
   indexes made with them. `outbox`: `TABLE_LIFECYCLE` `anonymised`, `swept` (a payload holds ids and a label of at most 200
   characters and no person's name), left out of the workspace export as infrastructure with a reason, and in the purge's
   `tables`. `inbox_entries`: deleted with the person and swept (**read rows after 30 days, all after 180**, decided by the owner), in the
   purge's `tables`, in the person's own export and out of the workspace's, as personal and short-lived. A kind of notice a
   module is not run for stays in the table and is not shown, and the row's retention does not wait for the module.

7. **What holds each part.** One guard for each rule, each with a mutation (the names are the rows of `MODULES.md` §8 as each
   step builds them): the build's refusals of §3, a module reading a port it does not `use`, a module publishing a fact it
   does not own, a payload not checked at publish or at delivery, a module writing `outbox` or `inbox_entries` outside the
   core's own files (`core-tables.test.ts`), a publish on the pool and not in a transaction (a type), a consumer outside its
   module's share and deadline, an attempt not counted at the claim, a claim without `SKIP LOCKED`, a consumer that trusts
   the payload's workspace over the fact's, a dead row nobody sees (a gauge and a line in the operational problems of the
   server overview), a search source with no deadline and the sources of a module that is off asked, and a notice
   of an undeclared kind or for a non-member. A fake third module, `notes`, in the manner of `frame-handlers.test.ts`, is
   what proves the outbox: publish and deliver, the consumer off under each `absent`, a throw to `dead`, two nodes each row
   once, a node killed between the steps, a crash before the commit with the effect rolled back, a payload that does not fit,
   and a rolled-back producer leaving no fact.

8. **Decided by the owner.**
   1. **The outbox is built**, for facts of human scale only (§2).
   2. **A module's push respects Deep Work and quiet hours.** The notice row is always written; the push waits. Those columns
      (`users.quiet_*`, `workspace_members.deep_work_until`) then have a second reader, and by `MODULES.md` §5 leave
      `CORE_COLUMNS_FOR_A_MODULE` in the step that does it.
   3. **The inbox gets its own *Updates* section**, beside chat's list, not one merged timeline.
   4. **`inbox_entries` keeps read rows 30 days and every row 180.**
   5. **A search source of a module that is off is reported `skipped: off`**, which the signed-in session already says through
      `GET /api/me` and so adds nothing to D-255 §5's anonymous inference.
   6. **Issues' link to a channel is a product feature and is not part of this decision**: D-254 §1's "no link" stands, and with
      it a module's system message in a chat channel. The outbox's first consumer in production is therefore **deferred to
      the first feature that needs one**, and the outbox is proven by the fake third module's test and not by a real consumer.
      The consequence, stated plainly: **this ships infrastructure with no production consumer of the outbox**, against
      D-272 §1, which built things with the first module that needs them, and the owner chose that on purpose; it is a table, a
      worker for a module that consumes (none) and a sweep, kept honest by the tests above and by `purlay_outbox_pending`. The
      consumers that are real are the notification port (an assignment notice) and the search source (issues' and chat's).
      Until the first real publisher, the outbox is the part of this most likely to need change, and the decision for it
      is the owner's to revisit then.

   **This amends D-254 §1 and D-255 §8** only where the two things they list under "no notification, no search" are now
   decided: issues tells an assignee and is searched. Its other exclusions (comments, labels, attachments, frames, the link)
   stand, and each further one is a decision of its own.

9. **Rollout.** Fourteen steps (`MODULES.md` §10, step 14), each shipping alone and reverting alone: this decision; the
   manifest and contract skeleton, with no behaviour; the outbox table and publish; the drain worker; the sweep and the
   observation; the inbox table and sink; the inbox routes and frame; issues' assignment notice; the push; the web *Updates*
   section; the search route and chat's source; issues' source; the web's search groups; the close. Every migration adds a
   table, an index or a `NOT VALID` check, so a node of the release before ignores the new schema; a rollback is the backup's
   (D-86). In a cluster, a node claims only the consumers it knows and leaves other rows waiting, so a rolling deploy loses
   nothing. A payload changes only by adding; a break is a new type name. *(Amended D-288 §5: a change an older node would refuse raises
   the declaration's `shape` and keeps a reader for the old one, and `module-compat.test.ts` holds it; the type name stays.)*

10. **Not built, and what watches for it.** Each is a sentence until its watcher exists, as D-272 requires.
    - *`AttachmentOwner`*: when the first module that is not chat attaches a file (`CORE_WRITES` already names the seams).
    - *Mail for a module's notice*: when a kind is declared `mailed: true`; chat's missed-mail job is message-shaped.
    - *Opening the wire unions*: when a module has an operation of its own or live data. The watcher is a check in
      `core-claims.test.ts`, built in step 14n, that asks for a decision when a manifest fills `frames` or `events` with no
      opened union; until then it is this sentence.
    - *A wake-up for the drain* (a `DomainBus` hint to the local worker): when the measured delivery delay is a problem; the
      delay is two seconds and a run, and 14e reports it.
    - *Partitioning the outbox*: past a million rows a day or a vacuum that lags; watched by `n_dead_tup` of the table and a sentence in
      `DEPLOY.md`, both of step 14e.
    - *Requeueing a dead row by a command, a ceiling per producer*: when a dead row has to be retried by hand, or a producer is
      measured filling the table; for now a dead row is seen and not retried.
    - *`holdDays` in production*: no fact uses it; it is proven in the fake module only, and the first real use confirms it.
    - *Workspace-level enablement* (D-250 rule 9) is unchanged and still a precondition of a package.
11. **A worker and a consumer publish through the same seam, and a chain of facts is bounded.** `inWorkspace` hands a worker's visit,
    and `deliver` hands a consumer's handler, a `WorkspaceSeam { notify, publishFact }` over the transaction, bound to the module (a
    fact is published as the module whose loop this is, never one the caller names, and only a type it lists under `publishes`) and to
    the workspace the framework handed out (D-286 §13). A fact published from a delivery carries the fact it is a consequence of in
    `caused_by`, and `publishFact` refuses the fact that would be the ninth link of such a chain (`FACT_CHAIN_DEPTH_MAX`, a recursive
    read of `caused_by`, which a cycle cannot outrun): the delivery that would have made it fails and ends dead like any that cannot
    succeed, so two modules that answer each other stop within eight rounds and say so. The guard counts only through rows that still
    exist (a swept chain is a new one), which is the bound a loop needs and not an audit of history.

**Rejected.** *Only the in-process `DomainBus`, at most once*: a crash between commit and publish loses it, which D-35 warns
of, and a notice that can vanish is not a notice. *Everything through the outbox, notices included*: a delay and a failure mode
for a receiver that is the core and always there. *Everything as a port inside the producer's transaction*: the consumer's own
write path (its counters, its after-commit publish, its own off state) would run in the producer's share, a fault in it would
undo the producer's write, and a module could write another's tables. *A log with one offset for all consumers*: the gap an id
order leaves under concurrent commits, and a table of offsets and its logic; a row for each delivery is simple and right.
*`LISTEN/NOTIFY` or a Redis queue*: not durable, and correctness must not need Redis (§1.11). *Making chat's `notifications` the
general table*: foreign keys to messages and channels, a visibility join, a six-value enum and the badge's arithmetic, for
nothing a person would see. *Keeping a module's notices in the module's own table*: push, badge and Deep Work rewritten in each
(a third copy in the third module). *`register` and `capabilities.has`*: nothing registers at run time, and a typed `undefined`
does the same with a compiler's help. *One merged, scored search list*: scores do not compare across sources. *Facts or
ports kept in the modules' own folders*: that binds module to module, and the contract has to be where both can read it.
*Splitting `ServerFrame` by module*: D-273 declined it and nothing has asked since. *Building the issues-to-chat system
message now so the outbox has a consumer*: it is a product feature (the owner's decision 6), not infrastructure.

**Cost of reversing.** Documents and a small manifest type until step 14c. After it, the tables are the cost: `outbox` holds
only transient rows and may be dropped once no fact is published; `inbox_entries` holds people's notices and is dropped by an
operator as any module's tables are (D-250 rule 5). Chat's `notifications` is untouched throughout.
