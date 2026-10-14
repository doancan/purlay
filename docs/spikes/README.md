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
| [`design-tokens.md`](design-tokens.md) | 2026-10-10 | A reset theme stops the palette but not `z-50`, `duration-300` or `w-[13px]`; Lucide over Tabler by 1.2 KB, for a lighter dev server |
| [`backup-restore.md`](backup-restore.md) | 2026-10-09 | A backup restores and compares identical, including after a total loss — and the rebuild path found two defects the first restore could not |
| [`knip.md`](knip.md) | 2026-10-09 | Finds 19 things on the first run, nothing needed loosening — the one exemption is a named entry for the realtime client until #26 |
| [`garage-admin.md`](garage-admin.md) | 2026-10-14 | Garage's admin API prepares the store from the API image on every `up`, nothing loosened — and the production image had not built since #539 |
| [`markdown.md`](markdown.md) | 2026-10-11 | One engine on both sides for 29.9 KB; superlinear and stack-overflowing past bounds it now enforces — and the first bound was a grammar copy the fuzz test broke |
| [`image-proxy.md`](image-proxy.md) | 2026-10-12 | `node:https` with a checking `lookup` connects to the checked address with TLS for the name; `fetch` cannot — and a kept-alive socket skips `lookup` unless `agent: false` |
| [`capacity.md`](capacity.md) | 2026-10-13 | One process at 300 sockets and 20 msg/s: ACK p95 19–21 ms, fan-out 14–16 ms, all delivered — and 128–136 MiB under load, past the idle budget |
| [`cross-browser.md`](cross-browser.md) | 2026-10-13 | WebKit passes 124 of 132 and Firefox (on Linux) 126 of 132; every failure is the engine's or the harness's — Tab past the last element, no `first-paint`, a synthetic paste, offline emulation, CDP — no product defect |
| [`nodemailer.md`](nodemailer.md) | 2026-10-14 | Sends in order and UTF-8, honours its timeout, refuses a server without STARTTLS when told to — and the first run said otherwise because its script was never type-checked |
