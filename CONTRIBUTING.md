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
and what CI runs, because nothing the integration tests reach reads object storage yet.

**Two verification commands, and the difference matters:**

| Command | Needs | Runs |
|---|---|---|
| `bun run verify` | a database, to be complete | Typecheck (both compilers), lint, format, **every test** through `test:all`, the enforcement demonstration, the document consistency check, and that `.env.example` still matches the loader. Without a reachable database the integration tests are not run, and it says so in a banner: that is a unit-only result, not the gate CI runs |
| `bun run test:all` | a database, to be complete | Unit and integration tests together, held to the coverage floor in `bunfig.toml`. In CI a missing database is a failure, never a skip (#202) |
| `bun run test` | nothing | The unit tests alone — the fast loop |
| `bun run db:check` | a database | The committed database types are exactly what the migrations produce (D-45) |
| `bun run test:integration` | a database | The tests that exercise real SQL, each inside a transaction that is rolled back (D-46). **They refuse rather than skip** when there is no database — a suite that quietly runs nothing looks exactly like one where everything passed |

**The rest of the commands**, so they are discoverable rather than folklore:

| Command | Does |
|---|---|
| `bun run queue` | What is startable now, and what each blocked issue waits on |
| `bun run check:pr <number>` | What CI checks of a pull request: it names its task, fits the line budget, and touches only what its issues are about (D-74) |
| `bun run db:up` · `db:down` · `db:logs` | Start, stop and follow the local environment |
| `bun run db:reset` | Throw the data away and start again |
| `bun run audit:gate` | The dependency audit, blocking at high severity; a finding with no fix is allowed only by an expiring entry in `scripts/audit-allowlist.json` (#247) |
| `bun run db:migrate` | Apply pending migrations. Idempotent |
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
- Forms use `react-hook-form` + `zod`.
- **Accessibility is not optional:** keyboard navigation, visible focus, WCAG AA contrast,
  labels on interactive controls. This product is keyboard-driven; there is no excuse.
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
5. **Verify.** `bun run typecheck && bun run lint && bun test`. Paste real output.
6. **Log it.** Notable changes go to `docs/changelog/changes.md`.

**Running it.** `bun run dev` starts both processes; `bun run dev:api` and `bun run dev:web` start
one. They read `.env`, which `bun run config:example` generates the template for, and the API
**refuses to start** if a variable is missing rather than failing later on the request that needed
it.

**When is it done?** A task is done when it is typed, tested, and its documentation is accurate
— not when it runs. A milestone is done when its exit criterion is *demonstrated*, not when the
issue list is empty. (Inherited from the retired `ROADMAP.md`, which GitHub Issues replaced.)
7. **When the spec is silent, stop and ask.** Do not invent behaviour and do not guess at an
   undefined edge case. The open questions are listed in `DECISIONS.md` Part D — if your task
   hits one, that is a decision to be made, not a gap to be filled quietly.

---

## 8. Git

- **Branches:** `feat/`, `fix/`, `chore/`, `refactor/`, `docs/` — the same words as the
  commit type below, so a branch and its commits do not use two vocabularies for one idea.
  Checked by `bun run check:branch`, which runs in `verify` and in the pipeline.
  `dependabot/` is the one other prefix: the bot names its own branches and cannot be told
  otherwise, and its commits carry `chore` (`.github/dependabot.yml`). Without it no update the
  bot opens could ever merge, and the trigger D-20 relies on it to watch would never land.
- **Commits:** Conventional Commits — `feat(messages): add keyset pagination`
- **No AI attribution in commit messages.** No assistant name, no tool name, no
  `Co-Authored-By` trailer for one. A commit records what changed, not what typed it.
- **No project-management vocabulary in commit messages.** No task, sprint, story, epic,
  ticket, issue or ADR references.
  - ❌ `feat(auth): task-123 sprint-5 için oturum ekle`
  - ✅ `feat(auth): add database-backed session validation`
- Before a PR: `bun run lint && bun run typecheck && bun test`.

---

## 9. Reminders

1. `DECISIONS.md` wins every documentation conflict.
2. Tenant isolation is checked on every endpoint, and returns 404.
3. Documentation is updated in the same change as the code.
4. Scope is the current phase — nothing from a later one.
5. Non-goals are permanent, not deferred.
6. Verify before claiming. Evidence, then assertion.
