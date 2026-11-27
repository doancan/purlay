# D-21. Testing floor, with tenant isolation as the non-negotiable

Inherited from the owner's standing engineering rules, with one addition specific to this
project: **every workspace-scoped endpoint carries a cross-tenant test asserting 404.**

Why that one is singled out: tenant isolation is the only defect class here that is silent,
unbounded and unrecoverable. A slow query gets noticed; a leaked message does not, and cannot be
un-leaked. It is also the rule most likely to erode, because it must hold on *every* endpoint
forever — so it is enforced by a type (`ARCHITECTURE.md` §7.3) and verified by a test, never by
remembering.

**404, never 403:** a 403 confirms the resource exists, which is itself a disclosure.

> **Single source of truth:** the required test matrix lives in `ARCHITECTURE.md` §10, and lives
> there only.
>
> **Amended 2026-09-09.** This decision used to sanction a copy — `CONTRIBUTING.md` §5 restating
> the matrix in imperative form, with a rule for which won when they disagreed. A sweep found the
> two had already drifted by six rows. A conflict rule is not a substitute for having one copy; it
> is an admission that drift is expected. `CONTRIBUTING.md` now points here and keeps only the
> discipline around the tests: write it first, verify by running it, and fix a violation rather
> than waiving it.
