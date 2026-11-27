# D-203. The required `verify` check is a fail-closed verdict over the static checks and the one run of every test — amends D-47; closes #791

*Amended by D-226: `verify` judges the browser jobs too, and lets them skip only for a change they cannot see.*

**Context.** The `verify` job ran the unit tests alone (129 s of the 271 s job on run 40642437751, 2026-10-28), and
`schema` ran the same tests again, with the integration tests and coverage, 7 min 16 s. The first run proved nothing
the second did not, and paid for a runner to do it on every push. `schema` also started PostgreSQL and then Redis,
one after the other (20 s and 8 s). Branch protection requires a check named `verify` (and `schema`), and D-47's
promise — the merge is blocked unless the checks pass — rests on that name meaning what it says.

**Decided.**
1. **The job of steps becomes `static`**: every check that needs no service, unchanged, without the unit-only test
   step. **`schema` is the one run of the suite**, `test:all` with coverage, as before; its floors, discovery, budgets
   and timeout are untouched.
2. **`verify` is a job that needs `[static, schema]`, runs `if: always()`, and passes only when each succeeded**
   (`scripts/ci-gate.ts`, `bun run ci:gate`, reading `toJSON(needs)`). A failure, a cancellation, a skip, a missing
   result, a job the gate judges but was not handed, and a needed job the gate does not judge are each a refusal,
   naming the job. `always()` is load-bearing: a job whose dependency failed is skipped by default, and branch
   protection counts a skipped required check as passed. A test binds the job's `needs:` to the gate's list.
3. **The test services start together**, `bun run db:up:tests` (`docker compose up -d --wait postgres redis`), each
   waited on by its compose health check. `test:all` still refuses in CI when either is missing; that refusal now has
   tests of its own and mutations that prove they fail.
4. **What it saves is runner time, not the pipeline's length.** About two minutes of runner time a run (the 129 s step,
   less the gate job's few seconds, plus the overlapped service start); the run still ends when `schema` and the
   browser jobs do, and `verify` now reports after `schema` rather than beside it.

**Rejected.**
- *Keeping the unit run in `static` for a faster first signal.* It is the two-minute duplicate the change removes; a
  failing unit test still fails `schema`, and a developer has `bun run test` locally.
- *Making `static` and `schema` the required checks and dropping `verify`.* It changes the repository's protection
  rules outside the repository, and every workflow and document that names `verify` with it; the name stays, and
  means more.
- *Caching dependencies or the browser binary.* `bun install` took under five seconds, and Playwright advises against
  caching its browsers. A cache is a moving part for a saving nobody measured.

**Accepted.** The unit suite no longer runs in CI *without* services: `schema` sets `DATABASE_URL` and `REDIS_URL`
for the job, so a unit test that quietly needs a database passes there and fails on a developer's database-free
`bun run test`. That failure is loud, local and costs nothing in production; a guard against it would be the same
two-minute run this removes. `verify`'s job, its steps and the jobs it judges may not `continue-on-error`, which a
test holds.

`bun run check:cla` and `check:pr` (D-145, D-74) run in `static`, which `verify` requires, so "the `verify` job" in
those decisions still holds a merge.

**Research sources (2026-10-28).** [GitHub's dependency-caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
explains cache scoping and why cached contents must be treated as untrusted.
[Playwright's CI guidance](https://playwright.dev/docs/ci#caching-browsers) advises against caching
browser binaries: restoration can cost as much as downloading, and Linux system dependencies still
need installing. [GitHub's job-dependency guidance](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs)
explains why the final verdict needs `always()` after failed or skipped dependencies. These support
the choices above; they do not establish a measured reduction in the whole pipeline's duration.
