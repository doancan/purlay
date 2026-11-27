# D-228. The whole suite runs two files at a time — amends D-220

**Decided (the owner, 2026-10-31).** `schema` was the pipeline's long pole: 742 s of a 12½-minute run on
2026-10-31, 686 s of it the one run of every test, file after file. D-220 kept the files sequential because Bun had
no parallel runner yet; Bun 1.4.4 has one, `--parallel=N`, which runs files in worker processes and implies
`--isolate`, so D-220's guarantee holds: each file has globals of its own.

- **`bun run test:all` passes `--isolate --parallel=2`** (`WORKERS` in `scripts/test-all.ts`). Measured on the same
  tree, coverage included: 256–269 s on six runs, two of them from no template at all as CI starts, against
  about 475 s sequential, every test passing; on CI `schema` took 460 s against 742.
- **Two, not one a core.** Four workers ran the suite in 148–155 s, but four files cloning the integration template
  at once wait on each other in PostgreSQL past the five seconds a hook is given, and the harness's own cost test
  failed with them. Two leave the database and Redis room on a four-core runner and failed nothing.
- **The coverage floor still holds.** Bun judges `bunfig.toml`'s per-file floor on the merged report: a run that
  passes every test but leaves a file under the floor still exits 1, checked in both modes before this change.
- **What running side by side exposed was fixed where it was, not waited out** (D-48: no floor, budget or rule
  moved):
  - a sidebar menu test read the menu one turn after the right click; Radix opens it a little later under load,
    so the first look in each case now waits for it;
  - the Redis bus tests published before every node's SUBSCRIBE had reached Redis, and Redis keeps nothing for a
    subscriber not there yet: nodes now trade probes in rounds until each hears every other;
  - the bus order walk and the reconnection walk, whose own waits allow ten seconds and whose reconnection doubles
    a 250 ms backoff, had the five seconds every test is given; they have thirty, with the reason beside them;
  - every worker runs the preload, so on a fresh database two built the integration template at once and one
    failed on a duplicate name, and a clone could start while another process was connected to the template:
    building and cloning now hold an advisory lock on the template's name (`testing.ts`, tested by building one
    new template twice at once);
  - four files that clone a database a test drop up to forty-six in one `afterAll`, which fitted a hook's five
    seconds only alone (#797): they have sixty, as migrate-on-start's cleanup already had;
  - Playwright reads the `JEST_WORKER_ID` each worker is given as being inside Jest and lists nothing, so the
    listing test leaves the worker's marks out of what Playwright inherits.
- `environment.test.ts` holds both flags and the number.

**Considered and rejected.** *One worker a core*: above. *Sharding `schema` over several runners* (`--shard`): the
per-file floor needs the merged report, and merging coverage across jobs is machinery this does not need while one
runner's cores are idle. *Running the integration files apart from the unit files*: the same merge problem.

**Revisited 2026-11-26 (#1576).** Four jobs can split test files by duration. The function coverage
check still needs each function's identity and whether any shard hit it. Bun 1.4.4 carries function
ranges and hit flags to the coordinator in `--parallel` mode. Its LCOV reporter writes function
totals `FNF` and `FNH` alongside line hits. The totals lose the overlap between shards.
[Bun 1.4.4 worker merge](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/sourcemap_jsc/CodeCoverage.rs#L245-L322) ·
[LCOV reporter](https://github.com/oven-sh/bun/blob/bun-v1.4.4/src/sourcemap_jsc/CodeCoverage.rs#L499-L526)

Measured with Bun 1.4.4 on macOS arm64. In a scratch directory, place both functions on one line
in `subject.ts` so the line hits cannot distinguish them.

```text
export function left() { return 1; } export function right() { return 1; }
```

`a.test.ts` imports and asserts `left() === 1`. `b.test.ts` asserts the same return value from
`left()` when `COVER_RIGHT=0` and from `right()` when `COVER_RIGHT=1`. Give both files one test.
Set `coverageThreshold = { lines = 0.96, functions = 0.95 }` under `[test]` in `bunfig.toml`, and put
only `[test]` in a separate `shard.bunfig.toml` so the shard can emit its report before the floor is judged.

```sh
for cover_right in 0 1; do
  for shard in 1 2; do
    COVER_RIGHT=$cover_right bun --config="$PWD/shard.bunfig.toml" test --isolate --parallel=2 \
      --shard="$shard/2" --coverage-reporter=lcov --coverage-dir="out-$cover_right-$shard"
  done
  COVER_RIGHT=$cover_right bun test --isolate --parallel=2 --coverage
done
cmp out-0-1/lcov.info out-1-1/lcov.info
cmp out-0-2/lcov.info out-1-2/lcov.info
```

Both comparisons succeeded. All four reports had `FNF:2`, `FNH:1` and `DA:1,1`. The complete runs
had 100% line coverage in both cases. When both tests called `left()`, Bun reported 50% function
coverage and exited 1. When they called different functions, it reported 100% and exited 0.
Consequently, any gate that uses only these reports must give the same verdict to a passing and a
failing run.

The inspector's `Profiler.takePreciseCoverage` did distinguish the two executed ranges in an
isolated worker. It also returned a top-level range for `subject.ts`, giving three entries where
the native gate counted two functions. An export of Bun's own merged function ranges would carry
the identity the current gate uses. An inspector-based export needs to establish parity with
Bun's source-map mapping and executable-function selection first. The existing `schema` job
continues to enforce both coverage floors until the sharded report can reproduce its verdict.

**Cost of reversing.** Drop `--parallel=…` and `WORKERS` from `scripts/test-all.ts` and their test; the test fixes
stay, being right either way.

**Amended 2026-11-26 (D-341): the one run of every test is no longer one job, and sharding by file is still rejected.**
`schema` is the long pole again, at 1,425 s for 30,222 tests on 2026-11-26 where this decision measured 460 s, and the
cores are not what it waits on. D-341 divides the run, but by area and not by file, for the reason given here and one
more that D-228 did not know: lcov from different processes cannot be added up, so a file is held to the floor in the
one process that ran its own area's tests. The two workers a process runs, and everything else here, stand.
