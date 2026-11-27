# D-341. The suite runs as three areas, side by side, and each file is held to the floor in the process of its own area — amends D-228

**Decided (the owner, 2026-11-26).** `schema` was the long pole of every pull request again: 1,425 s for 30,222 tests in
1,081 files on 2026-11-26, in a run that took 17 minutes from the push, with 15 s of setup and 2–12 s of queue around
it. D-228 measured 460 s on 2026-10-31 and rejected sharding because the per-file coverage floor needs the merged
report. The suite has grown to three times that, and the merge turned out to be impossible, not only costly.

**What was measured.**

- *The cost* (from the CI log of one `schema` run, each file's span summed): `apps/api` integration 424 files, 62.6 %;
  `apps/web` 303 files, 29.4 %; everything else 8 %. The tail is flat: the five costliest files are 17 % of the time,
  the hundred costliest 64 %, so mending a few files leaves the run where it is.
- *Coverage cannot be added up across processes.* Bun's lcov says per file how many functions it has (`FNF`) and how
  many ran (`FNH`), and no record says which: not in Bun 1.4.3, not in 1.4.4. `packages/db/src/client.ts` is 27 of 28
  functions in the whole run and 22, 23, 24 and 22 in four balanced parts. Nor do the lines add up: what a process counts
  as found depends on what it ran, so the lines of four parts summed give a different verdict from the whole run for 223
  of 1,149 files, and the lower bound on functions a different one for 461. Merging was tried and is rejected, not
  deferred.
- *The floor binds.* In the whole run the lowest file is at exactly 95.00 % of functions.
- *Run by area, each in one process where Bun merges its own workers, every file of an area meets the floor on that
  area's tests*, but for `packages/markdown/src/engine.ts` and `formatting.ts`, which passed only because the web
  tests and the API tests both reached them. They are tested by the package now (`engine.test.ts`,
  `formatting.test.ts`): `endsInOpenCode` and the ranges the writing controls mark were exercised by the web editor
  alone, and both files are at 100 % on the package's own tests.

**The layout, three jobs of `schema-area`**, each `PURLAY_TEST_AREA=<name> bun run test:all`, measured on one machine
with nothing else running through the same command:

| Area | Tests it runs | Services | Files | Tests | Time |
|---|---|---|---|---|---|
| `web` | `apps/web` | none | 304 | 11,988 | 98 s |
| `scripts` | `scripts` | PostgreSQL, Redis | 66 | 8,892 | 143 s |
| `api` | `apps/api` and `packages` | PostgreSQL, Redis | 714 | 9,474 | 406 s |

`packages` is run with the API and not with `scripts` because that is what makes the floor hold: alone, seven files of the
shared packages are under it (they are exercised by the API's tests as they are used), and with the API only the two
Markdown files were, which are tested now. The critical path is the `api` job, about half of the single run on the same
machine; the speed-up on CI is not yet measured.

**The floor, judged by `scripts/coverage-floor.ts`, which `schema` runs after downloading the three areas.** An area runs
under a copy of `bunfig.toml` with the floor at zero, made from the real file so that nothing else about it can drift,
because its process also loads files of other areas and Bun would hold those to the floor on the wrong tests. The real
floor, read from the same line (96 % of lines, 95 % of functions), is then applied to each file in the process of the
area that owns it (`apps/web` to `web`, `apps/api` and `packages` to `api`, `scripts` to `scripts`), each file by
itself as Bun does; a file that belongs to no area (a root file, a copy a test makes in a temporary directory) is
judged in the process that loaded it. The check also refuses:

- an area that did not run exactly the test files it owns (what `bun test` prints as "across N files" against the files
  on disk), a test file that belongs to no area, and an area that exited non-zero;
- a source file that an area loaded and its owner did not, which would otherwise be judged nowhere.

`schema` keeps its name and its meaning, because branch protection requires `schema` and `verify`: it runs whatever
became of the areas, so that an area that failed or never ran is a refusal that names it, and it is skipped for exactly
the reasons the whole was (D-332). `verify` needs `schema-area` as well (it is in `GATED`, with the same reasons to
skip), and `scripts/ci-scope.ts` is unchanged: it asks whether `schema` ran, and `schema` succeeds only if every
area did. The `web` job starts no service and is given no database.

**What this changes in the gate, and it is stricter.** A file's coverage counts only from its own area's tests, where it
counted from every test before: a new file of `apps/web` that only an API test happens to import is refused until the web
has tests of it, and so is a file that only another area loads. No floor moved.

**Considered and rejected.** *Merging the parts' lcov*: above. *Running the tests in parts without coverage on a pull
request and holding the floor only on main*: it would be about five minutes, but a change that breaks the floor
would reach main before it was refused. *Lowering the floor*, or counting what a file's coverage "probably" is (D-48).
*A larger, paid runner*: the minutes are free here and the cores are not what the run waits on. *Postgres without
fsync on a tmpfs*: six heavy integration files took 52.6 s and 52.9 s against 50.0 s and 49.2 s, about 6 %, so durability is
not what the tests wait on. *Dividing by file* (`bun test --shard`, balanced by durations): sound as a partition and
useless for coverage, for the reason above. *One job with more workers*: D-228's contention.

**Cost.** Three runners' minutes in place of one (the repository is public, so none is charged) and about a minute of
setup three times over. Two files had to be tested by their own package. A new file is judged by its own area's tests.

**Cost of reversing.** Replace `schema-area` and `schema` in `ci.yml` by the one job they were (the services, `db:check` and
`bun run test:all`), and remove `PURLAY_TEST_AREA` from `scripts/test-all.ts`, `scripts/test-area.ts` and
`scripts/coverage-floor.ts` with their tests; `verify`, `GATED` and branch protection need nothing, because `schema`
and `verify` keep their names. The Markdown tests are right either way.
