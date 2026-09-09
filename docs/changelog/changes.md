# Purlay — Changelog

Notable changes, newest first. Releases get their own file: `docs/changelog/v{x.y.z}.md`.

---

## Unreleased

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
