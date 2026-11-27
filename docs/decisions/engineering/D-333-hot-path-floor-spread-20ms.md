# D-333. A hot path timed with the others busy is allowed a floor spread of 20 ms, not 10 — amends D-267

**Context.** Pull request #1523 changed one sentence of `CONTRIBUTING.md` and failed `api-measurements`: issues' list with
chat busy was 29.9 ms against main's 18.9 ms from the same runner, past the limit of 28.9 ms. The same thing happened to #1437
(#1439). D-267 measured the spread of the lowest of three trials for chat's ACK, 7.2 ms over 80 runs, and gave every number the
10 ms that covers it; the metric added since, issues' list with chat busy, was judged by the same constant and never measured
the same way, because its trials were not kept until the noise file of D-267 was written (that file held eleven laptop runs, and
said they would be replaced once CI's artifacts had enough).

**Measured.** The 22 `api-latency` artifacts CI still keeps (2026-11-20 to 2026-11-24) hold 36 lowest-of-three values for this
path, main's and each candidate's: 15.1 to 35.8 ms, median 24.7, a spread of 20.7 ms. Compared in every ordered pair with
D-267's rule (the factor 1.5, the spread 10 ms, the 20 ms floor of interest), identical code failed 15.2% of the 1,260 pairs;
chat's ACK, from the same artifacts, 2.2%. Within one run, candidate minus main was between -8.0 and +11.3 ms over 14 runs,
with no sign of the second phase being slower (the median is +0.6 ms; 8 of 14 positive), so it is noise between runners, not
an effect of the order the two phases run in.

**Decision.** `LOADED_FLOOR_SPREAD_MS = 20` is the spread `limitOf` allows a hot path timed with the others busy; chat's
ACK and fan-out keep `FLOOR_SPREAD_MS = 10`. The factor, the floor of interest, the lowest-of-three statistic and the
second look (D-227) are unchanged. What the rule does is a test over those 36 values (`budget-latency-noise.test.ts`): identical
code fails a single look in 0.24% of pairs (3 of 1,260), a slowdown of 40 ms in every trial in 99.8%, and a tripling in 93%. The
two limits are proved by mutations (the spread forgotten on this path, the spread made 60 ms).

**What it cannot see, said plainly.** At a floor of 25 ms the limit is now 45 ms, so a slowdown of 20 ms in every trial is
caught in half of pairs (50%), and a doubling in 58%. A regression that small on this path is seen when it grows, or by the
second look and a later run, not by one comparison; no rule that passes identical code 99% of the time can do better on 36
values whose own floor spans 20 ms. The sample is small (five days, 22 artifacts, the rest had expired): when `api-latency`
artifacts have accumulated, `RECORDED_LOADED_FLOORS` is replaced by them and this number is read again.

**Rejected.** *Widening the factor:* it changes what a regression is (D-48) for every path, and the gain is where the spread,
not the factor, binds. *Judging against main's measurement from the same run only:* the pull request's own comparison already
does, and the failure above was that comparison. *More trials:* D-267's argument stands, the floor of a runner is not narrowed by
more of them. *Retrying until green:* D-49.

**Cost of reversing.** One constant, `LOADED_FLOOR_SPREAD_MS` in `budget-latency.ts`, and the noise file.
