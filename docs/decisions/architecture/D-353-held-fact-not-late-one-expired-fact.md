# D-353. A held fact is not a late one, an expired fact is counted, and a fact is granted where it is published — amends D-283 and D-288

**Decided (2026-11-27, an audit of the outbox before its first production use).** Five things the outbox said or did were not what an
operator or a module author could rely on. The age of the oldest pending fact (`purlay_outbox_oldest_age_seconds`, and the
administrator's `stuck` list) counted rows that wait on purpose: a workspace not granted the consumer (D-288 §11 leaves them untouched),
a consumer no node of the moment runs, a shape newer than the node reads (D-288 §5). So a grant taken away paged someone an hour later
(`PurlayOutboxOldestPendingPage`) for facts nothing was wrong with. `sweep:outbox` deleted pending rows past their expiry and said so only
in its own log line, in the scheduler's process, where nothing scrapes. Whether a fact was written for a consumer the workspace is not
granted depended on the node that published it: D-288 §2 skipped the row on a node that runs the consumer and wrote it on one that does
not, to be delivered if the grant came back, though the reason it gave for skipping (a grant given later is no reason to act on what was
said before it) holds on every node. A module could consume a fact of a module it did not name as a partner, which `uses` already
forbids for a capability, so no `degrades` sentence and no case of `degradation.test.ts` covered the edge. And D-283 §6's "a label of at
most 200 characters" was written and held by nothing: the fake modules of the tests declared a title of 9000.

**What changed.**

1. **Held is not late.** A pending row is *held* when its workspace is not granted the consumer, the node does not run the consumer or has
   stopped it, or its shape is newer than the node's declaration; `purlay_outbox_held{module,reason}` counts them (`not_granted`,
   `not_run`, `newer_shape`), and `purlay_outbox_oldest_age_seconds` and the overview's oldest wait are of the rows the node would claim
   (a row waiting out its backoff included: that one is late). Each node says what it can deliver, so the cluster's age is the `max`,
   the node that runs the consumer. A row past its expiry is neither. The `stuck` list leaves out a row of a consumer the build carries
   whose workspace is not granted it, and a row past its expiry, judged over the whole build so any node answers the same; it reads past
   held rows five pages at most and then answers short with a cursor. No page or warning rule names the held gauge.
2. **An expired fact is counted.** The sweep deletes an expired row and adds it to `outbox_expired` (`0134`, the core's: consumer, fact
   type, a count and when) in one statement, so a fact is counted exactly when it goes; every node reads the table for the counter
   `purlay_outbox_expired_total{module,fact}`, made at zero for each pair the manifests consume. `PurlayOutboxFactsExpired` warns on any
   increase in an hour, and `DEPLOY.md` says what to look at ("A fact expired undelivered").
3. **A fact is granted where it is published, the same on every node.** `publishFact` reads the workspace's grants and writes no row for a
   consumer that is not granted it, judged over every module the build carries (`Composition.grantedModules`: the grant and the closure
   of `requires`, not what this node runs, and not the administrator's stop, which holds a fact as a module that is not run does). A
   consumer granted and not run here is the `absent` policy's, as before. A row written while the grant held and left when it was taken
   away still waits for it, as D-288 §11 says.
4. **What a module consumes is of a partner it names.** The registry refuses a consumed type whose publisher is neither the module, nor
   in its `requires` or `optional`; a fact of the core needs none. The edge is then an optional partner like any other, with its
   `degrades` and its case.
5. **A fact's strings are labels.** `factOwnerProblems` refuses a string of a fact's schema, or of a shape it still reads, with no
   `maxLength` or one past 200 (`FACT_STRING_LENGTH_MAX`), unless its format bounds it (`uuid`, `date-time`) or it is a literal; and
   `compose` runs `factOwnerProblems`, so the declarations' rules stop the build where D-283 §3 says they do, and not only CI (all but
   whether an owner is a module of the build, which a composition of some of the modules cannot judge and `fact-owners.test.ts` holds).

A module's handler is written with `consumerOf(FACT, handler)`, which hands it the payload typed by the declaration; `publishAndDeliver`
(`testing/fact-delivery.ts`) publishes and delivers one in a module's own integration test, and `module:new` makes `facts.ts` and the
manifest's empty `publishes` and `consumes`. None of these changes a rule.

**Rejected.** *Counting expired facts in a counter of the sweep's process:* the job is a process of its own that ends, and nothing
scrapes it (`modules/jobs/metrics.ts` says the same of the jobs). *Keeping expired rows as a state to count:* their payloads would stay
180 days, and a module the operator does not run would fill the dead list. *A gauge of rows past their expiry and not yet swept:* it is
there for at most an hour and then says nothing happened. *The age over every pending row, with the held ones subtracted by the alert:*
the alert cannot know a grant. *Judging the `stuck` list by what the answering node runs:* two administrators on two nodes would see two
lists. *Writing the row for a consumer not granted and holding it for a grant to come:* acting later on what was said before the grant is
the fault D-288 §2 named. *Asking the grant only on the node that runs the consumer:* the outcome of a publish would be the load
balancer's choice. *Checking string length at publish only:* the payload is refused at run time, in a person's request, for what the
declaration said at build time.

**Cost of reversing.** Code and documents, and one table of a row for each consumer and fact type: drop it and give the sweep back its
plain delete. Facts not written for a workspace without the grant are not written; reversing 3 does not bring them back.
