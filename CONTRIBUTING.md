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
    unused one fails the build. `@ts-expect-error` follows the same rule and `@ts-ignore` stays
    banned. A `TODO` without an issue number is unowned debt and fails lint. Dead code is debt:
    an export nothing imports is wired up or deleted. **The target is not zero exceptions — it is
    zero exceptions nobody can count.** (D-48)

---

## 2. Stack

Start the local environment with `bun run db:up` (PostgreSQL and object storage, waits for both to
be healthy).

**Two verification commands, and the difference matters:**

| Command | Needs | Runs |
|---|---|---|
| `bun run verify` | nothing | Everything that can be checked without infrastructure — typecheck (both compilers), lint, format, tests, the enforcement demonstration, the document consistency check, and that `.env.example` still matches the loader |
| `bun run db:check` | a database | The committed database types are exactly what the migrations produce (D-45) |

**The rest of the commands**, so they are discoverable rather than folklore:

| Command | Does |
|---|---|
| `bun run queue` | What is startable now, and what each blocked issue waits on |
| `bun run db:up` · `db:down` · `db:logs` | Start, stop and follow the local environment |
| `bun run db:reset` | Throw the data away and start again |
| `bun run db:migrate` | Apply pending migrations. Idempotent |
| `bun run db:generate` | Regenerate the database types from the applied migrations |
| `bun run config:example` | Regenerate `.env.example` from the configuration loader |
| `bun run lint:fix` | Fix what the linter can fix on its own |

`verify` is the fast loop and is deliberately the subset that needs nothing installed. A check that
requires a database is not omitted from CI — it is a job of its own, and this is the command that
runs it.

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
- **Never logged:** session tokens, encrypted access tokens, message content, email addresses.
- **Services publish to the `EventBus`; they never touch a socket.** The socket hub subscribes;
  it never touches the database.

## 4. Frontend (`apps/web`)

- **TanStack Query owns server state** (hydration, history, search). `fetch` inside `useEffect`
  is prohibited. **Zustand owns realtime and optimistic state** (socket, pending sends,
  presence). The boundary is in D-18 — if it arrived over HTTP it is Query's; if it arrived
  over the socket or has not been sent yet it is Zustand's.
- Every screen handles **loading, error and empty** states, and a test asserts all four render.
  An empty channel is a designed state, not a blank div. **No screen merges with a state
  unhandled** — that is missing specified behaviour, not missing polish. (D-53)
- **No raw visual values anywhere** — colour, spacing, type size, radius, shadow, motion duration
  and easing come from the tokens, and a literal is a lint error. `mt-[13px]` is the obvious case;
  the rule covers the whole vocabulary. Consistency comes from having no way to be inconsistent,
  not from remembering. (D-52)
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
- **A violation is fixed, never waived.** An accessibility failure, an isolation failure or a
  budget regression is a defect, not a threshold to adjust.

Write the test first. Verify by running it — never claim something passes without the output
in front of you.

---

## 6. Working on a task

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

**When is it done?** A task is done when it is typed, tested, and its documentation is accurate
— not when it runs. A milestone is done when its exit criterion is *demonstrated*, not when the
issue list is empty. (Inherited from the retired `ROADMAP.md`, which GitHub Issues replaced.)
7. **When the spec is silent, stop and ask.** Do not invent behaviour and do not guess at an
   undefined edge case. The open questions are listed in `DECISIONS.md` Part D — if your task
   hits one, that is a decision to be made, not a gap to be filled quietly.

---

## 7. Git

- **Branches:** `feature/`, `fix/`, `chore/`, `refactor/`, `docs/`
- **Commits:** Conventional Commits — `feat(messages): add keyset pagination`
- **No AI attribution in commit messages.** No assistant name, no tool name, no
  `Co-Authored-By` trailer for one. A commit records what changed, not what typed it.
- **No project-management vocabulary in commit messages.** No task, sprint, story, epic,
  ticket, issue or ADR references.
  - ❌ `feat(auth): task-123 sprint-5 için oturum ekle`
  - ✅ `feat(auth): add database-backed session validation`
- Before a PR: `bun run lint && bun run typecheck && bun test`.

---

## 8. Reminders

1. `DECISIONS.md` wins every documentation conflict.
2. Tenant isolation is checked on every endpoint, and returns 404.
3. Documentation is updated in the same change as the code.
4. Scope is the current phase — nothing from a later one.
5. Non-goals are permanent, not deferred.
6. Verify before claiming. Evidence, then assertion.
