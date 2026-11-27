# D-30. Background work runs as CLI commands under an external scheduler

**Amended 2026-10-28:** user-scheduled message delivery runs in each API process at 15-second intervals.
Database row claims with `SKIP LOCKED` prevent duplicate sends across nodes, and the live process publishes
through its normal backplane after commit. Shutdown drains the current transaction before closing the pool.
This exception covers user-timed actions; maintenance sweeps retain their external scheduler.
The delivery is chat's (D-250): only a process that runs chat starts it, its tables are in chat's migration set
(`chat/0002`–`0004`), and the files a scheduled message holds are reserved in chat's own
`scheduled_message_attachments` and claimed in the core's words (`claimed_at`), never by a column of `attachments`.

Three periodic jobs were promised and none had anything to run it: the orphan attachment sweeper
(`ARCHITECTURE.md` §9), the `link_previews` expiry sweep (D-23), and the `storage_used_bytes`
reconciliation (invariant I-7). D-27 adds a fourth, and session expiry a fifth.

**Decided: each job is a CLI command; scheduling is external.**

```
purlay sweep:orphans        purlay sweep:link-previews    purlay sweep:sessions
purlay reconcile:storage    purlay purge:retention        purlay export:workspace (D-140: an operator's command, not scheduled)
purlay sweep:github-deliveries   (D-134 §5)   purlay sweep:email-sign-ins   (D-138)
purlay mail:missed          (D-240: every quarter hour)
```

**Why not an in-process timer**, which would be the simpler answer at one node: under D-25's
ceiling every node would run every job, so the sweeper would race with itself and the
reconciliation would fight over the same counters. Moving jobs out of the API process makes them
multi-node-safe by construction rather than by a distributed lock nobody wants to debug.

**The known weakness of this choice is the forgotten cron**, and it is closed rather than
accepted: the scheduler ships wired in the `docker compose` file so the default deployment has
it running, and every run records its outcome in a small `job_runs` table so the admin view can
surface *last successful run* per job. A job whose absence is invisible is a job that will be
absent.

**Rejected:** a PostgreSQL-backed job queue. Durable retries and fan-out are real features and
none of these six jobs needs them — they are idempotent sweeps that are simply run again
tomorrow. `CONTRIBUTING.md` §1.11 forbids the infrastructure until a measurement forces it.

**Amended 2026-10-12 — a job is proven the day it is installed (#440).** The scheduler starts by
running `jobs:first`: once, each job that has never succeeded. Without it a new deployment's
`jobs:status` was red for up to a day, so a monitor alarmed on every install, and whether a job worked
there at all was known only the next night. A restart of a deployment whose jobs have all succeeded
once runs nothing more. Two cases do run a job twice in a row, and are accepted because every job is
an idempotent sweep: a first start just before a job's slot, and a job that has never succeeded,
tried again at each restart. *Rejected:* running
every job at each start, which repeats the nightly work on every restart; and running them from
`scripts/production-init.sh`, which may run before the API has migrated the database.
