# D-63. Which endpoints need a cross-tenant test is read from `API.md`, not remembered

D-21 makes a cross-tenant test mandatory on every workspace-scoped endpoint, and the tests existed —
one hand-written loop per file, each listing the endpoints its author thought of. Nothing failed if
an endpoint arrived without one. The rule most likely to erode was enforced by the same memory it
was written to replace.

**Decided: the list is the document's, and the build compares it.** Every `/api/` row in `API.md`
that the application actually routes must appear in exactly one of two tables in
`apps/api/src/testing/cross-tenant.ts`: `CROSS_TENANT`, with the case that crosses it, or
`UNSCOPED`, with the sentence saying why there is no tenant to cross. The check runs without a
database, in `bun run verify`, so the omission is caught before the integration job.

**A documented endpoint nobody has built yet is skipped, not demanded.** Phase markers would say the
same thing and could disagree with the router; asking the router cannot. The day a Phase 1 route is
served, its case is owed.

**Each crossing asserts four things, and the fourth is the one that makes the other three mean
anything.** The stranger — a member of a workspace of their own — gets `404` with the resource's
code; that body is identical to the one for an id that never existed, and to the one for an id that
is not a UUID; and **the owner's identical request succeeds**. Without the last, a path that routes
nowhere returns a perfectly real `404` and passes. The path is derived from the documented one, not
written per case, so a case cannot test a route other than the one it names.

**Rejected: a test per endpoint, each in its module's file.** That is what existed. It is readable
and it cannot notice what is missing — a list nobody compares is a list that is complete by
assertion.

**Rejected: enumerating the framework's registered routes instead of the document.** It would find
routes `API.md` does not list, which is a real gap — but a different one, and `ARCHITECTURE.md` §10
gives it to the fitness tests. Coupling this check to the framework's internals would make the
isolation guarantee depend on an API Elysia does not promise.
