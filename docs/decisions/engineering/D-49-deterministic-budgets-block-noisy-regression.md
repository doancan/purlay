# D-49. Deterministic budgets block; noisy ones block on regression

*Amended by D-196: The initial JavaScript is a backstop, not a ceiling for features.*

*Amended by D-227: A budget regression is measured alone, and must happen twice.*

*Amended by D-267: The latency budget judges the lowest of its trials, with the spread of the floor allowed for.*

`PRD.md` §5 lists seven performance budgets and calls every one CI-enforceable. **None was being
measured.** That is precisely the failure D-17 was written to prevent, reproduced by the document
that contains D-17.

They do not all have the same measurement maturity, and treating them identically is how the whole
gate loses credibility.

**Blocking, measured on every pull request:**

| Budget | Why it can block |
|---|---|
| Initial JS bundle, gzipped < 250 KB | A single deterministic number from a build. It does not vary between runs. |
| API idle RSS < 120 MB | Measured by starting the process and reading it. Stable enough to threshold. *Since 2026-10-12, `bun run budget:api` (#73): 80.6 MiB on its first run.* |

*Amended 2026-11-13 (the API runtime):* every API launcher, including the production image,
development, demo, restore rehearsal and budget processes, uses Bun's default heap policy.
The real memory and latency measurements run independently of the coverage suite, and remain
required by CI. Pull requests measure their actual main base and proposed code sequentially on
the same runner, using separate checkouts and pinned dependencies; both raw measurements are kept.
Pushes on main retain the cached previous passing baseline. The 120 MiB RSS limit and latency
regression bounds are unchanged; no forced collection or measurement-only runtime flag is added.

**Blocking on regression, not on an absolute threshold:** ACK round-trip p95, fan-out p95, cold
load, channel switch, keystroke→paint. Each is recorded per commit and compared with the previous
measurement; a **jump** fails, a number near the line does not. *Since 2026-10-12 the first two are
`bun run budget:latency` (#73): 19.7 ms and 19.7 ms on its first run against budgets of 120 and 200; a
jump is more than 1.5× the recorded p95 and past 20 ms. CI judges every run against the last
measurement main kept (`actions/cache`, written only by a passing run on main, so a regression that
lands there fails and is not adopted as the baseline).*
*Since 2026-10-21 the other three are `bun run budget:browser` (#727), per browser project, by the same
rule, on each run's median — five cold loads, twenty keystrokes, twenty switches: judged on a p95, a
documents-only change failed on one stall. Until then the browser tests held them to the line on the runner too, where the channel switch
measured 120–170 ms against a laptop's 33; there they are now judged on a jump, and the tests keep the
line on a developer's machine.*

**Why not threshold everything.** A p95 latency measured on a shared CI runner moves by tens of
percent between identical runs. Make that blocking and within two weeks the team is saying "flaky,
re-run it" — and that habit does not stay confined to one check. It spreads to the whole gate, and
then nothing is enforced. **A gate people learn to re-run has already stopped being a gate.**

**The bundle budget is the urgent one and it is architectural.** The markdown renderer, the
syntax highlighter and the i18n approach are all still unchosen (D-36, D-41), and 250 KB is the
constraint that decides them. Measuring after they are wired in is sitting the exam with the
answers already written.

**This is also the honest answer to why the incumbent is heavy.** Slack is not slow because of how
it renders; it is slow because of how much it ships and how much it holds. The remedy is these two
numbers, enforced from the first build — not a different rendering architecture (D-50).

*Amended 2026-10-26 (browser budgets):* "a regression against main's last run" meant one run, and one run is not what is
normal: the channel switch measured 58 ms in one run of main and 107 in the next, identical, so a lucky run kept as the
baseline failed the browser job of every change after it — a change to the API included — until somebody re-ran it, which is
the gate D-49 says people learn to ignore. The kept file is now the last five runs that passed, and a regression is a
jump past 1.5 times the *slowest* of them: the same code measured 58, 72 and 124 ms on one kind of runner, so the spread
is the envelope (a first version judged against the middle and still failed at 109 ms against 72). While there are
fewer than three runs to see a spread in, the factor is 2. A regression is still never
adopted, and the line itself is still held where it means something, by the tests on a developer's machine.

*Amended 2026-10-28 (API latency trials):* [main run 40662081925](https://github.com/purlay/purlay/actions/runs/40662081925)
reported ACK and fan-out p95 of 57.3 ms against a 14.8 ms baseline, after a CI-only change with no
API or database runtime diff. Three unchanged local runs measured ACK p95 of 24.01, 23.56 and
23.98 ms; they did **not** reproduce the hosted slowdown or prove its cause. The old log held only
one p95 per metric, so it could not distinguish a single disturbed run from sustained slowness.
[The next main run, 40666696134](https://github.com/purlay/purlay/actions/runs/40666696134), passed
at 14.4 ms ACK and 14.0 ms fan-out against the same 14.8 ms baseline, with no message-path change.
That supports run-to-run variability rather than a persistent code regression; it does not identify
the hosted disturbance's cause.

The command now always measures **three independent API processes sequentially**, each with sixty
messages at the same pace, and compares the **median of their p95s per metric**. This is not a pooled
percentile of 180 messages. Every trial is printed and saved alongside the summary. One isolated
slow trial does not decide the verdict; a sustained slowdown in two or three trials still fails
against the unchanged **1.5× factor and 20 ms floor**. Trials are neither retried until green nor
discarded on failure: an interrupted or incomplete measurement fails the command. Existing flat
baseline files remain readable and are compared, rather than reset. Only a passing summary replaces
`--keep`; CI separately records the current summary and trials, even on regression, in a seven-day
artifact. The cost is roughly sixteen more seconds per budget invocation, including the invocation
inside the integration tests. The first comparison may still be against a legacy single-run baseline.

**Rejected:** raising the factor/floor, deleting the baseline, using the minimum trial, retrying until
a pass, or dropping cold messages: each would hide evidence or change the performance being measured.
The repeated-trial design follows [pyperf's guidance on independent processes and multiple values](https://pyperf.readthedocs.io/en/latest/run_benchmark.html);
the trial count and all raw p95s remain visible. A runner consistently slower than the baseline will
still fail; investigating its environment remains necessary if that occurs.

*Amended 2026-11-26: the Bun runtime stays on 1.4.4.* The idle-memory budget (120 MiB, `bun run budget:api`) failed
on the update of every dependency at 124.3 MiB, where `main` read 113.8–115.4 MiB in CI. Seven runs per variant,
the median of the API's idle RSS, on Linux (containers from this repository's own `oven/bun` bases, arm64, so
every figure is about 4 MiB above CI's x64) and on macOS:

| Runtime | Dependencies | Linux | macOS |
|---|---|---|---|
| 1.4.4 | before | 120.3 | 152.7 |
| 1.4.4 | updated | 120.1 | 152.0 |
| 1.4.5 | updated | 126.2 | 157.4 |
| 1.4.5 | before | 128.1 | 154.5 |

The dependencies cost nothing; the runtime costs 6–8 MiB. An empty `bun -e` process goes from 13.9 to 22.7 MiB
between the two with the JavaScript heap unchanged (1.7 MiB), so it is the runtime's own native baseline and not
something this code can give back. **Rejected:** raising the budget, and starting the API with `--smol` or another
flag only to read lower, which changes what runs and what is measured in order to pass. Bun stays at 1.4.4 (`packageManager`,
`@types/bun`, the three `FROM`s in the `Dockerfile`) until a later release measures back under the budget; each
release is measured with `bun run budget:api` before it is taken.
