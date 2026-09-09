## What this changes

<!-- One paragraph. What is different afterwards, not what you typed. -->

Closes #

## Verification

<!-- Paste the real output. Evidence, then assertion — never claim a pass without it. -->

```
$ bun run typecheck && bun run lint && bun test

```

## Checklist

- [ ] No `any`; every function has an explicit return type
- [ ] The layering rule holds: `ingress → modules → platform`, and `apps/web` imports only from `packages/*`
- [ ] Contracts live in `@purlay/types`; no ad-hoc DTO inside an app
- [ ] Cross-tenant isolation test asserting **404** for every workspace-scoped endpoint touched
- [ ] Intra-workspace visibility test asserting **404** for every channel-scoped endpoint touched
- [ ] Permission test per role, for every role-gated action touched
- [ ] Migrations are append-only, and `packages/db/src/schema.ts` changed in the same commit
- [ ] Documentation updated in this change; a non-obvious choice is a new numbered decision in `docs/DECISIONS.md` with what was rejected
- [ ] `docs/changelog/changes.md` updated, if this is notable
- [ ] Commit messages carry no tool name and no ticket reference (`CONTRIBUTING.md` §7)

## New runtime dependency?

<!-- Name it and justify it, or write "none". Web standards and Bun built-ins are preferred. -->

none
