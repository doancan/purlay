# D-274. A module's scheduled job runs in its module's share of the pool, against a deadline of its manifest, with an error boundary of its own — builds on D-30, D-266, D-269, D-270; amends D-250 rule 7

**Context.** D-250 rule 7 gave a module's handlers and jobs an error boundary, and D-266 to D-270 built the share, the
deadline and the boundary for requests and frames only. `cli/jobs.ts` opened a pool of two and handed every job, a module's
included, the raw database: no share held its statements, nothing but the pool's thirty-second statement limit bounded its
time, and a throw was caught only because the runner happened to. The scheduler runs the jobs one after another, each as a
process of its own, so a job that hung on a lock held every job behind it for as long as the lock lasted; `jobs:status`
would call them overdue and nothing would say why.

**Decision.**

1. **A module's job is noted as its module's run**, as a request is: `scheduledJobRunner` (`modules/jobs/module-shares.ts`)
   makes the process's one database leased (`leasingExecutor`, `moduleConnections` from every bundled manifest, at
   `DATABASE_POOL_MAX`) and runs the work inside a request scope that names the module and carries an abort signal. The work is
   handed the leased database, as its only handle (`JobWorkOn`); the context a module's job is given is built on it
   (`contextOn`, `cli/jobs.ts`). Each connection it takes is asked of the module's share and held to its statement limit.
   The core's jobs are given the pool as it is, and the share of a module that declared `none` is none.
2. **A deadline per module's jobs, in the manifest.** `jobDeadline` is optional: `{ ms }` (1000 to 3 600 000: a job under a
   second is no job, and one over an hour is past the closest two slots of the plan) or `{ none: reason }`, which
   `module-deadlines.test.ts` lists as it lists a request's exemption (empty). A module that says nothing has ten minutes
   (`DEFAULT_JOB_DEADLINE_MS`): past what the nightly purge of the largest instance measured here needs (3 000 workspaces in
   about four seconds) with a wide margin, and well under a night. The deadline is a number of the manifest and not an
   environment variable, for D-270's reason.
3. **Past the deadline the work stops and the run is a failure.** The signal aborts, the lease asks the database to cancel the
   statement running (`pg_cancel_backend` from a connection of its own, D-270) and refuses the next, the runner stops
   waiting for work that waits on something that is not the database, and throws `JobDeadlineError`, which is recorded as any
   failure is: `job_runs.last_error`, `consecutive_failures + 1` (and so `purlay_job_consecutive_failures{job,module}`), a log
   line at `error` with the module.
4. **A failure of one run is that run's alone.** The runner answers `false` for a throw, a refusal of the share
   (`DATABASE_UNAVAILABLE`) and the deadline alike; the command exits non-zero for the scheduler, `jobs:first` goes on to the
   next job, and the connection and the slot are given back whatever the work did (the lease's own guarantee, D-270). The
   record of a run — the start, the end, the failure — is written on the pool as it is, outside the module's share and its
   signal, so a job cut off at its deadline can still be told as failed and a full share cannot stop its own failure being
   recorded.
5. **What is not bounded.** The core's own jobs: they stay on the core's connection and have no deadline, like the core's
   routes (D-270 §5), so a core job that hangs on the object store still holds the scheduler until the store gives up; the
   scheduler's own bound on a child process is the follow-up, and is not part of this change. A job's share is of one process:
   each job runs with a pool of two, so what the share adds there is the module's statement limit, the deadline and the
   boundary, not a count of connections — the pool's two were already all one job could take of the server's.

**Measured.** `purge:retention` (chat's, one statement group per workspace) over 3 000 workspaces with a retention, the
command run before and after on the same database, eight alternating runs each: durations 3 084 to 5 199 ms before (median
3 940) and 3 165 to 6 845 ms after (median 3 824), the spread being that of a shared machine; the fastest runs, which carry the
least noise, differ by 81 ms in 3 100. With an empty database the four jobs that were run (`sweep:sessions`, `purge:retention`,
`mail:missed`, `sweep:link-previews`, twelve runs each) took 201 to 243 ms before and 201 to 241 ms after, which is the
process starting.

**Rejected.** *A timer in the scheduler that kills a job's process*: it cancels nothing the database is running and leaves
a lock held until the server notices the dead connection; the deadline in the job is the same mechanism as a request's.
*Running the record of a run through the share too*: a job that filled its share could not record that it failed.
*A deadline for the core's jobs from a constant*: none of them is measured, and the module's is the manifest's by D-270 §1.
*An environment variable per module*: D-270 §1.

**Cost of reversing.** `jobDeadline` in the manifest and the registry, `scheduledJobRunner`, and `cli/jobs.ts` back to
`runJob` with the raw database. Nothing is stored.
