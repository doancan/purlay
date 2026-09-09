## What this changes

<!-- One paragraph. What is different afterwards, not what you typed. -->

Closes #

## Verification

<!-- Paste the real output. Evidence, then assertion — never claim a pass without it. -->

```
$ bun run typecheck && bun run lint && bun test

```

## Checklist

CI decides whether typecheck, lint, the tests, the enforcement demonstration and the document
check pass — they are required status checks and this pull request cannot merge without them.
Repeating them here as boxes to tick would be theatre. What is left is what only a person can
confirm:

- [ ] Documentation updated **in this change** — a non-obvious choice is a numbered decision in
      `docs/DECISIONS.md` with what was rejected and why
- [ ] The minimal delta the issue required; no unrelated refactor rode along
- [ ] Contracts live in `@purlay/types`; no ad-hoc shape declared inside an app
- [ ] **No rule was loosened to make this pass** — no new lint exception, no widened budget, no
      waived violation. If one was genuinely unavoidable it is linked to an issue (D-48)
- [ ] `docs/changelog/changes.md` updated, if this is notable
- [ ] The commit messages carry no tool name and no ticket reference (`CONTRIBUTING.md` §8)

## New runtime dependency?

<!-- Name it and justify it, or write "none". Web standards and Bun built-ins are preferred. -->

none
