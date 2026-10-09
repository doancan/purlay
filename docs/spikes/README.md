# Spikes — what was actually run

A choice in `ARCHITECTURE.md` §2 is a claim about a repository. Until something has been run, it
is a guess, and this project has already shipped several: a task runner named in the stack and
never installed (D-55), a web framework version named while nothing had installed the framework
(D-56), and a branded type whose documented form could not have compiled (D-54).

So a tool does not enter the stack table on reasoning. It enters on a file in this directory
recording:

- **the date**, because a compatibility answer expires
- **the exact versions** that were resolved, not the ones intended
- **the commands run and their real output**
- **what had to be loosened** — a compiler flag turned off, a lint rule disabled, a cast, an
  `any`. If nothing was, that is stated explicitly, because "nothing" and "I did not look" are
  indistinguishable otherwise
- **what surprised us**, which is the part worth more than the verdict

A spike that only reports "it works" has not been written down. (D-57)

| Spike | Date | Verdict |
|---|---|---|
| [`elysia.md`](elysia.md) | 2026-09-09 | Works, nothing loosened — contingent on `skipLibCheck` |
| [`web-client.md`](web-client.md) | 2026-09-09 | Works, nothing loosened — the shipped skeleton costs 25% of the bundle budget |
| [`frontend-budget.md`](frontend-budget.md) | 2026-09-09 | The declared stack is 69% of the budget eagerly, 43% split — and Radix has no combobox |
| [`image-pipeline.md`](image-pipeline.md) | 2026-10-09 | `Bun.Image` works on macOS and Linux with nothing installed — and `resize(w, h)` stretches |
| [`object-storage.md`](object-storage.md) | 2026-10-09 | Garage and RustFS pass every attachment operation; MinIO cannot be pulled — Garage chosen, set up by a script |
| [`backup-restore.md`](backup-restore.md) | 2026-10-09 | A backup restores and compares identical, including after a total loss — and the rebuild path found two defects the first restore could not |
| [`knip.md`](knip.md) | 2026-10-09 | Finds 19 things on the first run, nothing needed loosening — the one exemption is a named entry for the realtime client until #26 |
