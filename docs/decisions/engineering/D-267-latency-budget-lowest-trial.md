# D-267. The latency budget judges the lowest of its trials, with the spread of the floor allowed for — amends D-49, D-227

*Amended by D-333: a hot path timed with the others busy is allowed a wider spread of the floor, 20 ms.*

**Context.** The gate in CI's `schema` job failed on a first attempt and passed on a rerun, on pull requests that changed no
production code: an ACK p95 of 30.7 and 32.6 ms against a recorded 16.4 to 17.7 ms. It judged the median of three trial p95s
against the median the last main run kept, at 1.5 times and a 20 ms floor. A trial's p95 is the 57th of sixty sorted
samples, so one stall moves it by tens of milliseconds. The 80 runs CI had kept as artifacts (240 trials, ACK p95) ran from
9.8 to 70.5 ms: median 15.9, 90th percentile 20.4, 99th 65.7. Two runs of identical code, compared by that rule in every
pairing of those 80, failed 4.7% of the time, which is the flake. (A local comparison of 16 interleaved runs of main and a
candidate gave the same picture: medians 47.5 and 46.7 ms, main's trials from 19 to 99 ms.)

**Decision.**
1. **The lowest of the three trials is judged, per metric.** A stall only adds to a trial; a real slowdown raises every
   trial and so the lowest. The lowest of three across the 80 recorded runs lies between 9.8 and 17.0 ms, so the noise a
   stall makes is gone and what is left is one runner's floor against another's. `--record` and `--keep` still keep
   every trial beside the summary; a baseline written by the previous rule (a median) is still read, and is only a few
   milliseconds higher.
2. **The limit is the most of three:** the recorded number times `REGRESSION_FACTOR` (1.5), the recorded number plus
   `FLOOR_SPREAD_MS` (10), and the 20 ms floor of interest. The 10 ms is the 7.2 ms spread of the floor above, with room.
   Nothing else changed: the factor and floor are D-49's and the second look is D-227's, once, never a loop.
3. **The output says how noisy it was:** each number is printed beside its limit, and one line gives the range of the
   trials' p95s, so a failure on a noisy machine and one on a slowdown no longer read the same.
4. **What the rule does is a test, not an opinion** (`budget-latency-noise.test.ts`, over `budget-latency-noise.ts`, the
   80 runs): over 20,000 seeded pairs, identical code passes in over 99% (every one of the 6,400 exact pairs of runs: 99.86%), a
   slowdown of 20 ms in every trial fails in over 99% (99.8%) and a tripling in over 99% (99.95%). The limits are
   proved by mutations: the worst trial taken, the spread forgotten, the spread made 40 ms, the factor dropped.

**What it cannot see, said plainly.** At CI's 16 ms floor, a half as much again is 8 ms, which is the spread of the
floor itself: that is caught in about a quarter of pairs (doubling, 16 ms, in 83%; +15 ms in 95%). No rule that passes
identical code 99% of the time separates a runner that is 8 ms quicker from a change that costs 8 ms. Where the baseline is
larger (a slower runner, a local machine) the factor is what binds and a half as much again fails. A slowdown that is
only in some of the trials is a stall by this rule; one in a twentieth of messages or more raises the p95 of every trial.

**Rejected.** *Widening the factor*: it loosens what a regression is (D-48) and still fails on the quiet runs it was widened
for. *More trials*: a stall in a trial is already gone with the lowest of three (no run of the 80 had a lowest trial above
17.0 ms), and what is left is the runners' own spread, which more trials do not narrow; they cost every run. *A history of
runs as the baseline*: it narrows the baseline's own spread, but on the same 80 runs, at an 8 ms margin, it moved false
failures from 0.6% to 0.3%, for a file that has to be migrated. *Retrying until green*: D-49.

**Cost of reversing.** One statistic and one constant in `budget-latency.ts`; the files kept are the same shape.
