# D-260. A module's pool budget and its retention jobs are manifest fields, so a third module cannot be wired by hand and forgotten — builds on D-30, D-250, D-254, D-255

**Context.** Two modules run, and two things about each were wired by hand outside it: the share of the connection pool
(D-255 §9) was handed to the issues routes by name in `createApp`, and chat's retention purge and sweeps were imported
by name into the job command (`cli/jobs.ts`), as were its missed mail and its content-erasure command. A third module
would have had to be added to both by someone who remembered, and the failure of forgetting is silent: an unbudgeted
module can hold the pool, and a purge nobody runs lets rows outlive their retention. D-250 rule 7 says isolation is
built before a module ships; nothing said how a module is made to say what it takes.

**Decision.**

1. **`budget` is a required field of the manifest.** Either `{ poolShare: (poolMax) => limits }` (a cap on the open
   transactions *(amended D-266: on the requests holding a connection)*, a queue timeout and a statement limit, worked out from the pool the process has) or `{ none: reason }`:
   leaving the share out is a decision with a sentence. A manifest without it does not compile, and the registry refuses
   one that does not have it at run time (a manifest that is data), a `none` with no reason, and a share that leaves a
   module no connection or the others none, tried against pools from one to a hundred. Chat declares `none` and why *(amended D-269: chat declares a share now)*;
   issues declares its third of the pool. `createApp` applies each module's declaration to its routes through one
   function (`transactionsOfModules`) that names no module.
2. **`retention` is a field of the manifest, beside `jobs`, and the work comes with the module.** `jobs` are the scheduled
   jobs that act for the module's users and wait for it to run; `retention` are the ones that keep its rows within their
   retention and run in every process, because the rows are there (D-255 §3). The module supplies the work of each
   (`BundledModule.jobWork`), a build whose names and work differ does not start, the job command takes the work from the
   composition and names no module, and a retention job is a job for the overlap check of the registry. The link-preview
   and delivery sweeps and the retention purge, which were listed among the core's jobs while chat's code, are chat's
   `retention`.
3. **The doors name a module only where its routes are.** `cli/` imports no feature, and `ingress/` only the files listed
   for the feature they serve and the composition root, `ingress/http/app.ts`; the list only shrinks
   (`module-seams.test.ts`). The lint cannot say it, because chat's own route handlers live in `ingress/` (`MODULES.md` §9).

**Rejected.** *A budget as a number of connections*: a pool's size is a deployment's setting, and issues' share is a
fraction of it. *The work inside the manifest*: the manifest is data, snapshotted and compared with the last release's
(D-255 §7); a function in it would make that comparison depend on what a function does. *Making `retention` required*: a
module with no job of that kind would carry an empty list to satisfy a type; the build's check that every named job has
work, and every job's work is named, is the one that can be forgotten, and it cannot. *Moving chat's route handlers out
of `ingress/`*: the route table is one typed chain whose type the web client reads (D-255 §2).

**Cost of reversing.** Two fields of the manifest and the code that reads them; chat's jobs return to the job command's
list. Nothing is stored.
