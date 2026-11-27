# D-226. `verify` judges the browser jobs too, and lets them skip only for a change they cannot see — amends D-203

**Decided (the owner, 2026-10-31).** #821 merged with all four browser jobs red: the required checks were
`verify`, `schema` and the rest, and the browser jobs were none of them, so auto-merge took the change and the
deploy (D-185) put a dialog with two buttons named Save on the server for 25 minutes, until #823. The browser
jobs are now part of the required verdict.

- **`verify` needs `[static, schema, changes, browser]`** and judges each, as D-203 judges the first two: a failure,
  a cancellation, a missing result or a missing job is a refusal, naming the job.
- **A skip of the browser jobs passes only when `changes` succeeded and said `browser=false`**: a change they cannot
  see (`bun run ci:changes`: documents, tooling) still merges without a browser run. A skip for any other reason —
  `changes` failed, gave no answer, or said the change needs them — is a refusal, so the gate stays fail-closed.
- **The matrix is one result.** `needs.browser.result` is the matrix's: one red project is a red `browser`.
- **Branch protection is unchanged**: it already requires `verify`. A test binds the job's `needs:` to the gate's
  list, and mutations prove each new rule is tested.

**Considered and rejected.** *Requiring the four `browser (…)` checks in branch protection.* A job skipped by its
`if:` reports one check named `browser`, not its matrix names, so every change the browser jobs rightly skip would
wait forever for checks that never come. *Running the browser jobs on every change.* Four runners and some
eight minutes for changes to documents, for nothing they could see.

**Cost of reversing.** `needs:` back to `[static, schema]`, the list and the skip rule in `scripts/ci-gate.ts`, and
their tests and mutations.
