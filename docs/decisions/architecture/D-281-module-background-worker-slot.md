# D-281. A module's background loop is a worker of its slot: its module's share, a deadline of its manifest and an error boundary of its own — builds on D-250, D-266, D-270, D-274; amends `MODULES.md` §7 and §9

**Context.** D-250 started chat's delivery of scheduled messages and reminders from `index.ts` by hand (`startWhereRunning`),
and D-266 to D-274 held a module's requests, frames and scheduled jobs to a share of the pool, a deadline and an error
boundary. The two timers were the one place a module's work still took the raw database: no share, no deadline, a failure
counted nowhere (the loop logged and tried again), and `index.ts` was not a door `module-seams.test.ts` read, so nothing held
it to naming no module's work. A delivery that hung on a lock held its loop for good and its connection with it, unseen.

**Decision.**

1. **A module declares `workers` on its slot** (`BundledModule.workers`: `name`, `intervalMs`, `work`), as it declares `jobWork`
   and `frameHandlers`. The name is lowercase words joined by colons (`deliver:scheduled`) and is the module's alone; the
   interval is a whole number of milliseconds from a second to an hour, between the end of one iteration and the start of the
   next. `compose` stops a build with a repeated or malformed name or an interval outside that, and lists the workers of the
   modules this process runs, and of no module that is off (`Composition.workers`): a module that is off may have no tables,
   which is why D-250 started chat's timers only where it runs. Chat declares `deliver:scheduled` and `deliver:reminders`, every
   15 seconds as before, in `features/chat/workers.ts`; the loop that was `features/chat/scheduled/loop.ts` is `startWorkers`
   (`modules/workers/module-workers.ts`), and `index.ts` starts what the composition lists and names no module's delivery.
2. **Each iteration runs as the module's own.** It is run in a request scope that names the module and carries an abort signal,
   and the work is handed the module's leased database as its only handle (`WorkerContext`, with the clock, the bus and
   push). The lease is the one the application's requests take: `index.ts` makes one `moduleConnections` from the manifests and
   hands it to `createApp` (`moduleShares`, which `createApp` makes for itself when none is given) and, as a `leasingExecutor`, to
   the workers, so a module's loop and its requests hold the same slots and together no more than its share.
3. **A deadline in the manifest, of its own.** `workerDeadline` is optional: `{ ms }` (1000 to 3 600 000) or `{ none: reason }`,
   which `module-deadlines.test.ts` lists (empty). A minute when left out (`DEFAULT_WORKER_DEADLINE_MS`): past the pool's wait
   and a batch of a hundred deliveries, under the pool's own thirty-second statement limit twice over, and a fraction of the
   hours a job may take. It is not `jobDeadline`: that bounds chat's retention purge, which may run for minutes, and a loop
   that comes every fifteen seconds is not to wait as long as a purge. Past it the signal aborts, the lease cancels the
   statement running (`pg_cancel_backend`, D-270) and refuses the next.
4. **A failure is the iteration's alone and is counted.** A throw, a refusal of the share and a missed deadline alike are
   logged at `error` with the module and the worker, counted in `purlay_worker_failures_total{module,worker}`, and the next
   iteration comes at its interval; the process goes on. Both labels come from the manifests and slots (a series for each
   worker the build carries, made at zero), so the set is closed. There is no gauge of consecutive failures: a worker writes no
   `job_runs` row, and a rate over the counter says it. One flight a worker: iterations never overlap, and a stuck worker does
   not hold another.
5. **The process entry is a door.** `module-seams.test.ts` reads `index.ts` as it reads `cli/`, `ingress/` and `realtime/`, with
   nothing listed for it, and holds it to the workers it starts, over the leased database and the application's shares, stopped
   on a crash and on a shutdown. The stop handle exists before boot awaits migrations or settings; an early stop
   succeeds with no workers yet and prevents them from starting if boot later resumes. Real-process SIGTERM and SIGINT
   cases in `migrate-on-start.integration.test.ts` hold the early shutdown to a clean exit.

**Measured.** The delivery tests of scheduled messages and reminders are unchanged and pass, and a worker of chat delivers a
due message through chat's share on a real database (`module-workers.integration.test.ts`). What the scheduler adds to an
iteration is an abort controller, a timer cleared at its end, a request scope and, with the lease, a slot taken and given back:
about two microseconds an iteration with none of it contended (20 000 iterations of an empty worker, two runs), against the
two statements each delivery has always made every 15 seconds on every node. The idle cost of a node is the same two
transactions and two timers; the iterations of the two loops were one flight and are now two, which changes when they run
relative to one another by no more than a statement.

**Rejected.** *Reusing `jobDeadline`*: see §3. *A gauge in `job_runs` for a worker*: the table is the scheduler's record of
processes that start and end; a loop that never ends has no run to record, and a counter is what `rate()` reads. *A manifest
field naming each worker's interval*: one declaration is the slot's, and an interval is the work's own business, not a fact a
reader of the manifest needs. *A second set of slots for the workers*: a module would then have twice its share. *A generic
scheduler for core timers*: the core has none; YAGNI.

**Cost of reversing.** `workers` on the slot, `workerDeadline` in the manifest and the registry, `startWorkers`, the counter, and
`index.ts` back to a loop of chat's own over the raw database. Nothing is stored.
