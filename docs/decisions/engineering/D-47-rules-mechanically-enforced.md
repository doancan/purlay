# D-47. A rule that is not mechanically enforced is not a rule

*Amended by D-203: The required `verify` check is a fail-closed verdict over the static checks and the one run of every test.*

This document's decisions and `SCHEMA.md`'s invariants number in the dozens. **None of them is
currently enforced by anything but reading.** That is the mechanism by which a well-specified
project becomes an ordinary one: the documents stay true and the code stops matching them, one
reasonable exception at a time.

**Decided: the first code written is the enforcement layer, and it ships before the first
feature.** Its acceptance test is a demonstration — a pull request containing `any` must go red.

**Type level — `strict` is the floor, not the ceiling.** `strict: true` still types `arr[0]` as
present, which is among the most productive sources of runtime error in TypeScript. Also enabled:
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`.

**Lint — type-aware rules, not syntactic ones.** `no-floating-promises` and `no-misused-promises`
alone close the most likely defect in this architecture: a transaction whose `await` was forgotten.
With them: the `no-unsafe-*` family, `switch-exhaustiveness-check`, `consistent-type-imports`, and
`@ts-ignore` banned in favour of `@ts-expect-error` with a description. The layering rule
(`ingress → modules → platform`) becomes a real `import/no-restricted-paths` configuration rather
than a sentence.

**Architecture fitness tests — the documents' invariants, as tests.** Every endpoint in `API.md`
has a cross-tenant test; every table has a generated type; `OFFSET` never appears in a `messages`
query; no module imports from `ingress`; every cross-document reference resolves (the check that
already found a live defect). These fail in CI, which is the only place a claim about the codebase
is allowed to be settled.

**Process — the gate applies to everyone, including whoever wrote this.** `main` is protected: no
direct pushes, required status checks, linear history. One issue, one branch, one pull request. A
diff-size budget that fails loudly rather than silently, because scope creep inside a task is the
most common way an assistant introduces debt.

**Errors are a typed union.** `API.md` enumerated HTTP statuses and left the machine-readable
`code` values as free text, so a client cannot exhaustively handle them and adding one breaks
nothing. The set lives in `@purlay/types` as a discriminated union.

**Request identity and structured logging exist from the first handler**, not from the phase where
the cloud needs them. Threading a request id through service signatures afterwards touches every
signature.

**Rejected, deliberately, as effort that does not pay here:**

- **Mutation testing.** Genuinely rigorous, and its setup and run-time cost at this scale buys less
  than the fitness tests above.
- **A global coverage target.** A percentage produces tests written to move the percentage.
  `ARCHITECTURE.md` §10 already says which tests must exist and why; a floor on *newly added*
  lines is the only number worth keeping.
- **DDD or hexagonal ceremony.** `ingress → modules → platform` is enough structure for this
  product and it is enforceable. Aggregates and repository interfaces over repository interfaces
  are cost without a defect class to justify them.
- **Pre-commit hooks as the authority.** Useful for speed, skippable by design. CI decides.
- **A monorepo task runner.** Bun workspaces are the whole build orchestration (D-55).

*Amended 2026-10-09 (#246): mutation testing was rejected as costing more than it bought, and the
audit then ran 110 hand-written mutations and found 23 that no test noticed — among them the
OAuth state's length check, which, removed, accepts an empty signature. A mutation tool with a
generator is still the wrong size; a **list** of mutations is not. `scripts/mutations/` holds
each as `{file, find, replace, tests}`, `bun run mutate` applies them one at a time to a copy of
the repository (never the working tree) and reports caught or survived, a mutation whose `find`
no longer occurs once is reported stale rather than skipped, and `scripts/mutate.test.ts` proves
the runner tells a survivor from a kill. A new rule about behaviour a test could not see adds
its mutation in the same change (`CONTRIBUTING.md` §5).*

**The cost, stated:** roughly the first week produces no user-visible behaviour. That is the
trade — and it is the trade this project has already made once, deliberately, by writing the
specification before the code.

---

**Amended 2026-10-09 (#245): "thin ingress" was a sentence, and the code had drifted from it.**
`completeSignIn` (identity, open join, session) and the fan-out that ends a revoked session's
sockets lived in `ingress/http`, and a cookie became a session three times (the HTTP guard, the
hub, the socket admission). The orchestration is now `modules/auth/sign-in.ts`, the fan-out is
`publishSessionsEnded` beside its siblings in `platform/events.ts`, and the cookie header becomes a session in exactly one function,
`sessionFromCookie` (and `requireSessionFromCookie`, its refusal) in `modules/auth/sessions.ts`.
The cookie names and attributes moved to `platform/cookies.ts`: a header is a string, not a
transport type, and both doors need it — placing it in either door would have made the other
import it, which is the cycle this removes. What stays in `ingress/http/auth.ts` is reading the
request and writing `Set-Cookie` and `Location`.

**Amended 2026-10-09 (#245): test scaffolding left the production tree.** The HTTP doubles
(`testing.ts`), the signed-in-user fixture, the cross-tenant case table and the user rows sat in
`ingress/http` and `src/testing` beside code that ships, counted toward coverage, and nothing
stopped production code importing them. All four are now in `apps/api/src/testing/` — the
directory `ARCHITECTURE.md` §4 already named as "never imported by code". The cross-tenant table
read `docs/API.md` by a path relative to the working directory, so running the tests from anywhere
but the repository root silently found no endpoints; it now resolves the document from its own
location, and a test runs it from another directory.

**Amended 2026-10-09 (#245): the replay budget is a module's, and two casts went.** The byte and
per-channel caps and the cursor floor were in `realtime/router.ts`; they decide how a reconnecting
client catches up, not how a socket behaves, and nothing in them touches a connection. They are
`features/chat/messages/replay.ts` (`replaySince`), and the router sends what it returns. The two
"casts that defeat the exhaustive union" were checked first: the `ServerFrame` one was real
(`frame()` asserted `{event, data}` into the union), and is now built from a body that is itself
one member of the union, so an event paired with another event's data does not compile; the
`hub.ts` one was the timer handle (`as ReturnType<typeof setTimeout>`), now typed by a generic
`Timers<Handle>`. `joinChannel`'s "unreachable" branch is reachable — a member of a private
channel or a DM is in it, so the guard hands them a context — and had no test; it has one.



**Amended 2026-10-09 (#245): the `/api/me` read is a module's.** `readMe` ran a raw Kysely query
inside an ingress handler. It is `meOf` in `modules/workspaces/workspaces.ts` beside `membershipsOf`,
and the handler authenticates, calls it and returns. The stale "there is no logger yet" comment on
`ResolvedIdentity` now says who logs the username collision (`sign-in.ts`, D-38).

**Amended 2026-10-09 (#245): the composition root only composes.** `ingress/http/app.ts` was
438 lines because it also held the socket's whole lifecycle (admission, open, per-frame handling,
close, what is held). That is `ingress/ws/socket.ts` now (`createSocketLifecycle`), built from
plain functions over a structural view of the framework's socket — a route group cannot be passed
around (its type is invariant in its routes, `docs/spikes/elysia.md`), but functions can. `app.ts`
keeps the routes, the edge hooks and `drain`. Behaviour is unchanged and the existing socket
suites are the proof.

**Amended 2026-10-09 (#245): two more things lint refuses, each demonstrated by `verify:enforcement`.**
(1) `realtime` may not import from `ingress` (tests excepted — they stand up the whole application):
ingress composes realtime and never the reverse, so the two doors cannot form a cycle; before this
the hub read a cookie module out of `ingress/http` while `app.ts` imported the hub, and nothing
objected. (2) Production code under `apps/api/src` may not import test-only code — a `testing/`
directory or a `*.testing.ts` file — by a local rule, `purlay/no-test-code-import`, rather than a
pattern in `no-restricted-imports`, because each layering block there replaces the rule wholesale
and a pattern added to one would have been dropped by another. `bunfig.toml` leaves
`apps/*/src/testing/**` out of the coverage figures: that is safe only because of (2) — nothing that
ships can sit there to escape the per-file floor — and the floor still holds for every file that
does ship (shown with a production file whose branch no test reached: 57 % of lines, refused).
Rejected: keeping test code in the figures (the overall percentage then describes helpers, not
the product), and a `*.testing.ts` naming convention alone (a directory is one rule to state and
one glob to exclude).
