# Purlay — Contributor Rules (`CONTRIBUTING.md`)

Rules for anyone working in this repository, human or AI.

**Read before writing code.** `docs/OVERVIEW.md` orients you; `docs/DECISIONS.md` is the
authority on *why*; `docs/PRD.md` fixes scope; `docs/ARCHITECTURE.md` and `docs/SCHEMA.md` fix
structure and data. What is next lives in GitHub Issues and the project board, not in a file
(D-32).

**Conflict rule:** if two documents disagree, `DECISIONS.md` wins and the other is a bug. Fix
it in the same change. Never work around a documentation contradiction silently — that is how
the first four drafts of this project ended up contradicting each other at the schema level.

---

## 1. Non-negotiable

1. **Scope is the current phase.** `PRD.md` §4 fixes what ships when. A feature belonging to a
   later phase is not built early because it "would only take a minute". A feature on the
   permanent non-goals list (`PRD.md` §6) is not built at all.
2. **Tenant isolation, on both axes.** Every workspace-scoped query goes through
   `WorkspaceContext` (`ARCHITECTURE.md` §7.3) and every channel-scoped query through
   `ChannelContext` (§7.5). Never hand-write `where workspace_id = …` at a call site — obtain
   the context from the guard. A cross-tenant leak is a critical-severity bug.
   Cross-tenant access returns **404, never 403**: a 403 confirms the resource exists.
3. **No `any`.** `strict: true` is the floor, not the ceiling — `noUncheckedIndexedAccess` and
   `exactOptionalPropertyTypes` are on, and the lint rules are type-aware (D-47). Use `unknown`
   with TypeBox narrowing at every boundary. Every function has an explicit return type.
4. **Contracts live in `@purlay/types`.** No ad-hoc DTOs, event shapes or response types inside
   an app. A shape defined twice will diverge.
5. **Database access lives in `@purlay/db`.** Kysely is the only query builder. No ORM, no
   runtime reflection.
6. **Migrations are append-only.** Never edit an applied migration. New file, ordered, and then
   **regenerate** `packages/db/src/schema.ts` — it is derived from the migrations, never hand-
   edited, and CI fails on any diff between the committed file and a fresh generation. (D-45)
7. **Soft deletion never cascades.** `deleted_at` plus a tombstone. Content is not erased.
   (D-9)
8. **`messages.id` is an application-generated UUIDv7.** Never `gen_random_uuid()`, never a
   database default. Pagination is keyset on `id`; `OFFSET` is prohibited on `messages`. (D-8)
9. **Optimistic first.** Every user action paints before the network round-trip and reconciles
   after. A send that fails surfaces as `failed` with a retry — never silently dropped.
10. **Quiet by default.** `@here` and `@channel` are rejected by the parser. Only a direct
    `@username` or a DM may produce a notification. (D-12)
11. **No new infrastructure without a measurement.** No Redis, no broker, no queue, no cache
    layer, no client-side database. The `EventBus` seam already exists for Phase 3. (D-7)
12. **No new runtime dependency without justification in the PR.** Prefer web standards and Bun
    built-ins. Lodash, Moment and Axios are specifically not wanted. The same justification is
    owed for a **new UI primitive**: interfaces decay by fifty reasonable additions, not by one
    bad one. (D-52)
13. **Exceptions are expensive and visible, never invisible.** Every `eslint-disable` names its
    rule, explains itself, and links an issue; a blanket or file-level disable is refused, and an
    unused one fails the build. `@ts-expect-error` follows the same rule in source and
    `@ts-ignore` stays banned; in a test it is an assertion — *this must not compile* — and needs
    only to say what it asserts. A `TODO` without an issue number is unowned debt and fails lint;
    write it `TODO(#123)`. Each of these is a lint rule, demonstrated by `verify:enforcement`.
    Dead code is debt: an export nothing imports is wired up or deleted, and `bun run knip` fails the
    build when one is left. What it cannot see is named in `knip.jsonc`, each entry with its reason
    and issue. **The target is not zero
    exceptions — it is zero exceptions nobody can count.** (D-48)

---

## 2. Stack

Start the local environment with `bun run db:up` (PostgreSQL and object storage, waits for both to
be healthy). `bun run db:up:postgres` starts the database alone — all the integration tests need,
because nothing the integration tests reach reads object storage yet. `bun run db:up:tests` starts the
database and Redis together, each waited on until healthy, which is what CI's test job runs.

**Two environment files, and a process reads one of them.** `.env` is the development servers' (`bun run
dev`, `dev:api`, `dev:web`, the database tools): what you would give a running Purlay. **`.env.test` is
the tests' — the address of the database *server* they may create and drop scratch databases on** — and
the demo's, the browser suite's and the budgets'. Copy `.env.test.example` to `.env.test`: one line,
`DATABASE_URL`, pointing at the compose database (its user, password, database and port are the ones in
`docker-compose.yml`, and the same URL the pipeline sets in `.github/workflows/ci.yml`). Those commands are
started `bun --no-env-file --env-file=.env.test`, so nothing in `.env` reaches them — not the key, not the
bucket, not a database that is yours — and every `bun` they start in turn says `--no-env-file` too:
`scripts/hermetic.test.ts` refuses a place that forgot. Without `.env.test` or a `DATABASE_URL` in the
environment `verify` still passes, on the unit tests alone, behind the banner below. The database a run
points at is brought up to its latest migration by the run itself, so one last migrated a week ago is not a
failure of the tests that use it.

**Two verification commands, and the difference matters:**

| Command | Needs | Runs |
|---|---|---|
| `bun run verify` | a database, to be complete | Typecheck (both compilers), lint, format, **every test** through `test:all`, the enforcement demonstration, the document consistency check, and that `.env.example` still matches the loader. Without a reachable database the integration tests are not run, and it says so in a banner: that is a unit-only result, not the gate CI runs |
| `bun run test:all` | a database, to be complete | Unit and integration tests together, held to the coverage floor in `bunfig.toml`. In CI a missing database is a failure, never a skip (#202) |
| `bun run test` | nothing | The unit tests alone — the fast loop |
| `bun run db:check` | a database | The committed database types are exactly what the migrations produce (D-45) |
| `bun run test:storage` | `bun run db:up` | The attachment store's S3 adapter against Garage, as the deployment runs it. Not in CI, which runs PostgreSQL alone; it refuses without `S3_ENDPOINT` (D-109) |
| `bun run test:integration` | a database | The tests that exercise real SQL, each inside a transaction that is rolled back (D-46). **They refuse rather than skip** when there is no database — a suite that quietly runs nothing looks exactly like one where everything passed |

**The rest of the commands**, so they are discoverable rather than folklore:

| Command | Does |
|---|---|
| `bun run queue` | What is startable now, and what each blocked issue waits on |
| `bun run check:pr <number>` | What CI checks of a pull request: it names its task, fits the line budget, touches only what its issues are about (D-74), and answers each failure mode of §6.9 (D-178) |
| `bun run db:up` · `db:down` · `db:logs` | Start, stop and follow the local environment |
| `bun run db:up:tests` | Start PostgreSQL and Redis together and wait until both are healthy: every service the whole suite reads, as CI's `schema` job starts them |
| `bun run db:up:redis` | Start Redis alone, for the tests of the cloud's shared bus, limiters and presence (D-201): put `REDIS_URL=redis://localhost:6379` in `.env.test`. Those files, `*.redis.integration.test.ts`, are the only tests that read it; without it `test:all` leaves them out behind a banner, and in CI it refuses. Nothing the application does without `REDIS_URL` reaches it |
| `bun run db:reset` | Throw the data away and start again |
| `bun run budget:api` | The API's idle memory: starts it against the database, waits until it is ready and settled, and fails at 120 MiB or more (`PRD.md` §5, D-49). Runs in `verify` and in CI's database job |
| `bun run budget:browser -- --project <name>` | Cold load, keystroke to paint and the channel switch as the browser tests measured them for one project, each as its run's median (`PRD.md` §5, D-49), judged as `budget:latency` judges: `-- --keep <file>` fails on a jump past the file's numbers or on a number it has that this run did not measure, and keeps only a run that passed. A run that measured nothing is refused. `-- --remeasure` measures a regression again, the measuring tests alone on one worker, and fails only if it repeats; measuring again that fails is a failure (D-227). Runs in CI's browser jobs, after the measurements; on a developer's machine the tests hold the lines themselves |
| `bun run ci:changes` | Whether a pull request can move what the browser tests see — the client, the API, a package, the dependencies or `ci.yml` — and so whether CI runs its four browser jobs; on main they always run. CI only |
| `bun run budget:latency` | The median of three independent API processes' ACK and fan-out p95 measurements, sixty messages each on two real sockets (`PRD.md` §5, D-49); all three trials reported. `-- --record <file>` keeps the summary and raw trials even on regression; `-- --baseline <file>` compares; `-- --keep <file>` compares and replaces the baseline only on success. A regression is measured again, three more trials, once, and fails only if it repeats; `--record` keeps the run judged last (D-227). CI retains the current trials as a seven-day artifact. Legacy single-run baselines remain comparable. Runs in `verify` and in CI's database job |
| `bun run measure:frames` | The synthetic measurement that closed O-4 (D-198): what a page sends — typing, sending, a paste, switching channels, a resubscription, a full outbox — through the limiter the server runs, as the peak frames a second, the burst, and what was refused |
| `bun run report:frames <log>…` | The check on that decision in use: over a stretch of the API's log (files, or standard input), each socket's peak frames in a second as the p99 and the maximum, beside the budget, and every refusal — frames, sends, HTTP `429` — which for legitimate use must be none (#61) |
| `bun run push:keys` | A Web Push key pair for `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (`docs/CONFIG.md`, D-126) |
| `bun run audit:gate` | The dependency audit, blocking at high severity; a finding with no fix is allowed only by an expiring entry in `scripts/audit-allowlist.json` (#247) |
| `bun run db:migrate` | Apply pending migrations. Idempotent |
| `bun run erase:content <who> --workspace <slug>` | An operator empties every message a person wrote in one workspace, and removes their files, on a request the controller has accepted (D-139 §7); `--all` instead of `--workspace` for a self-hoster who controls every workspace. Prints counts per workspace, never words; exits 2 on a person or workspace it cannot find |
| `bun run export:workspace <slug> <directory>` | An operator exports a workspace: every channel, one NDJSON file per table and a manifest, into a new owner-only directory it will not write over (D-140). Mount a volume for it in a container |
| `bun run job <name>` | A scheduled job (D-30), which owns the list; an unknown name prints every job. `jobs:status` says what each last did and exits non-zero when one is overdue or never ran; `jobs:first` runs, once, each that never succeeded (what the scheduler does as it starts). Reads the same configuration as the API |
| `bun run db:generate` | Regenerate the database types from the applied migrations |
| `bun run config:example` | Regenerate `.env.example` from the configuration loader |
| `bun run lint:fix` | Fix what the linter can fix on its own |
| `python3 scripts/check-docs.py -v` | Every cross-document reference, with the title of the section it lands on |
| `python3 scripts/check-docs.py --write-sections` | Re-lock the section numbering after deliberately renumbering a document |

`verify` runs what CI runs. With a database it is the whole gate; without one it still runs and
says plainly what it skipped, because the fast loop must not depend on Docker — and a banner
reading *integration tests not run* is the opposite of a quiet skip. `db:check` needs a database
and is a CI job of its own.

`bun` for everything (`bun add`, `bun run`, `bun test`) · Bun + ElysiaJS · Kysely +
PostgreSQL · TypeBox validation · React + Vite + Tailwind · TanStack Query + Zustand ·
S3-compatible storage.

Trade-offs we knowingly accepted: `ARCHITECTURE.md` §2.

---

## 3. Backend (`apps/api`)

- **Layering:** `ingress → modules → platform`. A module never imports from `ingress`; HTTP and
  WebSocket types never cross into a module. Lint enforces this.
- **Thin ingress:** validate → call one service → serialize. No business logic in a route
  handler or a frame handler.
- **No N+1.** List endpoints join or batch. Counters that appear in list views are denormalized
  columns (`unread_count`, `thread_reply_count`) — never a `COUNT(*)` per row. (D-13)
- **Pagination is mandatory** on every list endpoint, and keyset on `messages`.
- **Errors:** one `AppError` with a stable machine-readable `code`. A caught error is handled
  or re-thrown. Logging it and continuing is prohibited — that is how silent failures are born.
- **Never logged:** the list is `ARCHITECTURE.md` §10's, and lives there. Repeating it here is how one copy loses an entry.
- **Services publish to the `EventBus`; they never touch a socket.** The socket hub subscribes;
  it never touches the database.

## 4. Frontend (`apps/web`)

- **TanStack Query owns server state** (hydration, history, search). `fetch` inside `useEffect`
  is prohibited. **Zustand owns realtime and optimistic state** (socket, pending sends,
  presence). The boundary is in D-18 — if it arrived over HTTP it is Query's; if it arrived
  over the socket or has not been sent yet it is Zustand's.
- Every screen handles **loading, error and empty** states, and a test asserts all three render.
  An empty channel is a designed state, not a blank div. **No screen merges with a state
  unhandled** — that is missing specified behaviour, not missing polish. (D-53)
- **No raw visual values anywhere** — colour, spacing, type size, radius, shadow, motion duration
  and easing come from the tokens, and a literal is a lint error. `mt-[13px]` is the obvious case;
  the rule covers the whole vocabulary. Consistency comes from having no way to be inconsistent,
  not from remembering. (D-52, D-97)
  - **The vocabulary is `packages/tokens/tokens.json`.** To add or change a value, edit that file
    and run `bun run tokens:generate`; never edit `src/generated/`. The generator refuses an
    unsound file, and refuses a colour pair that is not readable in both themes, so a change that
    would ship an illegible interface fails before it is committed.
  - **A class that is not a token does not exist.** Tailwind's default theme is not imported, so
    `bg-red-500` and `p-7` build to nothing; `apps/web/src/styles.test.ts` fails on them, on a
    typo, and on the classes Tailwind builds from a bare number (`z-50`, `duration-300`).
  - **Icons through `Icon`.** `<Icon name="channel" />`; never `lucide-react` directly, never a
    pixel size or a stroke width. A missing glyph is a line in `glyphs` in `components/icon.tsx`.
- **Headless primitives for dialog, menu, combobox, tooltip and popover** (Radix). Focus
  management and ARIA are where hand-written components fail silently. Everything else is written
  here. (D-52)
- Forms are plain controlled fields. What a field may hold is the contract's TypeBox schema, checked
  by the server, and a refusal is said on the field it names (`VALIDATION_FAILED`'s `fields`). There
  is no client-side copy of a schema: it would be a second copy of each shape (§1.4). (D-142)
- **Accessibility is not optional:** keyboard navigation, visible focus, WCAG AA contrast,
  labels on interactive controls. This product is keyboard-driven; there is no excuse.
- **The supported browsers are named once**, as `browserslist` in `apps/web/package.json`. A web
  API one of them lacks fails lint, an ES2024 built-in fails to compile, and the build targets the
  same list — with what none of these sees written down in D-113.
- **Do not move work to a Web Worker by default.** Move it only when a measurement shows a
  dropped frame. For a clamped 12-line code block, the `postMessage` round-trip costs more than
  the highlight.
- Components stay focused and composable. There is **no line-count rule** — a diff renderer is
  legitimately large, and splitting a file to satisfy a number makes the code worse.

---

## 5. Testing

Mandatory. `typecheck` + `lint` + `test` gate every merge, and **CI is the only authority on
whether they pass** — a claim in a pull request description is not evidence (D-47).

`main` is protected: no direct pushes, required status checks, linear history. One issue, one
branch, one pull request.

**Which tests must exist is owned by `ARCHITECTURE.md` §10**, and is not repeated here. It was
repeated here until a sweep found the two copies had already drifted by six rows — which is the
whole argument against a copy, made by the copy itself.

What belongs here is the discipline around them:

- **Write the test first.** For a bug, the regression test is written before the fix and fails
  first.
- **Verify by running it.** Never claim something passes without the output in front of you, and
  CI is the only authority on whether it does.
- **Coverage says a line ran, not that a test would notice if it were wrong.** `bun run mutate`
  applies the hand-written mutations in `scripts/mutations.ts` (a guard removed, a limit raised, a
  call moved) to a copy of the repository and reports which the named tests catch; it exits
  non-zero on a survivor or on an entry that no longer applies. Add an entry for a guard whose
  removal no existing test would fail on, and run it before touching the code it names. It needs
  `DATABASE_URL` for the integration tests (D-47, amended).
- **A violation is fixed, never waived.** An accessibility failure, an isolation failure or a
  budget regression is a defect, not a threshold to adjust.
- **See it, and test it, the way it is deployed.** `bun run demo` builds the client, recreates a
  scratch database named `purlay_demo`, seeds a believable workspace *through the real API*
  (`apps/api/src/cli/demo-seed.ts`: four people, six channels, two days of conversation, threads,
  reactions, a read position) and serves it all on one origin at `http://localhost:4173`, keeping
  attachments in a directory of the run's own when no bucket is configured (D-117); the
  startup banner prints `/__demo/login?as=dogancan`, which hands the browser the genuine session
  cookie GitHub would have (use Chromium or Firefox: the cookie is `Secure`, which they accept on
  `localhost`). That login is a route of the demo's front server only — the API has none and never
  will. `bun run test:e2e:install` fetches Chromium once (CI runs it too); `bun run test:e2e` runs Playwright against the same harness in a database named
  `purlay_e2e`, in both themes and at two widths; `bun run test:e2e:update` rewrites the
  screenshots, which you then look at before committing (they depend on the machine's fonts).
  `PURLAY_E2E_ENGINES=webkit` (or `firefox`, or both) adds Safari's or Firefox's engine to a run, not
  in CI, with screenshots ignored and each engine's known limits skipped by name
  (`docs/spikes/cross-browser.md`). `PURLAY_E2E_PERFORMANCE=skip` runs every file but the two that write
  a measurement (`performance.e2e.ts`, `feed-scale.e2e.ts`), and `only` runs those alone, as CI does (D-227).
  `bun run budget:web` fails above 400 KB of initial gzipped JavaScript and names what grew (D-196): a backstop against an accident, never a reason to cut or defer a feature.

---

## 6. How to work

These are not style preferences. Each one closes a way that a repository with good documents
becomes a repository whose documents are fiction.

### 6.1. One fact, one home

**Before writing a fact down, find where it already lives.** `docs/OVERVIEW.md` carries the
ownership map for both the documents and the code. A version, a credential, a limit, a list of
rules — if it exists somewhere, point at it instead of repeating it.

**Prefer deriving to maintaining.** A value that can be generated from its source is never wrong;
a value transcribed from its source is wrong the first time somebody edits one of them. Generate
the types, generate the example file, compute the queue.

**Where a second copy genuinely earns its place, bind the two with a test.** Some duplication is
useful — one place *does* the thing and another *explains* it. That is fine when a check fails if
they disagree. A comment asking the reader to keep them in sync is not a mechanism.

**A conflict rule is not single ownership.** "If these two disagree, that one wins" is an
admission that drift is expected. Remove the copy or bind it.

### 6.2. A rule without a mechanism is a wish

**If a rule matters, make the build refuse to break it.** Prose is advisory. A rule nobody can
violate accidentally is worth more than three rules everybody agrees with.

**After writing a check, make it fail on purpose.** A check that has never failed is a check you
have not tested — and the most expensive kind is one that passes for the wrong reason.

**Never put a machine-checked thing on a human checklist.** The pipeline already blocks the merge;
a box to tick beside it teaches people to tick boxes without reading. A checklist earns attention
only if every item on it needs a person.

**Name what watches a trigger.** A written condition — *revisit when X* — with nothing watching for
X is a sentence, not a plan.

### 6.3. Verify behaviour, not descriptions

**A declared constraint is not an observed one.** Version ranges, capability matrices, tool
documentation and metadata describe what something claims. Run it.

**A mechanical edit asserts that it matched.** An automated change that silently does nothing is
worse than one that fails: the failure is loud, the no-op is discovered later by somebody else.

**When waiting for something, assert the positive condition.** *Nothing is pending* is trivially
true before anything starts. Wait for *the thing I expect exists, and it has finished.*

**Test files are isolated (D-220).** The standard suite and mutation commands use Bun's native
`--isolate`, keeping browser globals and leftover timers from affecting another file. Keep the
flag when running a multi-file diagnostic.

**Green in one state is not green.** Run the full verification in the order the pipeline runs it,
before committing. A local pass from a different working state is an opinion.

### 6.4. Suspect silence, and suspect success

The expensive failures are the quiet ones. A thing that breaks loudly costs an hour; a thing that
stops working without saying so costs whatever was built on top of it in the meantime.

**Prefer loud failure to a quiet one.** An error over a no-op, a refusal over a silent default, a
crash over a fallback that hides the cause. Anything that can fail without saying so eventually
will, at the worst time.

**Interrogate a pass.** *Could this have passed for a reason other than the one intended?* A check
that matched a comment instead of code, a filter that matched nothing, a validator that accepted
everything, a wait that returned before there was anything to wait for — each reports success and
means nothing.

**Absence is not evidence.** An empty result, a zero count, a clean search: equally consistent with
*nothing is wrong* and *nothing was measured*. Before believing one, establish that the measurement
could have produced the other answer.

**A green check is a claim, not a proof, until you have seen it go red.** This applies hardest to
checks you wrote yourself and to the ones that guard the most.

**When something works first time, be more careful rather than less.** It usually means you have
not yet run the case that fails.

### 6.5. Make a place, not an exception

When a rule does not fit a legitimate case, the fix is a **location** where that case belongs —
not a waiver for one file. A per-file exception is invisible and multiplies; a named place is
discoverable and stays small.

The same applies to an exception that is genuinely unavoidable: it carries its reason and a linked
issue, so it can be counted and eventually removed. **The target is not zero exceptions — it is
zero exceptions nobody can find.**

### 6.6. Finish the whole thing

**A task is done when the code, its tests, the documents and the board have all moved.** Not when
it runs. Anything less leaves work that looks finished, which is more expensive than work that
looks unfinished.

**Prove it, then say it.** Run the thing and paste the output. Evidence, then assertion — never the
other way round, and never assertion alone.

**Leaving part of the scope is a decision to state, not to make quietly.** Say what is left and
why, in the pull request, so somebody can disagree.

**Never destroy uncommitted work to get out of a mess.** Look at what is there first. A minute of
reading beats an hour of reconstruction.

### 6.7. A choice that has not been run is not a choice

**Reasoning about a tool is not evidence about a tool.** A version range, a compatibility matrix, a
changelog, an answer you are confident about — these describe what something claims. §6.3 says run
it; this says *when*, and the answer is **before it is written down as decided**.

**A tool enters `ARCHITECTURE.md` §2 on a spike record, not on an argument.** `docs/spikes/` holds
one file per tool: the date, the versions actually resolved, the commands and their real output,
and — the part that matters — **what had to be loosened to make it work**. A spike that reports
only "it works" has not been written down.

**"Nothing was loosened" has to be said out loud.** Silence there is indistinguishable from not
having looked, which is exactly the reading §6.4 forbids.

**Rejecting an alternative is also a claim.** "We rejected X because Y" is a guess unless Y was
observed. If the rejection is load-bearing — a fallback the project would actually reach for — it
is worth the same spike as the thing chosen.

**A compatibility answer expires.** It is true of the versions that were resolved on the day it was
run, which is why the record carries both.

### 6.8. Plan before you build

**Anything larger than a one-file change starts as a written plan**, in the issue or the pull
request — not in a new file. It names the contract (`@purlay/types`), the data (migration and the
rows already there), the failure modes (§6.9), the tests that will prove it, how it is rolled back,
and what is deliberately left out. A plan you cannot write down is a plan you do not have yet.

**Run a pre-mortem.** *It is three months from now and this broke in production — why?* Every
answer becomes a test, a guard, or an accepted risk written in the plan. An answer that becomes
none of the three has been forgotten, not accepted.

**Name the dimension that grows.** Rows, members, sockets, message size, files, jobs — say which
one this work depends on and where it breaks at ten times today's figure. That is a question for a
measurement, not for a new layer: §1.11 still holds.

**Reversibility sets the pace.** A change behind a seam can be undone by the next pull request and
may move fast. A one-way door — a migration that discards data, a public contract, a wire frame, a
stored format — gets a decision in `DECISIONS.md` before it gets code. A schema or contract change
an old row, an old client or yesterday's bundle in an open tab cannot survive is split: expand,
migrate, contract — never all three in one deploy.

**The hard way is the whole way, not the clever way.** The easy way handles the path the demo
walks. The right way handles the path the demo walks and every one in §6.9 — with the fewest
moving parts that do it. An abstraction with one implementation and no test seam is a cost, not
a standard; speculative generality is scope from a later phase (§1.1) wearing a disguise.

### 6.9. Build for the bad day

A test of the happy path proves the demo. **A feature is not done until each category below has a
test, or a sentence in the pull request saying why it cannot apply** — silence about one is the
absence §6.4 warns about. The template's *Failure modes* section asks for one line per row, and
`check:pr` refuses a change to `apps/` or `packages/` that leaves one empty (D-178). Which tests the project *requires* is `ARCHITECTURE.md` §10's; this is how
to find the ones a feature needs.

| Category | Ask |
|---|---|
| Refused input | Missing, malformed, wrong type, empty, oversized; the boundaries 0, 1, the limit and one past it; Unicode, right-to-left and emoji; text shaped like markup or SQL |
| Authority | Signed out; the wrong role; another workspace or a channel they are not in (`404`, §1.2); a session revoked or a member removed while the action is in flight; a target already soft-deleted |
| Concurrency | Two people, two tabs or a double click on the same row; a write racing a delete; a retry of something that already succeeded (idempotent, D-33); events arriving in another order |
| Partial failure | The database failing mid-transaction leaves nothing half-written; storage, GitHub, the mail relay or push timing out or answering `5xx` ends in a bounded wait and a stable error `code`, never a hang; the process restarting mid-job resumes or reruns safely |
| Network and time | Offline and back (replay); a slow or dropped socket mid-send ends as `failed` with a retry (§1.9); a duplicated frame; a skewed clock; a server restart under open tabs; yesterday's client against today's server |
| Volume | Zero, one, exactly a page, a page and one, and enough to reach the budgets (`PRD.md` §5) |

**Inject the fault at a seam, not by mocking the thing under test.** Executors are arguments, the
`EventBus` is an interface and each external service sits behind an adapter: make the real one
fail there. A mock of the code being tested proves only the mock.

**Prove it from two sides.** An endpoint is proved by its integration test *and* by the screen that
uses it, end to end (§5). When two layers disagree, one of them is lying — find which before
choosing.

**Test against the specification, not the implementation.** Write the cases from `UX.md`,
`API.md` and the plan, before reading the code you just wrote. A test derived from the
implementation re-asserts its bugs.

**Every new guard gets a mutation** (§5). If deleting the guard leaves the suite green, the guard is
not tested, whatever the coverage says.

**Someone who did not write it tries to break it.** Hand a reviewer — a person, or a separate agent
— the specification and the diff, not the author's account of it, and ask for the failing case.
Review that only confirms is not review.

### 6.10. Keep the project worth working in

**Ship vertical slices.** Each pull request is one thin path from contract to database to service to
ingress to screen to test, working on its own — not a layer that works only once three more land.
Small enough to review is the line budget's job (D-74); this is about shape.

**Stop the line.** A red `main`, a flaky test or a broken gate is the first task for whoever sees
it. A flaky test is a defect — in the test or in the product — and is never retried until green.

**Out of scope is not out of mind.** A defect found outside the task is an issue with a
reproduction, opened now. Fixing it inside the task breaks §7.3; ignoring it breaks §6.4.

**Operable is part of done.** If a feature fails in production, its log line (`ARCHITECTURE.md`
§10) must say what failed and where, by `code` and request id, without a debugger. A failure an
operator cannot see is one they cannot fix.

**Threat-model new surface.** A new endpoint, frame, permission, external call or stored secret
answers, in the plan: who can reach it, what it can reach in turn, what it costs at a thousand
times the expected rate, and what must never be logged (`ARCHITECTURE.md` §10).

**An escaped bug owes two fixes.** The regression test (§5), and the answer to *why did the gate
not catch it?* — a mechanism that now catches the whole class (§6.2). Blameless: the question is
what let it through, not who.

## 7. Working on a task

1. **Read the contract first.** Check `@purlay/types`. If the shape does not exist, define it
   there before writing any implementation.
2. **Check the phase.** Is this issue on the current milestone? If not, stop. A milestone is a
   version: `v0.1.0` is the walking skeleton, `v1.0.0` is the product finished as specified.

   **What to pick is a command, not a conversation:**

   ```
   bun run queue            # what is startable now, and what each blocked issue waits on
   bun run queue --apply    # also writes Status back to the board
   ```

   `Ready` means startable *now*: in the current milestone, and every issue it depends on is
   closed. Dependencies live in the issue body as `**Blocked by** #N`, and the board's Status is
   **derived** from them rather than maintained by hand — the same argument D-45 makes about the
   database types, one layer up. Setting it by hand meant it was wrong the moment something merged.
3. **Minimal delta.** Only the code the task requires. Do not refactor unrelated files.
4. **Update the documents in the same change.** Schema change → `SCHEMA.md`. Protocol change →
   `ARCHITECTURE.md`. Scope change → `PRD.md`. A non-obvious choice → a new decision in
   `DECISIONS.md`, with what you rejected and why.
5. **Verify.** `bun run verify`, with the database (§2). Paste real output.
6. **Log it.** Notable changes go under *Unreleased* in `docs/changelog/changes.md`, in the shape its header describes.

**Running it.** `bun run dev` starts both processes; `bun run dev:api` and `bun run dev:web` start
one. They read the root `.env` (each passes it with `--env-file`, since each runs from its own
directory), which `bun run config:example` generates the template for, and the API **refuses to
start** if a variable is missing rather than failing later on the request that needed it. Without
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` nobody could sign in, so `bun run dev` says so and
starts the demo on the same port instead (`scripts/dev.ts`): the real API and database, seeded, with
people to sign in as. Set both and the same command signs in through GitHub.

**When is it done?** A task is done when it is typed, tested, and its documentation is accurate
— not when it runs. A milestone is done when its exit criterion is *demonstrated*, not when the
issue list is empty. (Inherited from the retired `ROADMAP.md`, which GitHub Issues replaced.)
7. **When the spec is silent, stop and ask.** Do not invent behaviour and do not guess at an
   undefined edge case. The open questions are listed in `DECISIONS.md` Part D — if your task
   hits one, that is a decision to be made, not a gap to be filled quietly.

---

## 8. Git

- **Outside contributions are under the contributor licence agreement** ([`CLA.md`](CLA.md),
  D-24, D-145): sign it by adding yourself to `.github/cla-signatures.json` in your first pull
  request, under your own account. `bun run check:cla <number>` runs in the pipeline, and a pull
  request whose author has not signed, or that signs for somebody else, cannot be merged.

- **Branches:** `feat/`, `fix/`, `chore/`, `refactor/`, `docs/` — the same words as the
  commit type below, so a branch and its commits do not use two vocabularies for one idea.
  Checked by `bun run check:branch`, which runs in `verify` and in the pipeline.
  `dependabot/` is the one other prefix: the bot names its own branches and cannot be told
  otherwise, and its commits carry `chore`. It opens no new ones (D-219); the prefix stays while
  one it opened is still open, so that one can still merge.
- **Commits:** Conventional Commits — `feat(messages): add keyset pagination`
- **No AI attribution in commit messages.** No assistant name, no tool name, no
  `Co-Authored-By` trailer for one. A commit records what changed, not what typed it.
- **No project-management vocabulary in commit messages.** No task, sprint, story, epic,
  ticket, issue or ADR references.
  - ❌ `feat(auth): task-123 sprint-5 için oturum ekle`
  - ✅ `feat(auth): add database-backed session validation`
- Before a PR: `bun run verify`, with the database (§2).
- **A pull request is a piece of work, not a step of it.** Related fixes travel together: one
  task, one branch, one pull request, and no pull request opened on top of another that has not
  merged. Every push starts every workflow, and a chain of small pull requests each needing the
  last to land turns one change into a day of rebasing and waiting.
- **The pipeline is not where a change is tried.** Push what `bun run verify` has passed, with the
  database; a push to see what CI says spends minutes a local run spends nothing on. Once pushed,
  push again only to fix what the run found — and a pull request's superseded run is cancelled
  (`concurrency` in every workflow).
- **Releasing and deploying** are D-185, not this section: a merge to `main` deploys to the server by itself,
  and `bun run release -- <patch|minor|major>` opens the pull request whose merge is a release. There is no
  `develop` branch.
- **The browser jobs run when a screen can have moved.** Four jobs are most of a run; on a pull
  request they run only when it touches the client, the API, a package, the dependencies or
  `ci.yml` (`bun run ci:changes`), and on main always. Each runs the suite without the measuring
  tests, then those alone on one worker, and measures a budget regression again before it fails (D-227).
- **The required `verify` check is a verdict, not a job of steps.** `static` runs the checks that need
  no service and `schema` runs every test once, with coverage; `verify` needs both and the browser jobs,
  runs whatever they did, and passes only when each succeeded — a failure, a cancellation, a skip or a
  missing result is a refusal (`bun run ci:gate`, D-203). The browser jobs may skip only where `changes`
  succeeded and said the change touches nothing they see (D-226). CI only: locally `bun run verify` is
  the same checks and tests in one run, and the browser suite is `bun run test:e2e`.

---

## 9. Reminders

1. `DECISIONS.md` wins every documentation conflict.
2. Tenant isolation is checked on every endpoint, and returns 404.
3. Documentation is updated in the same change as the code.
4. Scope is the current phase — nothing from a later one.
5. Non-goals are permanent, not deferred.
6. Verify before claiming. Evidence, then assertion.
