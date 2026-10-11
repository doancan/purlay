# Purlay — Start Here (`OVERVIEW.md`)

Purlay is team chat for small engineering teams. Nothing is thrown away, and nothing interrupts
you by default.

It is **open source under AGPL-3.0**, and it ships two ways: self-hosted for free, or a cloud we
operate for teams who would rather not. Same code, **no open core**, and **no per-seat cost on
either** — the cloud charges per workspace. A small business funded by the people who use it, not
a growth-stage SaaS. (`DECISIONS.md` D-1, D-24, D-43)

---

## Read in this order

| # | Document | Answers | Binding on |
|---|---|---|---|
| 1 | **`PRD.md`** | Who it is for, what problem it solves, what ships in which phase | Scope |
| 2 | **`DECISIONS.md`** | Why every non-obvious choice was made, and what was rejected | **Everything — it wins any conflict** |
| 3 | **`ARCHITECTURE.md`** | How the parts fit: layers, transport, protocol, isolation | Structure |
| 4 | **`SCHEMA.md`** | What is stored: tables, indexes, invariants, migration order | Data |
| 5 | **`UX.md`** | How it behaves: layout, thread interaction, keyboard, states | Interaction |
| 6 | **`API.md`** | The HTTP endpoint contract, per phase | Interface |
| 7 | **`CONFIG.md`** | Every environment variable, validated at boot | Deployment |
| 8 | **GitHub Issues & board** | The ordered task list, one issue per task, milestone per version | Execution |
| — | **`../README.md`** | The public front door for self-hosters | Positioning |
| — | **`../CONTRIBUTING.md`** | The rules any contributor — human or AI — works under | Practice |

**Conflict rule:** if two documents disagree, `DECISIONS.md` is authoritative and the other one
is a bug. Fix it in the same change, do not work around it.

**Ownership rule.** Every fact has exactly one home; everywhere else links to it. When a
document needs a fact it does not own, it points rather than repeats — a number copied into a
second file is a number that will eventually disagree with itself.

| Fact | Owner |
|---|---|
| Phase contents, non-goals, performance budgets | `PRD.md` §4, §6, §5 |
| Capacity ceiling and the triggers that open Phase 3 | `DECISIONS.md` D-25 |
| What the cloud is, what it sells, and what it never sells | `DECISIONS.md` D-1, D-43 |
| Security posture: origin checks, CSP, attachment serving, the image proxy | `DECISIONS.md` D-39 |
| Collation and identifier text handling | `DECISIONS.md` D-40 |
| Interface languages and the i18n mechanism | `DECISIONS.md` D-41 |
| Retention, erasure and export semantics | `DECISIONS.md` D-27 |
| The list of background jobs and how they are scheduled | `DECISIONS.md` D-30 |
| Why any choice was made, and what was rejected | `DECISIONS.md` |
| Stack and accepted costs · required tests · protocol | `ARCHITECTURE.md` §2, §10, §5 |
| Why each table, constraint and index exists; the invariants; the tables still to come | `SCHEMA.md` — its DDL for applied tables is bound to the migrations by `scripts/schema-document.test.ts` |
| Layout, interaction, keyboard model, required states | `UX.md` |
| Every visual value — colour in each theme, spacing, type styles, radius, shadow, stacking, motion, stroke, sizes — and which pairs of colours must be readable | `packages/tokens/tokens.json` and `packages/tokens/src/pairs.ts` (D-97). `UX.md` repeats a few widths and sizes, bound to the file by a test |
| HTTP endpoints | `API.md` |
| Environment variables | `CONFIG.md` |
| Task breakdown and its ordering | GitHub Issues, milestoned by version (D-32) |

**Facts the code owns.** Added when there was code: a map that only covers documents sends somebody
looking for the error codes to a file that does not have them.

| Fact | Owner |
|---|---|
| Every version in the stack | The manifest that installs it — `package.json` files, `docker-compose.yml`. `ARCHITECTURE.md` §2 names choices and never numbers (D-56) |
| Repository layout and the enforced dependency direction | `docs/ARCHITECTURE.md` §4, enforced in `eslint.config.mjs` |
| What is never logged | `NEVER_LOGGED` in `apps/api/src/platform/logging.ts`, held to `ARCHITECTURE.md` §10 by a test |
| What the database schema *is* | `packages/db/migrations/` — the types are generated from it, never written (D-45) |
| The wire contract: models, socket frames, HTTP shapes, error codes | `packages/types/` — authored as schemas, the types derived (`ARCHITECTURE.md` §2) |
| Which string formats exist | `packages/types/src/formats.ts` — an unregistered format rejects every value |
| What markdown the product accepts, what it renders, and the bounds past which a body is shown as typed | `packages/markdown/` — one reading for the server and the browser; its tests are the definition (D-101) |
| What a message id is, and how a client makes one | `packages/types/src/message-id.ts` — the rule and the generator together, bound by a test (D-8, D-33) |
| The CSS custom properties, the Tailwind vocabulary and the token names | `packages/tokens/src/generated/` — generated from `tokens.json`, never written (D-97) |
| Which icons exist, and what each means | `glyphs` in `apps/web/src/components/icon.tsx` (D-97) |
| The variables the application reads | `apps/api/src/platform/config.ts` — `.env.example` is generated from it |
| The tenant boundary: what mints a `WorkspaceContext`, and what a stranger gets instead | `apps/api/src/platform/tenancy.ts` (D-21, D-54) |
| Which endpoints are tenant-scoped, where each sits on the channel-visibility axis, and how a test crosses each one | `apps/api/src/testing/cross-tenant.ts` (D-63, D-64) |
| The event bus seam and the topic names | `apps/api/src/platform/events.ts` (D-7) |
| The transaction boundary every write path shares | `apps/api/src/platform/transactions.ts` (D-35, D-46) |
| The local environment: images, ports, credentials | `docker-compose.yml` |
| What the supply chain is held to: pinned Actions, the audit gate, licences | `scripts/workflow-pins.test.ts`, `scripts/audit-gate.ts`, `scripts/licenses.ts` (D-91) |
| The deployable image: bases, user, health check | `Dockerfile`, held by `scripts/dockerfile.test.ts` and `scripts/image-smoke.sh` (D-92) |
| The production stack: what is published, what it needs | `docker-compose.production.yml`, held by `scripts/production-compose.integration.test.ts` (D-94) |
| What a backup is and how a restore is judged | `scripts/backup.sh`, `scripts/restore.sh`, `scripts/compare-databases.sh`, rehearsed by `scripts/restore-rehearsal.sh` (D-95); the bucket half is `scripts/bucket-copy.ts` and its manifest, `scripts/bucket-manifest.ts` |
| What is reported to an error tracker, and when | `apps/api/src/platform/error-tracking.ts` — the logger's `error` lines, only with `ERROR_TRACKING_DSN` set (D-96) |
| Which rules the build enforces | `eslint.config.mjs`, demonstrated by `scripts/verify-enforcement.ts` |

**How a fact stays owned.** Where a second copy is genuinely useful — the compose file *does* the
thing and `CONFIG.md` *explains* it — the two are bound by a test rather than trusted. Where it is
not, the copy is removed. A conflict rule that says which copy wins is not single ownership; it is
an admission that drift is expected.

---

## What it is, in one screen

- **Channels, DMs and threads.** Threads expand inline under their parent — never in a side
  drawer — and can be marked **Resolved**, which collapses them and keeps them searchable.
  This is the product's central idea. (`PRD.md` §4.2)
- **Quiet by default.** A direct `@username`, a DM, or a reply in a thread you are part of
  (D-29). `@here` and `@channel` are rejected by the parser and do not exist. Deep Work mode
  stops delivery server-side.
- **Developer-native content.** GFM, fenced code blocks with a language badge and clamping, and
  GitHub PR/Issue links that render as live cards.
- **Nothing is thrown away.** Full history, tombstoned deletes, resolved threads still
  searchable.

---

## Architecture in six lines

```
React + Vite     ──HTTP──▶  Bun + ElysiaJS  ──▶  PostgreSQL
       │           ──WS───▶        │              (everything durable)
       │                           ▼
  TanStack Query (server state)   EventBus (in-process)  ──▶  S3-compatible storage
  Zustand (socket + optimistic)                                (attachments)
```

One process, one database, one bucket. **No Redis and no message broker** — a single node
serving 30 people does not need one, and the seam to add one later is already in place.
(`DECISIONS.md` D-7)

---

## Repository layout

Owned by `ARCHITECTURE.md` §4, with the dependency direction lint enforces. Not drawn twice: a
tree copied into a second file is a tree that will describe a directory somebody moved.

`apps/desktop` (Tauri) arrives in **Phase 3**, not before. Mobile is the same client installed
from the browser, not a second codebase. (`DECISIONS.md` D-14, D-51)

## Current status

**Phase 0 — Walking Skeleton.**

Exit criterion: two browser tabs, signed in as two different GitHub users, exchange a message in
real time, and the message survives an API restart.

How much of it is done is deliberately not written here: a progress line is stale the moment a
pull request merges, and a document that says "not started" about a repository with code in it
teaches people to stop believing the documents. `bun run queue` computes it from the issues.

What happens next is on the board, not in this repository (D-32).
