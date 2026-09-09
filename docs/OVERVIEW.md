# Purlay — Start Here (`OVERVIEW.md`)

Purlay is self-hosted team chat for small engineering teams. Nothing is thrown away, and
nothing interrupts you by default.

It is **open source and self-hosted, not a SaaS.** There is no billing, no per-seat cost, and
no message history limit. (`DECISIONS.md` D-1)

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
| 8 | **`ROADMAP.md`** | The ordered task list for the current phase | Execution |
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
| Retention, erasure and export semantics | `DECISIONS.md` D-27 |
| The list of background jobs and how they are scheduled | `DECISIONS.md` D-30 |
| Why any choice was made, and what was rejected | `DECISIONS.md` |
| Stack and accepted costs · required tests · protocol | `ARCHITECTURE.md` §2, §10, §5 |
| Tables, constraints, limits enforced by the database | `SCHEMA.md` |
| Layout, interaction, keyboard model, required states | `UX.md` |
| HTTP endpoints | `API.md` |
| Environment variables | `CONFIG.md` |
| Task breakdown | `ROADMAP.md` |

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
React 19 + Vite  ──HTTP──▶  Bun + ElysiaJS  ──▶  PostgreSQL 16
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

```
purlay/
├── apps/
│   ├── api/          Bun + Elysia — ingress/ · modules/ · realtime/ · platform/
│   └── web/          React 19 + Vite — features/ · components/ · realtime/ · api/
├── packages/
│   ├── types/        the contract: models · events · api  (@purlay/types)
│   ├── db/           Kysely schema · SQL migrations       (@purlay/db)
│   └── config/       shared eslint · prettier · tailwind · tsconfig
├── docs/             PRD · DECISIONS · ARCHITECTURE · SCHEMA · UX · API · CONFIG · ROADMAP · changelog/
├── README.md         public front door
├── LICENSE           MIT (D-24)
└── CONTRIBUTING.md   contributor and AI-agent rules
```

`apps/desktop` (Tauri) arrives in **Phase 3**, not before. (`DECISIONS.md` D-14)

Detailed layout and the enforced dependency direction: `ARCHITECTURE.md` §4.

---

## Current status

**Phase 0 — Walking Skeleton. Not started.**

Exit criterion: two browser tabs, signed in as two different GitHub users, exchange a message in
real time, and the message survives an API restart.

No application code exists yet. The documents above are the specification it will be built
against. Next steps: `ROADMAP.md`.
