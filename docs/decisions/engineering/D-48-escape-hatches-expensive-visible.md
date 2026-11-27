# D-48. Escape hatches are expensive and visible, not closed

D-47 made the stated rules fail the build. It did not close the hatch that makes all of them
optional:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const parse = (x: any) => x;
```

Nothing stopped that. A ban with an unrestricted bypass is a suggestion, and the cost is not
theoretical — it is the days someone spends later removing `any` and ignore comments one file at a
time, long after the reasoning behind each has been forgotten.

**Decided: the hatch stays open, and is made expensive enough that nobody uses it casually.**

- **Every `eslint-disable` carries a rule name, a description and a linked issue.** No blanket
  disables, no file-level disables. The issue is what turns an exception into a countable, ownable
  piece of debt instead of an anonymous one.
- **An unused disable is an error.** When the code changes and the exception stops being needed,
  CI says so. The debt cleans itself up rather than accumulating.
- **`@ts-expect-error` follows the same rule** and is preferred over `@ts-ignore`, which stays
  banned: `@ts-expect-error` fails once the underlying error is gone.
- **A `TODO` or `FIXME` without an issue number is a lint error.** An unowned TODO is unowned debt.
- **Dead code is debt.** `knip` runs in CI: an export nothing imports is either wired up or
  deleted, not left for later.

**Rejected — banning disable comments outright.** It sounds stricter and is worse. A genuinely
unavoidable case — a third-party type that is wrong — pushes people to loosen
`eslint.config.mjs` instead, and a rule quietly weakened for the whole repository is far more
expensive than one line marked as an exception. The goal is not zero exceptions; it is **zero
invisible exceptions**.

**Accepted cost:** filing an issue for a one-line exception is friction. That is the point. The
friction is what makes the count stay near zero.

**Amended 2026-10-09 (#136).** The `knip` bullet was written and not run; it now is. `knip` 6.39.0
runs in `bun run verify` and in CI's `verify` job, and `verify:enforcement` plants an unused export
to show the build go red (`docs/spikes/knip.md`). Its first run found 19 things: ten exports and one
dev dependency were deleted or made private, and the exceptions are the whole of `knip.jsonc` —
three scripts run by shell inside a container, and the browser's realtime client, which nothing
imports until the client store lands (#26). Each carries a reason and an issue; none is a
`knip` ignore setting. Delete the realtime entry when #26 merges.
