# Purlay — Changelog

Notable changes, newest first. Releases get their own file: `docs/changelog/v{x.y.z}.md`.

---

## Unreleased

### Implementation — 2026-09-09: channel visibility as a type

- **`ChannelContext`**, the second axis (D-34). Same mechanism as the tenant boundary: a brand keyed
  by a symbol its module does not export, so the only way to hold one is to have passed the guard,
  and asserting one is a lint error. The rule written for #12 covered it before it existed —
  matching by name rather than by a list was the reason.
- **The rule is written whole, though Phase 0 creates only public channels.** A guard correct only
  for today's case stops being one when the next arrives, and here that means showing somebody a
  conversation they were not in. The private cases are seeded directly and tested now; removing the
  membership check on purpose made a private channel visible to the whole workspace.
- **Four ways to be refused, one value.** Another workspace, private and not yours, soft-deleted,
  never existed — and a channel id that is not a UUID, which would otherwise be a `500` on the cast.
  The test compares the serialised responses and asserts there is exactly **one distinct shape**.
- **The lint rule caught the test that proves it.** Asserting a workspace context where a channel
  one was required is exactly what the ban forbids; the assertion is a `declare const` now, with no
  exemption anywhere.

### Implementation — 2026-09-09: workspaces

- **The four workspace endpoints Phase 0 serves**, each through the membership guard, each carrying
  the cross-tenant test `ARCHITECTURE.md` §10 makes mandatory — and asserting not only `404` but
  that the body is **byte-identical** to the one for a workspace that does not exist. Turning the
  guard's refusal into a `403` on purpose failed both.
- **`WORKSPACE_SLUG_TAKEN`** joins the closed error set. A slug is an address in a URL and the
  contract had no code for taking one twice; the nearest existing one was about channels.
- **Validation is this project's, not the framework's.** The framework's refusal echoes the
  submitted value and publishes the schema, so a typo comes back as a description of the server's
  own rules. The test asserts a submitted secret and the words `minLength` and `pattern` are all
  absent from the refusal.
- **I-2 is established here and guarded elsewhere**, stated rather than left implied: creation makes
  an owner and that is tested, and nothing in Phase 0 can then break it — changing a role and
  removing a member are both Phase 1. The guard belongs with the endpoints that can violate it,
  where it can be tested against something that tries.
- **`/api/*` requires a session**, in one place, with a missing and an invalid cookie producing the
  same `401`.

### Implementation — 2026-09-09: signing in with GitHub

- **The whole handshake**, driven end to end in tests against a real database with GitHub as a
  double: the redirect asking for exactly `read:user user:email`, the signed `state`, the code
  exchange, identity resolution, the session, and signing out — here and everywhere.
- **D-61** — **one public origin.** `CONFIG.md` said the callback registered with GitHub is
  `${APP_URL}/auth/github/callback` while `APP_URL` was documented as the *client's* origin and the
  API was a separate container. Every document was individually consistent and the combination did
  not work. Development is proxied so a browser sees what production shows it — which is the one
  place a topology difference is most expensive, because cookies and redirect URIs cannot be tested
  on a machine shaped differently from the deployed one. There is now no CORS at all.
- **D-62** — the `state` cookie is signed with a key **derived** from `ENCRYPTION_KEY`. Comparing
  the cookie to the query parameter is sound only while nothing else can write a cookie for this
  origin; a sibling subdomain can, and *cookie tossing* plus an attacker-chosen state signs the
  victim into the attacker's account. A second secret was rejected: the failure mode of *one more
  key* is the one nobody rotates.
- **Every collision D-38 names has a test**, including the likely one — GitHub omits the address
  from the profile for anyone who has not made one public, which is common among the developers
  this product is for. Removing the email-conflict check on purpose reproduced the silent account
  merge it exists to prevent.
- **A route group cannot be split out as a typed function.** The application's type is invariant in
  its routes, and the library's permissive alias launders `any` into every handler — 42 lint errors,
  which is the rule working. Handlers are framework-neutral now: a request in, a decision out.
- **A component test's DOM was leaking into the API's tests.** `bun test` runs every selected file
  in one process and imports files whose tests are all filtered out, so a top-level DOM
  registration fired during a run in which that file executed nothing — replacing `Request`,
  `Response` and `Headers` globally and breaking six API tests. Every file passed alone. Registering
  in `beforeAll` and unregistering in `afterAll` fixes it; adding only the `afterAll` did not,
  because the hook never ran. The reasoning behind choosing a per-file DOM over a global preload
  was right and the mechanism was not.
- **One test was silently flaky and was caught before it merged.** It tampered with the state by
  replacing the last character with `0`, which is a no-op whenever it already was `0` — a test that
  would have passed fifteen times in sixteen.

### Implementation — 2026-09-09: sessions

- **An opaque token, and only its hash in the database.** The claim is that a database dump hands
  over no live session, so the test looks for the raw token in **every column** of the row it
  created — a token that leaked into `user_agent` would pass a narrower assertion.
- **Every reason to refuse looks the same.** Expired, revoked, unknown, or owned by a deleted user
  all resolve to nothing. Otherwise an unauthenticated caller learns whether a token was ever real
  and whether an account ever existed — the 404-not-403 argument (D-21), one layer earlier. The
  deleted-user case is the one that would have been missed: a soft delete leaves the session row
  untouched, so without the join it keeps working.
- **D-60** — `last_used_at` is refreshed at most once an hour. This table is read on every request
  and every socket upgrade; writing it on every resolve turns the hottest read path into a write
  path to maintain a column whose only consumer is a device list nobody has built. Not maintaining
  it at all was also rejected: a column that never moves reads as data and is fiction.
- **The clock is a dependency**, in `platform/clock.ts` — the place the lint rule against reading
  it directly has been pointing at since it was written. It needs no exception to that rule.
- **The cookie's attributes are asserted, not trusted**, including the one that is invisible when
  wrong: the cleared cookie must match the original on everything a browser keys on, or sign-out
  stores a second cookie and the session survives.

### Specification — 2026-09-09: the stack table has to be true

- **D-59** — **the table says what is installed, and a test agrees.** D-57 stopped the next guess;
  it did nothing about the ones already in the table. A third column names the packages or compose
  services that make each row real, and every one is resolved against the manifests and
  `docker-compose.yml`.
- **The half that matters is the other direction.** `not yet` names its packages too and they must
  be **absent**, so a row cannot quietly stay behind once its thing is installed — the same drift
  pointing the other way, and the one nobody would think to look for. Proved by marking an
  installed package `not yet`, an absent one installed, and by removing the watcher from an
  `undecided` row.
- **It found one immediately.** *"A small CommonMark/GFM renderer"* and *"a sanitising serialiser"*
  are descriptions, not choices; they had no packages to name and nothing watching for the
  decision. **O-6** now, decided together in Phase 1 because the client renderer and the server
  sanitiser have to agree on what they accept.
- Generating the column was rejected: it would agree with the manifests by construction, which is
  the question being asked. The column has to be written and then contradicted by a check.

### Implementation — 2026-09-09: one command, two processes

- **`bun run dev` starts both.** It delegates to each workspace's own `dev` rather than repeating
  their commands, so there is one definition of how each application starts and the shortcuts
  (`dev:api`, `dev:web`) cannot drift from it. Bound by a test.
- Verified by running it: API `200` on `/health`, client `200`, from a single command.

### Implementation — 2026-09-09: the client boots

- **`bun run dev:web` serves and `bun run build:web` builds.** Vite, React and Tailwind at exact
  pins, wired the way the spike said Tailwind wants — its plugin and one line of CSS, no config
  file and no content array. Proved by the emitted rules, not by a class name in the markup:
  `.bg-slate-950{background-color:var(--color-slate-950)}`.
- **The measured floor: ~60 KB gzipped**, a quarter of the 250 KB budget, before a product screen
  exists. That number now sits beside the budget in `PRD.md` §5 rather than in a spike nobody
  re-reads. It is *smaller* than the spike's 82 KB because the spike installed things the client
  does not need yet — which is D-57 paying for itself.
- **The component-test DOM is registered per test file, not globally.** A `bunfig.toml` preload
  would install a DOM into every suite in the repository, including the ones where a dependency
  that feature-detects `window` would quietly take its browser path. The cost is that the global
  `screen` cannot work — `@testing-library/dom` binds it before any test file runs — so lint
  refuses that import and points at the measurement.
- **`bun x` from the wrong directory silently downloaded an unpinned Vite** and built with it. It
  succeeded, which is the problem. A check now refuses a script naming a tool its own manifest does
  not install.
- **The list of TypeScript projects is derived from the solution config**, not written down. The
  hand-written one fell behind within the hour: a tooling project was added and the check that
  compares what the compiler sees to what the linter sees reported a file nothing compiled.

### Implementation — 2026-09-09: the API is a process

- **It serves.** `bun run dev:api` starts ElysiaJS, `GET /health` answers `200`, an unknown route
  answers the error envelope rather than the framework's default, and a missing variable makes the
  process **refuse to start** — every problem at once, with secret values withheld.
- **One error handler, and three of its branches exist because a spike found the trap**
  (`docs/spikes/elysia.md`). A framework validation failure is not an `AppError`, so a handler
  branching only on `instanceof AppError` would have sent every `400` to the catch-all and told a
  client that mistyped a field the server had broken. The framework's own validation body echoes
  the request and publishes the schema; it is replaced entirely. Both were verified by removing the
  branch and watching the test fail.
- **`ROUTE_NOT_FOUND`** joins the closed error set: the contract had no code for *no such route*,
  and the nearest one would have been a lie.
- **The application returns the surface its caller uses, not the framework's type.** Annotating it
  as the bare `Elysia` does not compile — the type is invariant in its routes — and letting it
  infer puts every route's accumulated type into a committed `.d.ts`. Naming `handle` and `listen`
  answers both and keeps the framework's types out of everything above ingress.
- **No database handle is built yet**, because nothing needs one: liveness must answer while the
  database is down. It arrives with the first route that needs it.

### Specification — 2026-09-09: two claims finally run, and the rule that follows

- **D-57** — **a choice that has not been run is not a choice.** Three defects in a row had one
  shape: a branded type that could never have compiled (D-54), a task runner in the stack table
  that was never installed (D-55), a framework version named while nothing had installed the
  framework (D-56). The count, taken before fixing it: **19 stack rows, 6 ever run.** A tool now
  enters §2 on a record in `docs/spikes/` carrying the date, the versions actually resolved, the
  real output, and what had to be **loosened** — with "nothing" said out loud, because silence
  there is indistinguishable from not having looked. `CONTRIBUTING.md` §6.7 states it.
- **The two riskiest claims were run.** ElysiaJS and the whole web client stack both hold under
  this repository's strictness with **nothing loosened**. Both found things the documents did not
  know: ElysiaJS's own declarations produce 104 errors with `skipLibCheck` off, so its
  compatibility is contingent on that flag (now on D-20's risk row); the web skeleton spends a
  third of the bundle budget before a product screen exists; `happy-dom` alone cannot render a
  component; and one headless primitive costs about 28 KB.
- **D-58** — **what the client sends refuses what it did not declare.** Measured, not assumed: an
  undeclared property returns 200 and is silently dropped. Every shape a client sends is now
  closed, nested payloads included, and the set is derived from `ClientFrame` rather than listed —
  a new frame cannot escape by not being added to a list. Responses stay open on purpose.

### Specification — 2026-09-09: versions leave the documents

- **D-56** — **a version is a fact, so it lives in the manifest and nowhere else.** `ARCHITECTURE.md`
  §2 named versions beside choices. Two were bound to reality by a test; the third could not be,
  because nothing had installed the thing. The table was asserting a fact about a repository it had
  never looked at. §2 now names choices and never numbers, and `check-docs.py` — which already
  refused a version outside its owners — has stopped exempting it. It caught the paragraph
  explaining the rule, which named two versions while doing so.
- **Every dependency is pinned exactly.** The repository was mixed, with no rule written for which
  was which. A caret range is the polite form of *I do not know which version this is*; a pass from
  a differently-resolved tree is "green in one state is not green" one layer down. Checked, and the
  check was made to fail on purpose.
- The test binding the database image to a major written in §2 **lost its subject** and was
  replaced. The image tag is the fact; there is nothing left to bind it to.

### Specification — 2026-09-09: three claims the documents made and the repository did not

- **D-55** — **Bun workspaces are the build orchestration; there is no task runner.** The stack
  table listed Turborepo and accepted the cost of maintaining its configuration. Nothing was ever
  installed: no `turbo.json`, no `turbo` in any manifest. A table describing a repository that does
  not exist is worse than either choice. Resolved by deciding rather than by installing, with the
  trigger for revisiting written down instead of implied.
- **D-47 named the wrong owner.** Its text sent readers to `CONTRIBUTING.md` §5 for the required
  test matrix — the copy D-21 was amended to remove, and which §5 itself says lives in
  `ARCHITECTURE.md` §10. The reference resolved, so the consistency check passed: a section number
  can be right while the sentence around it is wrong.
- **`CONTRIBUTING.md` §5 said the same thing twice**, once as bullets and once as a paragraph under
  them. Removed rather than reconciled.

None of the three could be caught by what exists today. #156 covers the class the first one belongs
to: the table has to say which tools are installed, and a test has to agree.

### Implementation — 2026-09-09: the tenant boundary became a type

- **D-54** — a context is branded by a **module-private symbol key**, and asserting one is a lint
  error. The form `ARCHITECTURE.md` §7.3 documented — `readonly __brand: unique symbol` — is
  uninhabited: in property position it names a symbol no expression has, so not even the guard
  could have produced one, and every compile-time proof that a caller cannot forge a context would
  have passed because nobody could make one at all. The mechanism would have shipped with its
  escape hatch at the only place that must not have one.
- **`apps/api/src/platform/tenancy.ts`** — the membership guard, the sole producer of a
  `WorkspaceContext`. One refusal serves both "no such workspace" and "not your workspace", so the
  two are indistinguishable by construction rather than by two branches kept in step. A
  `:workspaceId` that is not a UUID takes the same refusal — handed to PostgreSQL it raises on the
  cast, and the boundary would have answered 500 where it promised 404.
- **The enforcement demonstration now names its rule.** It asserted only that ESLint exited
  non-zero, which any unrelated error in the violating file satisfies — a demonstration that can
  pass for the wrong reason, in the script that exists to stop exactly that. Each violation now
  declares which rule must reject it, and both failure modes were reproduced on purpose.
- **`verify` and the pipeline are compared in both directions.** The old comparison proved every
  CI step was runnable locally and said nothing about the reverse, so
  `bun run config:example -- --check` ran locally and never in CI. A check that cannot block a
  merge is a suggestion.
- **Branch names are checked** rather than named in a document nothing reads — the rule had been
  broken twice already. The prefixes are the Conventional Commit types, so a branch and its commits
  use one vocabulary (`CONTRIBUTING.md` §8).
- **`OVERVIEW.md` no longer states progress.** It said Phase 0 had not started, in a repository
  with a database, a contract and a pipeline in it. `bun run queue` computes it.

### Specification — 2026-09-09 (fourth pass): the interface, the budgets, and the escape hatch

The previous pass made seven rules fail the build and left the hatch that makes all of them
optional wide open. This pass closes that, and settles the two things the enforcement layer could
not check because nobody had decided them: what the interface is made of, and what "fast" means as
a number a build can fail on.

- **D-48** — exceptions are **expensive and visible, not closed**. Nothing stopped
  `// eslint-disable-next-line @typescript-eslint/no-explicit-any`, which made every rule optional.
  Each exception now names its rule, explains itself and links an issue; an unused one fails the
  build, so the debt cleans itself up. An outright ban was rejected: it pushes people to loosen the
  shared config instead, and a rule quietly weakened for the whole repository is far worse than one
  line marked as an exception. **The target is zero exceptions nobody can count, not zero
  exceptions.**
- **D-49** — seven performance budgets were declared CI-enforceable and **none was measured**, which
  is the exact failure D-17 exists to prevent, reproduced inside the document containing D-17. The
  two deterministic ones now block; the five that move between identical runs block on a regression
  instead. Thresholding a noisy p95 teaches a team to say "flaky, re-run it", and that habit does
  not stay confined to one check.
- **D-50** — the client stays a single-page application with a **prerendered shell**. The incumbent
  everyone finds heavy is not heavy because of how it renders; it is heavy because of how much it
  ships and how much it holds, so the answer is D-49's two numbers rather than a different
  architecture.
- **D-51** — desktop and mobile are **the same client in a shell**, and the bar is polish rather
  than platform nativeness. Recorded because the quality bar named two exemplar groups that made
  opposite decisions: none of the interface exemplars ships a native desktop application. Native
  Swift clients are **not planned** — not deferred, since that choice changes the design system and
  the contract from the first component.
- **D-52** — the frontend gets an architecture rather than only an interaction spec: **one source
  for every visual value** with a literal as a lint error, headless primitives for the five
  components where focus and ARIA fail silently, `axe` and a keyboard-path test per screen, visual
  snapshots, and a justification owed for each new primitive. `@base-ui-components/react` was the
  obvious modern choice and is **deprecated at release-candidate stage** — checked rather than
  remembered.
- **D-53** — "production-ready" is a **per-screen definition of done**, not a phase. Phase order
  decides what ships; this decides what shipping means. Each cause of an unfinished feel gets a
  mechanism instead of an intention.

### Specification — 2026-09-09 (third pass): making the rules executable

Forty-four decisions and eleven invariants, and **not one of them enforced by anything but
reading**. That is the mechanism by which a well-specified project quietly becomes an ordinary
one: the documents stay true and the code stops matching them, one reasonable exception at a time.
This pass closes that, and it is the last one before code.

- **D-45** — the Kysely types are **generated** from the applied migrations, not hand-written.
  `SCHEMA.md` §10 previously admitted to a hand-maintained copy policed by a drift test, which is
  the exact trade the ownership rule tells us not to make — and weaker than it looks, since a
  drift test only catches what someone thought to compare. Generation makes drift impossible
  rather than detectable. D-20's rejection of an ORM does not apply: code generation is build-time.
- **D-46** — integration tests run in **one transaction per test, rolled back**, with a template
  database for the cases that cannot. The consequence is architectural and is why it could not
  wait: **every service takes its executor as an argument**, so a service reaching for a
  module-level database handle is now a lint failure. Also written down: a flaky test is
  quarantined the day it appears and fixed or deleted within one working day, because a suite
  people learn to re-run has stopped being a gate.
- **D-47** — **a rule that is not mechanically enforced is not a rule.** The first code written is
  the enforcement layer, and its acceptance is a demonstration: a pull request containing `any`
  must go red. `strict: true` becomes the floor rather than the ceiling
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); lint rules become type-aware, which
  closes the likeliest defect in this architecture — a transaction whose `await` was forgotten;
  the layering rule becomes a real lint configuration; the documents' invariants become
  architecture fitness tests; `main` gets branch protection **that applies to the author of this
  entry, who pushed to it directly four times while writing these documents**; `AppError` codes
  become a discriminated union instead of free text; and request-id logging exists from the first
  handler rather than from the phase that needs it.

  Rejected in the same decision, so the effort goes where it pays: mutation testing, a global
  coverage target, DDD ceremony, pre-commit hooks as the authority, and tuning a build graph with
  nothing yet to build.

### Specification — 2026-09-09 (second pass): the product gained a cloud

The founding decision said *not a SaaS*. It now ships two ways, and that reopened everything
downstream of it. Three decisions were **rewritten** rather than amended, because patching a
decision whose premise changed leaves the old reasoning in place for the next reader to trust.

**Rewritten**
- **D-1** — self-hosted open source *and* a cloud we operate. Four audiences; the dogfood team
  still holds the only veto. **No open core**: the cloud runs the same code and sells operation,
  never withheld capability. The original decision's own warning — that paying customers would
  push roughly 40% of the engineering budget into non-product work — is now accepted rather than
  avoided, and phased so it cannot arrive before there is a product worth charging for. The size
  of the business is written down as a constraint: a small operation funded by its users, not a
  growth-stage SaaS.
- **D-24** — **MIT → AGPL-3.0, plus a CLA.** The original reasoning hinged word-for-word on
  *"D-1 explicitly gave up commercial ambition"*, which is no longer true. It also contained an
  error worth naming: it rejected AGPL because companies ban AGPL dependencies, which is a cost
  that applies to **libraries linked into a product**, not to an application a company runs
  internally. The CLA matters now rather than later — the ability to relicense or dual-licence
  ends at the first merged outside pull request, and `README.md` still says contributions open in
  Phase 2. `LICENSE` replaced; `NOTICE` added.
- **D-28** — for the cloud **we are the data processor**, so the DPA the previous decision
  refused to publish is now genuinely required, along with a real subprocessor list and breach
  notification. For self-hosters nothing changes: the operator is the controller and we are not a
  party at all. Two postures, stated separately, because one document covering both would be
  wrong in both directions.

**Amended** — D-7 (the shared broker is required by the cloud and *never* by a self-hoster),
D-20 (PostgreSQL 16 → **18**, versions pinned to current stable, ElysiaJS named as the highest-risk
choice now that uptime is a commitment, with Hono as a written fallback and a four-week trigger),
D-25 (multi-node is an obligation for one deployment and a measurement for the other), D-27
(retention is set by the operator when they own the disk, and by the plan when we do), D-31
(SSO has a paying demander now), D-10 (a vestigial line about text search configuration removed).

**Added**
- **D-39** browser and transport security. The gap that mattered: **no `Origin` validation on the
  WebSocket upgrade**, which is cross-site WebSocket hijacking, and it is built in Phase 0.
  Also: attachments served defensively, the one-line "external images proxied" turned into a
  hardened fetcher rather than an SSRF endpoint, a CSP baseline, and AES-256-GCM named for a key
  the configuration had already required.
- **D-40** deterministic collation. `lower('İ')` is not `i` under a Turkish locale, so channel-name
  uniqueness depended on how the server was provisioned. Identifier columns now declare
  `COLLATE "C"`, `citext` is dropped for the same reason, and `/health/ready` asserts it.
- **D-41** English and Turkish from the first screen, built on `Intl` and typed catalogues with no
  i18n library — a missing key is a compile error, and the 250 KB budget survives.
- **D-42** the cloud stays shared-database multi-tenant. The accepted cost is the largest in the
  document: an isolation bug reaches every customer at once, which is exactly why D-21 and D-34
  are enforced by types rather than by review.
- **D-43** per-**workspace** pricing, never per seat — charging by seat would contradict the cost
  axis the product competes on and the first paragraph of the README. Sold through a merchant of
  record, with a numeric trigger for moving to direct payments.
- **D-44** backups with a *tested* restore, error tracking, uptime monitoring, a status page, and
  `pino` named at last for the structured logging §10 had always mandated. No telemetry is ever
  collected from a self-hosted deployment.

**Scope** — a new phase, **2.5 / `v0.4.0` — Cloud**, gated on S-3 and blocked until S-1 is met.
`PRD.md` gains a fourth success criterion and a second primary persona; §6 keeps *per-seat
billing* on the permanent non-goal list and adds *open core* to it, while billing itself leaves.

### Specification — 2026-09-09

A capacity, compliance and operations pass. Four questions that the specification had never been
asked were answered, and answering them exposed one internal contradiction that had to be fixed
rather than worked around.

**Added — `DECISIONS.md` D-25 – D-32**
- **D-25** capacity: a numeric build target (300 sockets, 20 msg/s) and a multi-node ceiling
  (1 000+), with the three triggers that open Phase 3. D-7's rule finally has a measurement to
  point at. Two new seams follow — `PresenceRegistry` and `RateLimiter` — because they are the
  only node-local state whose *correctness* changes on a second node.
- **D-26** an append-only `audit_log` for administrative actions. Never message content.
- **D-27** retention, erasure and export — **closes O-3**. Retention is opt-in per workspace and
  defaults to infinite, so the "nothing is thrown away" tenet is unchanged. Account erasure and
  content erasure are two deliberately separate operations.
- **D-28** the project is not a data processor and will not publish a DPA. Ships the operator's
  data map and runbooks instead.
- **D-29** notifications now include **thread participation** — revises D-12. Without it, the
  person who asked the question never learns it was answered, which is the product's own thesis.
- **D-30** background work is CLI commands under an external scheduler; `job_runs` exists so a
  cron nobody installed is visible rather than silent.
- **D-31** SSO leaves the permanent non-goal list for Phase 3 (OIDC, gated on demand). SAML
  stays permanently refused.
- **D-32** work is tracked in GitHub Issues and Projects. Linear rejected: per-seat closed SaaS,
  which is the model D-1 exists to reject.

**Fixed — a contradiction, not a wording change**
- `PRD.md` §6 and D-1 both listed SSO/SAML as permanent while D-25 and D-26 described an
  organisation that has an identity provider. A non-goal contradicted by another decision teaches
  readers the whole list is negotiable, so it was resolved rather than softened.
- `SCHEMA.md` shipped `notification_type` values `thread_reply` and `thread_resolved` that D-12
  forbade. Resolved in favour of the enum, by D-29.

**Added — `DECISIONS.md` D-33 – D-36, closing the gaps a pre-implementation review found**
- **D-33** the client-supplied `messages.id` is validated at the boundary — v7 shape and a
  timestamp within `[now − 60s, now + 5s]` — and `ON CONFLICT` no longer returns an ACK without
  verifying the existing row belongs to the same sender and channel. D-8 made the id
  client-generated and never said what happens when the client sends something else; a poisoned
  id is a primary key and cannot be repaired. Clock skew is corrected from `ServerFrame.ts`,
  a field that was already defined for it and never used.
- **D-34** channel visibility becomes a second branded context. `WorkspaceContext` made the
  tenant axis structural; the channel axis was left to call sites, and two specified endpoints
  leaked because of it — search, and the open-questions view, which as written listed every
  member's private discussions. A third mandatory test class follows.
- **D-35** the message write path is one transaction, and the `EventBus` publish happens **after**
  the commit. Publishing first lets a subscriber receive a message that then rolls back, and with
  a durable client-generated id that client cannot learn to forget it.
- **D-36** markdown stays the only stored representation and §8.1's rationale is corrected: it
  claimed to save client render cost, which it never did. The content-pipeline dependencies §8
  was built on are now named in `ARCHITECTURE.md` §2 with their costs.

**Added — `DECISIONS.md` D-37, D-38, closing the last two gaps that blocked Phase 0**
- **D-37** `WORKSPACE_OPEN_JOIN_SLUG`. Phase 0's exit criterion requires two GitHub users in one
  workspace, and no Phase 0 endpoint could put them there — invitations are Phase 1 and joining a
  channel already requires membership. The phase had been defined with an exit criterion its own
  scope could not reach.
- **D-38** GitHub identity, with every collision given a defined answer: the requested scopes
  (`read:user user:email`) were written down for the first time; the email is the primary
  **verified** address or sign-in is refused, because the default `/user` response omits it for
  any developer who has not made it public and `users.email` is `NOT NULL`; a known address
  arriving under a different `github_id` is refused rather than silently linked (D-5); a username
  freed by a GitHub rename and taken by somebody else no longer collides fatally. It also closes
  an interaction neither D-22 nor D-27 covered — erasure now clears `github_id`, so signing in
  again creates a new account instead of resurrecting the one the person asked to have removed.
  Invariant I-11 extended.

**Fixed — found by a machine audit of every cross-document reference**
- `UX.md` §5 pointed at `PRD.md` §4.2 (*Threads*) for a statement about GFM in the composer,
  which belongs to §4.1 (*Messaging*). The section number was valid, so no link check would ever
  have caught it — only resolving each reference to its target's **title** did.
- `PRD.md` §4 carried a `4.6b` subsection. Renumbered to 4.7 and 4.8; nothing referenced §4.7,
  so the renumbering was free.

**Repository — work tracking moved to GitHub**
- **`docs/ROADMAP.md` retired.** Its task list now lives as GitHub Issues, one per task, and
  keeping both would have been exactly the duplication `OVERVIEW.md`'s ownership rule forbids.
  Its two unique facts moved rather than vanished: the working rule went to `CONTRIBUTING.md` §7,
  and the "never" list was already only a pointer to `PRD.md` §6. Eleven references updated in
  the same change.
- Milestones are versions, not phase names: `v0.1.0`, `v0.2.0`, `v0.3.0`, `v1.0.0`. The phase each
  one corresponds to, and its exit criterion, live in the milestone description; `PRD.md` §4
  remains the owner of what a phase contains.
- Issue templates for epic, feature, task and bug, plus a pull request template, each carrying the
  definition of done in two tiers — what always applies, and what applies conditionally. A
  checklist whose items do not all apply is a checklist people learn to tick without reading,
  which is the same failure D-17 was written to prevent.

**Repository**
- The contributor rules moved from an agent-specific filename to **`CONTRIBUTING.md`**, which is
  what an open-source repository is read for anyway. Content and section numbering are unchanged,
  so every `§` reference in the other documents still resolves. Agent entry points, vendored
  skills and their manifest are untracked.
- Five `.gitignore` patterns carried inline comments. Git does not support them: the trailing
  text became part of the pattern, so the agent-tooling directory was never ignored and
  `!.env.example` never took effect — which would have silently prevented Phase 0 from committing the file `CONFIG.md`
  requires.

**Schema**
- `workspaces.retention_days` (NULL = infinite, floor of 30 days), `audit_log`, `job_runs`
- New `SCHEMA.md` §9; Kysely types, invariants I-9 – I-11, migration `0009_administration.sql`.
  The unapplied Phase 2 migrations shifted to `0010`/`0011` — legal only because neither had run.
- Sections renumbered (Kysely §10, Invariants §11, Migrations §12) and every cross-reference in
  `ARCHITECTURE.md`, `CONTRIBUTING.md`, `UX.md` and `ROADMAP.md` updated in the same change.

---

### Specification — 2026-09-07

The four original drafts were solution specifications with no problem specification behind
them, and they contradicted each other in ways that would have failed at the first `INSERT`.
Reviewed, decided, and rewritten.

**Added**
- `DECISIONS.md` — 23 decisions, each with its rejected alternatives and reversal cost
- `ROADMAP.md` — phase-by-phase execution plan with exit criteria
- `PRD.md` now has a persona, a problem statement, success criteria and a competitor position
- Schema: `sessions`, `attachments`, `mentions`, `notifications`, `link_previews` — all five
  were promised by the PRD and absent from the schema
- `ARCHITECTURE.md`: `EventBus` seam, `WorkspaceContext` branded type, reconnect/replay
  protocol, error and observability rules

**Changed**
- `messages.id` → application-generated **UUIDv7**; pagination is keyset on `id` alone (D-8)
- Message ordering no longer depends on `created_at`, which was unstable within a millisecond
- Direct messages are workspace-scoped; cross-workspace DM removed (D-6)
- `parent_id` → `ON DELETE RESTRICT`, so soft deletion no longer destroys threads (D-9)
- Channel name uniqueness → partial index over named channels only; DMs keyed by `dm_key` (D-6)
- Workspace ownership → `workspace_members.role`; `owner_id` removed (D-22)
- `users.github_id` → nullable (D-11)
- `message_type` → `{text, system_event}`; a code block is not a row type
- Text search config → `simple`; the English `tsvector` column and index dropped (D-10)
- Unfurl cache → PostgreSQL `link_previews`, with negative caching (D-23)
- Performance targets → seven measurable budgets (D-17)
- Web Worker usage → measurement-driven, no longer a blanket rule

**Added in the audit pass** — five documents the specification referenced but did not have:
`README.md` (named directly by success criterion S-2), `docs/UX.md` (the wedge is a behaviour and
had three sentences), `docs/API.md` (the HTTP contract existed only as scattered mentions),
`docs/CONFIG.md` (the config loader was required to validate variables nobody had listed), and
`LICENSE` — the project called itself open source in three places while granting no rights at
all (D-24, MIT).

**Documentation hygiene** — after an audit pass, six facts that had been stated in two or three
files each were given a single owner, with the other locations reduced to pointers:
phase contents and non-goals → `PRD.md` · performance budgets → `PRD.md` §5 ·
stack and accepted costs → `ARCHITECTURE.md` §2 · required tests → `ARCHITECTURE.md` §10 ·
open questions → `DECISIONS.md` Part D · attachment size limit → the `attachment_size_limit`
constraint. An ownership table now lives in `OVERVIEW.md`.

Also fixed: `ARCHITECTURE.md` stated a WebSocket rate limit as settled while `O-4` recorded it
as an open question — it is now marked provisional in both places.

**Removed**
- Redis from Phases 0–2 — a single node needs no broker (D-7)
- Tauri from Phase 1 — moved to Phase 3 (D-14)
- Magic-link auth and GitHub webhook feeds from the MVP — moved to Phase 2 (D-5)
- Personal scratchpad — a self-DM does the same job with no new schema (D-5)
- The `<35MB idle memory` requirement — unachievable as stated (D-14)
- The "sub-millisecond search" claim — unachievable and unmeasurable as stated (D-10)
- The "local-first" claim — Zustand is in-memory; the accurate word is *optimistic* (D-19)
