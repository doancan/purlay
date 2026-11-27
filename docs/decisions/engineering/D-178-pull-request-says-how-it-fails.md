# D-178. A pull request says how it fails

**Context.** `CONTRIBUTING.md` §6.9 asks every feature to answer six kinds of bad day — refused
input, authority, concurrency, partial failure, network and time, volume — with a test or a reason.
Written as prose alone it is a wish (§6.2): the omission it guards against is silent by nature, and a
reviewer reading a diff sees what is there, not the category nobody thought of.

**Decided: a fourth rule beside D-74's three**, in `scripts/check-pull-request.ts`. A pull request
that changes the product — `apps/` or `packages/`, outside tests — carries `## Failure modes` with one
non-empty line per category. The template lists the six with empty answers inside no comment, so leaving it as it is
fails; an answer inside a comment or under another heading does not count. Documents, tests,
tooling, configuration and dependabot owe none: §6.9 is about how the product fails, and asking a
`.gitignore` change for six answers teaches people to write *n/a* without reading.

**The check proves presence, not quality.** Whether *n/a — no input* is honest is the reviewer's to
judge; that the question was asked is the machine's. One line each keeps the cost to a minute on a
small fix, which is the price of never shipping a category nobody considered.

**Rejected: requiring a test file per category.** Many changes have no surface in a category, and a
test written to satisfy a counter is the theatre §6.2 warns about.

**Rejected: running the check again on every edit of the body.** Adding `edited` to the trigger
would rerun the whole verify job on each keystroke saved; a body fixed after the fact is rechecked
by the next push or by rerunning the job.
