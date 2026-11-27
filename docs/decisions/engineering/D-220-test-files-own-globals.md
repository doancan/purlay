# D-220. Test files have their own globals

*Amended by D-228: The whole suite runs two files at a time.*

**Context.** Bun 1.4.4 corrects coverage for previously unexercised branches. The runtime upgrade exposed missing failure/default-path tests, which are now exercised without lowering coverage floors. Full-suite runs also attributed another file's presence timers to the settings-swap leak probe and intermittently stalled a server-startup probe; those probes passed alone.

**Decision.** The unit, integration, full-suite and mutation commands use Bun's native `--isolate`: each file receives fresh globals and module state, and leftover handles are closed between files. Tests remain sequential. Existing leak assertions, coverage floors and timeouts stay intact. The environment-policy test and `tests-share-file-globals` mutation enforce the full-suite runner's flag. Package scripts put roots before the flag so Knip can still discover the tests.

**Rejected.** Shared globals let one file's browser adapters or asynchronous cleanup affect another file's assertions. A bespoke subprocess for the leak probe would isolate just one symptom and duplicate the runner's lifecycle support.

**Reversal.** Remove the isolation flags and their policy check/mutation together; no production data, contracts or configuration change. Reproduce the full suite before reverting, since standalone test success does not establish independence.

[Bun's isolation reference](https://bun.com/docs/test/parallel) describes the fresh-global lifecycle; [the 1.4.4 release notes](https://bun.com/blog/bun-v1.4.4#bun-test) describe the corrected coverage instrumentation.
