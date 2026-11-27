# D-227. A budget regression is measured alone, and must happen twice — amends D-49

*Amended by D-267: The latency budget judges the lowest of its trials, with the spread of the floor allowed for.*

**Decided (the owner, 2026-10-31).** Since D-226 the browser jobs are part of the required verdict, so a noisy
budget now blocks a merge, and both noisy budgets were failing on noise. On main, identical code measured the
browser's cold load anywhere from 86 to 178 ms across runs, and a re-run of a failed job on the same commit gave
110.9 ms and passed; the API's fan-out p95 failed at 23.6 ms against 15.6 ms on a change that touched only the
client's search. Two causes, two fixes:

- **The browser measurements are taken alone.** `performance.e2e.ts` and `feed-scale.e2e.ts` — the files that
  write what `budget:browser` judges — ran inside the fully parallel suite, so another test's worker competed for
  the runner's two cores while they measured. `PURLAY_E2E_PERFORMANCE` (`playwright.config.ts`) now takes `skip`
  (every other file) or `only` (those two); unset, everything runs as before, and any other value refuses to run.
  Each project is two jobs side by side (`matrix.part`): the suite with `skip`, and on a runner of its own the
  measurements with `only` on one worker, then the budget. Only the measuring part reads, judges and keeps it.
- **A regression must happen twice.** A real slowdown shows again on an immediate re-measurement; a runner's bad
  minute does not. `budget:browser -- --remeasure` (CI passes it) measures a regression again — the measuring
  tests alone, one worker — and fails only if that regresses too; measuring again that exits non-zero or measures
  nothing is a failure, never a pass, and the first run's files are removed first so they cannot be read twice.
  `budget:latency` runs three more trials after a regression and judges them the same way. Each says both
  judgements ("first measurement regressed; measured again…"). Only a passing run is kept — the second, when the
  first regressed; `--record` keeps the run judged last, so the record and the verdict are the same measurement.
  An interrupted trial is still an error, in either set.
- **The budgets are not loosened** (D-48): the factor (1.5×, 2× under three runs), the 20 ms floor, the five-run
  history and the lines the tests hold on a developer's machine are unchanged. A regression that repeats fails as
  before; nothing is adopted that did not pass. This is not D-49's "retry until a pass": there is one more
  measurement, never a loop, and both are printed.
- **The cost is runner minutes, not the run's length.** The measurements run beside the suite on a runner of their
  own: alone, on one worker, a wide project's took 3.6 minutes on a laptop (the two-thousand-message channel is 3.1
  of them; the narrow projects do not run it), under the suite's own length, and the suite no longer carries them.
  Four more runners a run, and a regression spends its part's minutes again; the 20-minute ceiling has room for both.

**Considered and rejected.** *Widening the factor* — it would let a real 2× slowdown through to stop noise that a
quieter measurement removes at its source. *More samples per run only* — the cold load is already a median of five
and the latency a median of three processes; a bad minute on the runner moves every sample in it together, and
more of them cost every run, where measuring again costs only a run that regressed. *Dropping the gate, or taking
the browser jobs back out of `verify`* — D-49 and D-226: a budget nobody enforces is a hope. *Measuring every run
twice* — it doubles the minutes of every run to settle the few that regressed. *Measuring after the suite, in the same job* — quiet,
but it lengthened every wide project's job by the measurements' minutes. *Measuring again until a pass* — D-49's
re-run habit, automated: with enough tries noise passes anything. One more measurement, after a regression only, is
the bound: a slowdown real enough to repeat still fails.

**Cost of reversing.** The switch in `playwright.config.ts`, the second test step and `--remeasure` in `ci.yml`,
the re-measure in both commands, and their tests and mutations. Reversed, the measurements share the runner again
and a noisy run blocks a merge until somebody re-runs it.
