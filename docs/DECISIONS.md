# Purlay — Decision Record (`DECISIONS.md`)

> **Status:** Approved 2026-09-07. Amended 2026-09-09 (D-25 – D-38). Binding.
> This file is the SSOT for *why*. `PRD.md` says what, `ARCHITECTURE.md`/`SCHEMA.md` say how.
> Every decision below closes a question that was previously ambiguous or self-contradictory
> across the earlier drafts. Nothing here is inherited from those drafts unchallenged.

Legend: **D-n** = decision. Each records the choice, the reason, what was rejected, and the
cost of reversing it later.

---

## Part A — Product Identity

### D-1. Purlay is a self-hosted open-source product, not a SaaS

Three audiences, in priority order:

1. **Dogfood** — the owner's own team replaces Slack with it. This is the only audience whose
   opinion can kill a feature.
2. **Community** — other small dev teams self-host it. Drives OSS distribution.
3. **Portfolio** — the codebase is a work sample. Drives code quality standards.

**Consequences (things we now explicitly do NOT build):** billing, subscription plans,
usage metering, trial flows, sales-led onboarding, uptime SLA, multi-region infrastructure.
A SOC 2 or ISO certification programme stays rejected (D-28). **Enterprise SSO has left this
list** — it moved to Phase 3, gated on demand (D-31).

**Rejected:** building for paying customers. That path requires a distribution channel we do
not have, and would force ~40% of the engineering budget into non-product work.

**Reversibility:** cheap. A hosted offering can be added later on top of the same schema.
Multi-tenancy (D-3) is retained partly to keep this door open.

### D-2. The wedge is *subtraction*, not features

Purlay wins on four axes, in this order:

| Axis | Concrete meaning | How it is measured |
|---|---|---|
| **Simplicity** | No apps directory, no workflow builder, no huddles, no canvas, no AI summaries. One way to do each thing. | Feature count stays under a hard cap (`PRD.md` §6 non-goals) |
| **Speed** | Typing→render is never blocked on the network. Cold load and interaction budgets in `PRD.md` §5. | Measured budgets, enforced in CI |
| **Cost** | Self-hosted. No per-seat fee. **No message history limit** — Slack's free-tier 90-day cutoff is the single most cited pain. | $0 per seat; full history retained |
| **Dev-native** | Code, diffs and GitHub links are first-class objects, not attachments-with-syntax-colors. | Qualitative, judged by dogfood team |

**Positioning against the field** — this is honest, not flattering:

- **Slack** — the incumbent we are subtracting from. We lose on integrations, calls, mobile,
  enterprise features. We win on cost, history retention, and RAM.
- **Zulip** — the closest competitor and a genuinely better threading model than ours
  (topic-per-conversation, enforced). We do **not** claim to beat Zulip on threading. We differ
  by being lighter to run and operate, and by treating GitHub as a first-class citizen rather
  than a bot integration. *A team that is happy in Zulip is not our user.*
- **Discord** — free and already where devs are, but it is a community tool, not a work tool:
  no self-hosting, no data ownership, hostile to async.
- **Mattermost / Rocket.Chat** — self-hostable but they chased enterprise parity and inherited
  Slack's complexity. Our differentiator is what we refuse to build.

**We are not attempting to beat Slack.** We are attempting to be sufficient for a
5–30 person engineering team that resents paying for Slack and loses knowledge to its
history limit.

### D-3. One instance, multiple workspaces

A single deployment hosts multiple workspaces. A user has one identity across them and
switches with a sidebar, Discord/Linear style.

**Why keep multi-tenancy in a self-hosted tool?** Because the dogfood team already has more
than one context (company / side project / community), and because it preserves the option in
D-1. The cost is one indexed `workspace_id` column and one query-builder guard — cheap when
built in, expensive to retrofit.

**Reversibility:** removing tenancy later is easy; adding it later is a full migration.

---

## Part B — Scope

### D-4. Four phases, each gated on a demonstrated exit criterion, plus a permanent non-goal list

Work is phased, and each phase ends on something **demonstrated**, not on a ticked task list:
Phase 0 proves the pipe works end to end, Phase 1 gates on the owner's own team switching (S-1),
Phase 2 on a stranger self-hosting it (S-2), Phase 3 is polish.

**Why phase at all:** the earlier drafts had no phases, so every feature was implicitly due at
once — which is how a solo side project produces a monorepo scaffold and no working chat.

**Why a permanent non-goal list, separate from "later":** deferring a feature invites it back
every time someone has a free afternoon. Refusing it permanently is what makes the "subtract
before adding" tenet (D-2) enforceable rather than aspirational.

> **Single source of truth:** phase contents live in `PRD.md` §4. The permanent non-goal list
> lives in `PRD.md` §6. The task-level breakdown lives in `ROADMAP.md`. This decision records
> only *why the shape is this way* — it deliberately does not restate them.

### D-5. Cut from the previous PRD

| Removed | Reason | Where it went |
|---|---|---|
| Cross-workspace DM | Broke `workspace_id NOT NULL` in three documents at once, and lets a member of org A message org B outside A's admin visibility. Enterprise deal-breaker; Slack needed a decade and Slack Connect to do this safely. | Deleted. See D-6. |
| Personal scratchpad | A DM to yourself does the same job with zero additional schema, UI or code. | Folded into DMs. |
| Magic-link auth (MVP) | Second auth path means account-linking logic (same email via GitHub *and* email — same person?), which is a classic account-takeover surface. Also needs email infrastructure and deliverability work. | Phase 2. |
| GitHub webhook repo feeds (MVP) | Signature verification, delivery dedup, retry and replay is ~2 weeks of work and is *not* the wedge. Unfurling is. | Phase 2. |
| Tauri desktop (MVP) | Adds Rust toolchain, Apple Developer account + notarization, auto-update infrastructure and a second release channel — to gain notifications (Web Push already does this), a global shortcut and a dock badge. | Phase 3. See D-14. |
| Redis (MVP) | Single-node Bun needs no external broker. | Phase 3. See D-7. |
| "Sub-millisecond" search claim | Not achievable and not measurable as written. | Rewritten. See D-10. |
| "<35MB idle memory" | Not achievable with a real React app in WKWebView. | Replaced with real budgets. See D-17. |
| macOS-only Phase 1 | Excluding Linux from a developer tool needs a reason we do not have. | Web-first is platform-neutral. |

---

## Part C — Technical Decisions

### D-6. Direct messages are workspace-scoped

A DM is a `channel` with `type = 'direct_message'` and a real `workspace_id`. It has no name;
membership defines it. The tenant guard (`where workspace_id = ...`) therefore holds with **no
exceptions**, which is what makes it enforceable.

**Fixes:** the `UNIQUE(workspace_id, name)` constraint that would have collided on the second
DM — `name` becomes nullable, and uniqueness is enforced by a partial index that applies only
to named channels. A separate unique index on the sorted member pair prevents duplicate DMs.

### D-7. Real-time fan-out is in-process for now, behind an interface

Phase 0–2 run a single API process. Fan-out is an in-memory topic registry. All publish/
subscribe goes through one `EventBus` interface so that swapping in Redis/Valkey for Phase 3
is a single adapter, not a refactor.

**Rejected:** Redis from day one. It buys nothing on one node and adds a service to install,
monitor and reason about during the phase where velocity matters most.

**Also decided:** presence and typing indicators are **ephemeral and in-memory**. They are
never persisted and are allowed to be wrong after a restart.

### D-8. Message primary keys are UUIDv7 (time-ordered)

`gen_random_uuid()` (v4) is replaced by v7 for `messages`. Pagination is keyset on `id` alone.

**Why this is the highest-leverage decision in the document:** ordering underpins scroll
position, the unread marker, `last_read_message_id`, and optimistic reconciliation. With
random v4 PKs and a `created_at DESC` cursor, two messages in the same millisecond have
*undefined* order — the cursor drifts and users skip or re-see messages. UUIDv7 sorts by time,
is a stable cursor on its own, and can still be generated client-side — which means the
optimistic placeholder ID and the permanent ID share a format and the reconciliation loop
gets simpler, not harder.

**Rejected:** per-channel `BIGINT` sequence (cleanest ordering, but serializes inserts per
channel); composite `(created_at, id)` cursor (works, but inflates every index).

**Reversibility:** free today. After the first production message, a painful migration.

### D-9. Soft delete never cascades

`messages.parent_id` becomes `ON DELETE RESTRICT`. The previous `ON DELETE CASCADE` directly
contradicted the stated soft-delete policy: hard-deleting a parent would have silently
destroyed an entire resolved thread — exactly the knowledge loss Purlay exists to prevent.

Deleting a message sets `deleted_at` and clears `content` to a tombstone. Threads survive
their parent. Hard deletion happens only via an explicit operator-run purge job.

### D-10. Search is honest and scoped

- Text search config becomes **`simple`**, not `english`. English stemming folds
  `getUserById` into one unsearchable token and is actively wrong for Turkish content.
- The generated `tsvector` column and its GIN index are **dropped for Phase 1**. A GIN trigram
  index alone covers substring and identifier lookup.
- Search is scoped: within a workspace, optionally within a channel, newest-first, paginated.
- The performance claim is removed. Trigram GIN on a hot table costs 3–10× the content size
  and slows every insert — we are not trading message-send latency (the actual wedge) for
  search speed.

Real code search across repositories is a **different product**. Not in scope.

### D-11. Identity: GitHub OAuth only, database-backed sessions

- `users.github_id` becomes **nullable** (free option value for D-5's Phase 2 magic links);
  `email` stays unique and is the identity anchor.
- A `sessions` table is added. The previous drafts promised "cryptographic validation" of a
  cookie without specifying JWT or DB lookup.
- **Chosen: opaque token in an HttpOnly cookie, validated against the `sessions` table.**
  Revocation ("sign out everywhere", "this device was stolen") matters more here than saving
  a database round-trip — and we already query the database on every request anyway.
- **Rejected:** stateless JWT. Cannot be revoked before expiry.
- WebSocket upgrade validates the same cookie against the same table before binding the socket.

**Accepted limitation:** every workspace member needs a GitHub account. For a self-hosted tool
whose users are engineering teams this is acceptable in Phase 1, but it *does* exclude
designers, PMs and QA — which is why magic links are Phase 2 and not "never".

### D-12. Notifications are explicit and quiet by default

New tables: `mentions` (parsed at write time, one row per mentioned user) and `notifications`
(delivery + read state).

- Only direct `@username` mentions and DMs generate a notification.
- `@here` / `@channel` are **rejected by the parser**, not merely discouraged. This is the
  "zero-noise" tenet made structural rather than cultural.
- Phase 1 delivers in-app only. Web Push is Phase 2. **We will state plainly that Phase 1
  goes silent when the tab is closed** — pretending otherwise would fail dogfooding on day one.

### D-13. Unread counts are denormalized

`channel_members` keeps `last_read_message_id` **and** a maintained `unread_count` /
`unread_mention_count`. Computing unread with a `COUNT(*)` per channel on every sidebar render
is the N+1 the project rules already forbid.

### D-14. Desktop is Phase 3, and the memory target is replaced

The `<35MB idle` figure is removed from all documents. It is the footprint of an empty Tauri
shell; a React 19 app with a tokenizer and a live socket inside WKWebView realistically idles
at 80–150MB. A requirement that fails on first measurement teaches the team to ignore the
documents. Replaced by D-17.

### D-15. Deep Work is a server-side state, not a client toggle

Previously `is_deep_work_active` existed in the schema with no definition anywhere.

**Defined:** when active for a `workspace_member`, the server **suppresses notification
delivery** (rows are still written, so nothing is lost and a digest is possible later); the
client silences sounds and badges. It is stored server-side precisely so it holds across
devices and so the *server* stops pushing — a purely client-side mute would still wake a phone
in Phase 2. Optional auto-expiry timestamp so it cannot be left on forever.

### D-16. Attachments ship in Phase 1

A chat tool you cannot paste a screenshot into is not usable, so this cannot be deferred.

- New `attachments` table, linked to a message.
- Storage behind an S3-compatible interface: MinIO locally, any bucket in production, local
  filesystem for the simplest self-host.
- Per-file limit lowered **50MB → 25MB**. Images are downscaled and thumbnailed on upload.
- Per-workspace quota enforced, because self-hosters pay for the disk.

### D-17. Performance budgets that can actually be measured

The earlier drafts asserted `<35MB idle memory` and `sub-millisecond` search. Neither was
achievable, and neither was measurable as written. A requirement that fails on first
measurement teaches the team to ignore the documents — which is worse than having no
requirement at all.

**Decided:** every performance claim is replaced by a falsifiable budget with a number, a
percentile where one applies, and a stated measurement condition. Anything that cannot be
enforced in CI does not belong in a document.

> **Single source of truth:** the budget table lives in `PRD.md` §5.

### D-18. Client data ownership is split, deliberately

- **TanStack Query** owns HTTP/server state: hydration, channel lists, history pages, search.
  Direct `fetch` inside `useEffect` is prohibited.
- **Zustand** owns real-time and optimistic state: the live message buffer, pending sends,
  presence, typing, socket status.

The boundary: *if it arrives over HTTP it belongs to Query; if it arrives over the socket or
hasn't been sent yet, it belongs to Zustand.* Query's cache is updated from socket events.

### D-19. "Local-first" is dropped as a claim

The earlier `OVERVIEW.md` called Zustand "local-first optimistic state". Zustand lives in
memory — closing the tab loses everything. The accurate term is **optimistic**, which is what
we are building. Genuine local-first (IndexedDB persistence, offline queue, sync/merge on
reconnect) is a large, separate undertaking and is **not planned**.

### D-20. Stack confirmed, and its costs written down where they can be seen

Keeping Bun + ElysiaJS + Kysely + PostgreSQL 16 + React 19 + Vite + Tailwind + Zustand. Each is
defensible for this project.

The problem with the earlier draft was not the choices but the justification: its "Architectural
Rationale" column was written *after* the choices were made, listed only benefits, and named no
cost. That is marketing copy, and it makes a document untrustworthy — a reader cannot tell which
choices were weighed and which were assumed.

**Decided:** every stack row carries the cost we knowingly accepted, stated plainly.

**Rejected:** Node + Fastify (safer, but Bun's WebSocket engine and startup time are the point);
Drizzle and Prisma (both reintroduce a runtime layer over SQL); Redux (heavier than the
optimistic buffer needs).

> **Single source of truth:** the stack table with accepted costs lives in `ARCHITECTURE.md` §2.

### D-21. Testing floor, with tenant isolation as the non-negotiable

Inherited from the owner's standing engineering rules, with one addition specific to this
project: **every workspace-scoped endpoint carries a cross-tenant test asserting 404.**

Why that one is singled out: tenant isolation is the only defect class here that is silent,
unbounded and unrecoverable. A slow query gets noticed; a leaked message does not, and cannot be
un-leaked. It is also the rule most likely to erode, because it must hold on *every* endpoint
forever — so it is enforced by a type (`ARCHITECTURE.md` §7.3) and verified by a test, never by
remembering.

**404, never 403:** a 403 confirms the resource exists, which is itself a disclosure.

> **Single source of truth:** the required test matrix lives in `ARCHITECTURE.md` §10.
> `CONTRIBUTING.md` §5 restates it in imperative form for contributors; if the two ever disagree,
> `ARCHITECTURE.md` wins.

### D-22. Workspace ownership lives in the membership row, not on the workspace

The earlier draft had `workspaces.owner_id ... ON DELETE RESTRICT`, which makes a user who owns
a workspace **permanently undeletable** — a legal problem the moment someone asks to have their
account removed, and an operational one when a founder leaves.

**Decided:** `owner_id` is removed. Ownership is `workspace_members.role = 'owner'`, which also
makes co-ownership and ownership transfer expressible instead of impossible. `created_by` is
kept purely for audit and is `ON DELETE SET NULL`.

**Related:** users are **soft-deleted** (`users.deleted_at`) so that authorship on historical
messages survives; `messages.sender_id` therefore stays `ON DELETE RESTRICT`. Anonymising a
departed user is a profile-level operation, not a row deletion.

### D-23. Removing Redis moves the unfurl cache into PostgreSQL

`ARCHITECTURE.md` previously cached GitHub unfurl responses in Redis with a 300s TTL. D-7
removed Redis, and that cache cannot simply disappear — without it every paste of a popular PR
link re-hits the GitHub API and burns the workspace's rate limit.

**Decided:** a `link_previews` table keyed by URL hash, with `expires_at`. Reads are a primary
key lookup; expiry is enforced in the query and swept by a periodic job. This is slower than
Redis and entirely fast enough at our scale.

**Also decided:** GitHub API credentials are **workspace-level**, not per-user. Unfurling with
the viewer's own token would leak which private repositories a given member can see, based on
whether the card renders. One workspace token means every member sees the same card or no card.

### D-24. MIT license

The project called itself open source in three documents while having no license file, which
means default copyright applied and **nobody had permission to use it** — including the
self-hosters the product is designed for.

**Decided: MIT.** Shortest, most widely understood, imposes nothing on the people we want
adopting it, and fits the portfolio goal (S-3) where the point is that others can read and reuse
the work.

**Rejected — AGPL-3.0:** it protects against someone taking Purlay closed-source and running it
as a paid SaaS. But D-1 explicitly gave up commercial ambition, so AGPL would guard revenue we
have decided not to pursue — while a meaningful number of companies ban AGPL dependencies
outright, costing us adoption among exactly the self-hosting teams we are building for. Trading
real adoption for hypothetical revenue protection is the wrong side of that trade.

**Rejected — Apache-2.0:** the explicit patent grant is genuinely better for corporate adopters,
but it costs a much longer license text and a `NOTICE` file obligation, for a patent risk that is
negligible in a chat application.

**Reversibility:** a project can relicense forward while it has a single copyright holder.
Once outside contributors hold copyright it requires their agreement — which is one more reason
outside pull requests are closed until Phase 2 (`README.md`).

---

### D-25. Capacity ceiling is multi-node; the system is built single-node until a measurement says otherwise

The earlier documents sized the product at "a 30-person team" and used that to reject Redis,
a broker and multiple nodes (D-7). That number was never written down as a number, which meant
D-7's own rule — *no new infrastructure without a measurement* — had no measurement to point at.

**Decided: a stated capacity ceiling, an explicit build target, and numeric triggers between
them.**

| | Build target (Phase 0–2) | Ceiling (Phase 3, demand-gated) |
|---|---|---|
| Concurrent sockets | 300 | 1 000+ |
| Peak message rate | 20 / s | 100 / s |
| Messages retained | 5 M | 50 M+ |
| Storage | 50 GB | 500 GB+ |
| Topology | one API process, one PostgreSQL, one bucket | N API nodes behind a sticky LB, shared event bus |

**What this changes today — and it is deliberately small.** Nothing multi-node is built. What
is built is the *absence of node-local correctness*: any state that would be silently wrong on
a second node goes behind an interface now, because retrofitting an interface is a refactor and
declaring one is a file.

- `EventBus` — already seamed (D-7). Unchanged.
- `PresenceRegistry` — **new seam.** Presence and typing are in-memory (D-7). On two nodes each
  node would see half the workspace and report the other half offline. Ephemeral data is allowed
  to be *lost*; it is not allowed to be *confidently wrong*.
- `RateLimiter` — **new seam.** An in-process limiter on N nodes grants N times the quota. The
  in-process implementation stays; the interface makes the shared implementation an adapter.
- Background jobs — moved out of the API process entirely (D-30), which is what makes them
  multi-node safe by construction rather than by coordination.

**Triggers. Any one of these opens Phase 3; none of them is a reason to act before it fires:**

1. Sustained concurrent sockets > 250 on a single node, or
2. Send-path p95 > 120 ms (`PRD.md` §5) with profiling attributing it to contention, or
3. Single-node RSS > 1 GB under normal load.

**Rejected: building for the ceiling now.** Redis, sticky sessions and a read replica in
Phase 0 would add three operational surfaces to a system that has not yet sent its first
message, and would contradict the tenet the product is built on (D-2, "subtract before adding").
A capacity target is a constraint on *design*, not a licence to build ahead of demand.

**Accepted costs, stated so they are not discovered later.** The single PostgreSQL primary is
the last thing to scale and is deliberately unaddressed. The trigram GIN index on `messages`
(D-10) is the first thing that will hurt: GIN maintenance is on the hot insert path and D-10
already records that cost. It is revisited at 10 M messages, not before.

**Reversibility:** cheap in this direction. The seams cost three interfaces. Removing them later
if the ceiling never arrives costs nothing — an interface with one implementation is not debt.

### D-26. Administrative actions are recorded in an append-only audit log

A deployment carrying a thousand accounts and a retention policy (D-27) must be able to answer
"who removed that member", "when was the integration token replaced", "who ran the purge".
Nothing in the previous documents could answer any of them.

**Decided: an `audit_log` table, append-only, workspace-scoped, written by the service layer.**

Recorded: sign-in and sign-out, session revocation, role change, member added or removed,
workspace settings change, channel creation and deletion, integration credential set or removed,
retention purge, export, and account erasure.

**Not recorded: message content, message sends, reads, or anything already recoverable from the
domain tables.** An audit log that duplicates the message table is a second copy of the most
sensitive data in the product, and `ARCHITECTURE.md` §10 already forbids logging content. The
audit log answers *who did an administrative thing*, never *what was said*.

Append-only is enforced by convention plus a test, not by a database grant: the application user
needs `INSERT` on this table and nothing else, and a test asserts no service issues `UPDATE` or
`DELETE` against it. The workspace foreign key is `ON DELETE RESTRICT` so the record outlives
the thing it describes.

**Rejected:** logging to stdout only. Structured logs are rotated, shipped and eventually
dropped by whoever operates the box; an audit trail that a log-retention setting can silently
erase is not an audit trail.

### D-27. Retention, erasure and export — resolves O-3

"Nothing is thrown away" (D-2) is the wedge and stays the default. But an operator who is a data
controller must be able to throw things away on request, and a product that cannot delete a
person's data is unusable by any organisation subject to GDPR or KVKK.

**Decided, in three independent pieces:**

**1 · Retention is opt-in and per workspace.** `workspaces.retention_days` defaults to `NULL`,
meaning infinite — the default behaviour is unchanged and the tenet holds. When an operator sets
it, a purge job (D-30) hard-deletes messages older than the window. Enabling or changing it is
itself audit-logged (D-26), because silently shortening a team's memory is exactly the failure
this product exists to prevent.

**2 · Account erasure anonymises, it does not cascade.** Erasing a user clears the personal data
on `users` (email replaced with a non-routable placeholder, `username` becomes
`deleted-user-<short>`, `display_name` and `avatar_url` nulled), revokes every session, and sets
`deleted_at`. Messages are retained with anonymised authorship — this is what keeps a team's
technical history intact and is defensible under legitimate-interest grounds, provided it is
documented. A separate, explicit *content erasure* operation tombstones that user's message
bodies (D-9's mechanism, applied in bulk) for the cases where anonymised authorship is not
enough. Two operations, because they answer two different requests and conflating them destroys
history nobody asked to destroy.

**3 · Export is workspace-scoped, admin-triggered, and machine-readable.** NDJSON per table plus
the attachment blobs, produced by a CLI command (D-30) and downloadable once. Phase 2.

**Rejected:** a single "delete everything about me" button that cascades through messages. It
would take a resolved thread — knowledge belonging to the whole team — with it, which is the
exact loss D-9 was written to prevent.

### D-28. We are not a data processor, and we will not publish a DPA

A data processing agreement is a contract between a controller and a processor. Purlay is
MIT-licensed software that the operator runs on their own infrastructure; the project processes
no personal data and is party to no such contract. A DPA published by this project would be
legally void and would give operators false assurance about their own obligations.

**Decided: ship what an operator actually needs to write their own.**

- A **data map** — every table holding personal data, what it holds, why, and how long.
- A **retention runbook** — how to configure and verify D-27's policy.
- An **erasure runbook** — the two operations in D-27, with the commands to run and how to
  verify completion.
- A **subprocessor statement** — the project has none. The operator's own list is theirs.

**Rejected:** a SOC 2 or ISO programme. D-1 already ruled these out and a self-hosted tool
cannot be certified on someone else's hardware in any case.

### D-29. Notifications include thread participation — revises D-12

D-12 restricted notifications to a direct `@username` or a DM, while `SCHEMA.md` shipped a
`notification_type` enum containing `thread_reply` and `thread_resolved`. A direct contradiction,
and the resolution matters because it sits on the product's central claim.

The failure case is concrete. Alice asks why the retry backoff is four seconds. Bob answers in
the thread and does not write `@alice`, because nobody writes a mention inside a thread they are
already in. Alice never learns her question was answered. "Threads that end in an answer"
(`PRD.md` §4.2) does not survive that.

**Decided: a third notification class — participation.** A new reply notifies the root author
and everyone who has already replied in that thread. Resolving notifies the root author when the
resolver is somebody else.

This does not weaken "quiet by default". That tenet is aimed at **broadcast** — which is why
`@here` and `@channel` are rejected by the parser, and that stays absolutely unchanged. An
answer to a question you asked is not an interruption; it is the thing you were waiting for.
Deep Work (D-15) still suppresses delivery, and a channel set to `notification_level = 'none'`
still silences it.

Participants are resolved with a bounded `DISTINCT sender_id` over `idx_messages_thread`, which
is one indexed lookup per reply — not a scan.

**Rejected:** notifying only the root author. In a three-person discussion the second and third
participants would silently lose the conversation they are in, which reproduces the original bug
one seat over.

### D-30. Background work runs as CLI commands under an external scheduler

Three periodic jobs were promised and none had anything to run it: the orphan attachment sweeper
(`ARCHITECTURE.md` §9), the `link_previews` expiry sweep (D-23), and the `storage_used_bytes`
reconciliation (invariant I-7). D-27 adds a fourth, and session expiry a fifth.

**Decided: each job is a CLI command; scheduling is external.**

```
purlay sweep:orphans        purlay sweep:link-previews    purlay sweep:sessions
purlay reconcile:storage    purlay purge:retention        purlay export:workspace
```

**Why not an in-process timer**, which would be the simpler answer at one node: under D-25's
ceiling every node would run every job, so the sweeper would race with itself and the
reconciliation would fight over the same counters. Moving jobs out of the API process makes them
multi-node-safe by construction rather than by a distributed lock nobody wants to debug.

**The known weakness of this choice is the forgotten cron**, and it is closed rather than
accepted: the scheduler ships wired in the `docker compose` file so the default deployment has
it running, and every run records its outcome in a small `job_runs` table so the admin view can
surface *last successful run* per job. A job whose absence is invisible is a job that will be
absent.

**Rejected:** a PostgreSQL-backed job queue. Durable retries and fan-out are real features and
none of these six jobs needs them — they are idempotent sweeps that are simply run again
tomorrow. `CONTRIBUTING.md` §1.11 forbids the infrastructure until a measurement forces it.

### D-31. SSO moves from permanent non-goal to Phase 3, gated on demand

`PRD.md` §6 lists SSO/SAML as permanent. D-25's ceiling and D-26's audit log describe an
organisation that has an identity provider; keeping "never" alongside them is an internal
contradiction, and a permanent non-goal that is contradicted by another decision teaches readers
that the non-goal list is negotiable — which would damage the entries that genuinely are
permanent.

**Decided: OIDC, Phase 3, only if an operator asks.** Not SAML: SAML is XML signature handling
and a decade of parser vulnerabilities, for the same outcome at roughly ten times the cost.
`users.github_id` is already nullable (D-11) and `email` is already the identity anchor, so the
schema does not change.

The rest of `PRD.md` §6 is unaffected and stays permanent.

### D-32. Work is tracked in GitHub Issues and Projects

**Decided: GitHub Issues for the unit of work, a GitHub Project board for the view.** One issue
per `ROADMAP.md` task, phase as a field, the exit criterion as the milestone.

**Rejected — Linear:** better interface, and the wrong home for this project. It is a per-seat
closed SaaS, which is the model D-1 exists to reject; it puts the work behind a second account
for anyone who wants to contribute; and S-2 wants a stranger to find the plan next to the code,
not in a tool they have no login for.

**Rejected — OneDev, and this was the closer call.** A self-hosted platform that carries git,
issues, review, CI, a registry and boards on one lightweight process is philosophically *more*
consistent with a self-hosted product than GitHub is, and that inconsistency is real rather than
imagined. It loses on four concrete grounds, none of them ideological:

1. **GitHub is an integration dependency here, not a convenience.** PR and Issue unfurl is the
   Phase 1 wedge (D-23), Phase 2 adds webhook repo feeds, and D-11 makes GitHub OAuth the only
   identity path. With the repository elsewhere, the project cannot paste its own pull request
   into its own chat and see the card — it cannot dogfood the one axis D-2 says is judged
   qualitatively by the dogfood team.
2. **S-2 is a distribution criterion.** Strangers do not discover self-hosted instances. Leaving
   GitHub does not slow that goal down, it removes its channel.
3. **S-3 is an access criterion.** A reviewer needs a URL that opens without an account.
4. **`CONTRIBUTING.md` §1.11 applies to us too.** Operating a DevOps platform — backups,
   upgrades, TLS — to track a few dozen issues for a team of one is the complexity this project
   refuses everywhere else.

**What would reverse this:** OneDev wins if Purlay stops being GitHub-native (D-23 and the Phase 2
feeds leave scope) **and** the repository stays private permanently (S-2 and S-3 are abandoned).
Both together describe a different product, so that is a `PRD.md` change and not a tooling choice.

**Rejected — issues in a Markdown file:** it is what the roadmap already is, and it cannot show
what is in flight.

`CONTRIBUTING.md` §7 is unchanged and still binding: **no issue or ticket reference appears in a commit
message.** Linkage lives in the pull request body, where it belongs.

### D-33. A client-supplied message id is validated at the boundary, and a conflict is never an ACK

D-8 made `messages.id` a client-generated UUIDv7 and called it the highest-leverage decision in
the document. It did not say what happens when the client sends something else. `ARCHITECTURE.md`
§5.3 went straight from "validate (TypeBox)" to "INSERT with the client's id", and TypeBox can
only assert *this is a UUID* — not *this is a v7 carrying a plausible timestamp*.

Three failures follow from trusting it, and all three are permanent because the value becomes a
primary key:

1. A v4 id in a channel makes that channel's ordering wrong forever.
2. A v7 id with a year-2099 timestamp pins itself above every future message **and** breaks
   keyset pagination for every reader, because `id < cursor` now skips real rows.
3. `ON CONFLICT (id) DO NOTHING` returning an ACK turns a send into an existence oracle, and
   lets a client silently discard its own message by colliding with someone else's id.

**Decided: the id is untrusted input and is checked like any other.**

- **Shape.** Version nibble is `7` and the variant bits are RFC-conformant, or the frame is
  rejected with `INVALID_MESSAGE_ID`.
- **Time.** The embedded millisecond timestamp lies within `[now − 60 s, now + 5 s]`. Generous
  enough for a laptop that has not synced, tight enough that nothing can be pinned to the top of
  a channel.
- **Conflict.** After `ON CONFLICT (id) DO NOTHING`, the existing row is read back and its
  `sender_id` and `channel_id` are compared with the requester. A match is the idempotent retry
  D-8 designed for and returns the same ACK. A mismatch returns `409 MESSAGE_ID_CONFLICT` and
  **no ACK, and no field of the existing row** — the response must not confirm what it collided
  with.

**Clock skew, which the documents never acknowledged as a cost.** Two clients with skewed clocks
interleave against real time. The correction already exists and was unused: `ServerFrame.ts` is
defined as "server clock, for drift correction only". The client derives an offset from the first
`PONG` after connect and generates ids against the corrected clock. Sends before that offset
exists are rare — the handshake completes long before a person finishes typing — and a rejected
frame surfaces as `failed` with retry, which is the path §5.3 already specifies.

**Rejected — generating ids on the server.** It removes the problem and the benefit together:
D-8's entire payoff is that the optimistic row and the durable row share one id, so the message
never moves in the list. Server ids bring back the temporary-id mapping table that D-8 deleted.

**Rejected — validating shape but not time.** The shape check alone stops case 1 and neither of
the other two. The expensive failure is the poisoned cursor, and only the time bound prevents it.

**Reversibility:** free now, impossible later. Validation added after the first bad row still
leaves the bad row, and the row is a primary key referenced by `mentions`, `reactions` and
`channel_members.last_read_message_id`.

### D-34. Channel visibility is a second branded context, not a discipline

`WorkspaceContext` (`ARCHITECTURE.md` §7.3) makes the tenant filter structural, and D-21 argues
why: a rule that must hold on every endpoint forever will erode if it depends on remembering.
Authorization in this product has **two** axes, and only one of them got the treatment.

The second axis is channel visibility — private channels and DMs — and it was left to call
sites. Two endpoints specified today leak because of it:

- `GET /api/workspaces/:workspaceId/search` is scoped by `workspace_id` alone, so any member can
  search inside private channels and other people's DMs.
- `GET /api/workspaces/:workspaceId/unresolved` is worse: the open-questions view is the
  product's flagship screen and, as specified, it lists every workspace member's private
  discussions.

This is not a cross-tenant leak, but it matches D-21's test for severity exactly — silent,
unbounded, and impossible to un-leak.

**Decided: a second branded type, produced only by a guard.**

```typescript
/** Cannot be constructed by callers. Produced only by the channel guard,
 *  and only after verifying this user can see this channel. */
export interface ChannelContext {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: ChannelType;
  readonly userId: string;
  readonly __brand: unique symbol;
}
```

Channel-scoped repository methods take a `ChannelContext` and apply the filter internally, so a
query that has not passed the guard does not compile — the same mechanism as §7.3, on the axis
that was missing it.

**Workspace-wide reads take a visible-channel set.** Search and the open-questions view ask the
guard for the channel ids this user can see and narrow with `channel_id = ANY($1)`. This is also
faster: it turns a workspace-wide trigram scan into a scan confined to a handful of channels.

**A third mandatory test class**, alongside the cross-tenant 404 of D-21: **intra-workspace
visibility** — a member of the workspace who is not in the channel gets 404, for every
channel-scoped endpoint and for both workspace-wide reads.

**Rejected — filtering at each call site.** That is the model D-21 already rejected in writing,
and it would be rejected here for the same reason, one axis over.

**Rejected — restricting search to public channels.** It closes the leak by removing the
feature; searching your own DMs is a normal thing to want.

**Accepted cost:** the visible-channel set grows with the workspace. At D-25's build target it is
tens of ids and inlines comfortably. Past a few hundred channels per member it becomes a
subquery instead of a parameter — a change of shape, not of design.

### D-35. The message write path is one transaction, and the event is published after it commits

`ARCHITECTURE.md` §5.3 described the send path as `INSERT → publish → ACK`. A message write is
not one statement. It is: insert the message; bump `thread_reply_count` and
`thread_last_reply_at` on the parent; set `channels.last_message_at`; insert `mentions`; insert
`notifications` (including D-29's participants); increment `channel_members.unread_count` and
`unread_mention_count`.

Two things were undefined, and both are correctness issues rather than performance ones.

**1 · One transaction.** All of the above commits together or none of it does. A message that
exists without its mention rows produces a notification that never arrives; a counter incremented
without the message produces a badge for nothing.

**2 · Publish after commit, and ACK after publish.** Publishing from inside the transaction lets
a subscriber receive a message that then rolls back — and because the id is durable and
client-generated (D-8), the receiving client has no way to learn it should forget it. The
`EventBus` call therefore happens after the commit returns, never before.

**Unread counters stay denormalized and stay on the write path.** D-13's reasoning is unchanged.
The increment is one set-based statement — `UPDATE channel_members SET unread_count =
unread_count + 1 WHERE channel_id = $1 AND user_id <> $2` — not a row per member. Concurrent
sends in the same channel run the same plan over the same predicate and therefore take row locks
in the same order, so they serialize rather than deadlock.

**Rejected — write-behind counters.** They are the right answer at some scale and are premature
now. D-25 owns the threshold: if send-path p95 crosses 120 ms and profiling attributes it to
this statement, that is the measurement D-7 requires. Not before.

**Rejected — computing unread with a bounded `COUNT(*)`.** It is defensible and it is a second
mechanism for a fact that already has one. `channel_members.unread_count` is the value; deriving
it somewhere else too is the duplication `OVERVIEW.md`'s ownership rule exists to prevent.

### D-36. Markdown is the only stored representation; the parse-once claim is corrected

`ARCHITECTURE.md` §8.1 justified server-side parsing with "not on every render by every client".
That is not what it delivers. The parser produces `metadata` and `mentions` rows; the rendered
output is not stored, so every client still parses the markdown on every render. The rationale
described a design the project does not have.

**Decided, in three parts.**

**1 · The rationale is corrected, not the design.** Server-side parsing at write time exists for
three real reasons: mentions must be resolved once and stored as rows (D-12, D-29), `metadata`
must be produced once so the feed does not re-derive it, and sanitisation must happen in exactly
one place. Render cost is not among them, and the sentence claiming it is has been removed.

**2 · Rendered HTML is not stored.** The tempting alternative — cache sanitised HTML next to the
markdown and ship a client with no markdown parser — buys roughly 80 KB of bundle and costs a
second representation of the same fact. Every edit, every renderer change and every sanitiser fix
would have to keep two columns in agreement, and the one that drifts is silent. `content` stays
markdown, which is also what search reads (D-10) and what export must produce (D-27).

**3 · The client renders, and memoises.** Rendering is cached per `(message.id, edited_at)`, so a
message parses once per session rather than once per re-render. That is what actually solves the
problem §8.1 claimed to have solved.

**Dependencies are named now, with their costs**, because `CONTRIBUTING.md` §1.12 requires it and §8
was built on libraries no document had chosen:

| Where | Choice | Cost accepted |
|---|---|---|
| Server parse, mentions, sanitise | `unified` / `remark` + a sanitising serialiser | Server-only, so no bundle cost; a heavy dependency tree to audit |
| Client render | a small CommonMark/GFM renderer, no plugin ecosystem | Two parsers to keep behaviourally aligned; covered by a shared fixture suite |
| Syntax highlighting | Shiki with **lazily loaded grammars** | Base bundle ships no grammar; first render of an unseen language waits on a dynamic import |
| Image thumbnails | to be confirmed against Bun in Phase 0 | Native image libraries are the most common Bun incompatibility; finding this in Phase 1 would be expensive, so it is a Phase 0 spike |

**Rejected — one parser shared between server and client.** It removes the alignment risk and
puts `remark`'s tree in the browser bundle, against a 250 KB budget (`PRD.md` §5) that React and
the highlighter already spend most of.

**Rejected — highlighting in a Web Worker by default.** Unchanged from §8.2: for a clamped
12-line block the `postMessage` round-trip costs more than the highlight.

### D-37. Phase 0 gets one explicit open-join variable, because its exit criterion is otherwise unreachable

Phase 0 ends when "two browser tabs, signed in as two different GitHub users, exchange a message
in real time". The Phase 0 endpoint list in `API.md` cannot produce that state: invitations are
Phase 1 (pending O-2), changing a member's role is Phase 1, and `POST /api/channels/:id/join`
already requires workspace membership. The second user has no way in. The phase was defined with
an exit criterion its own scope could not reach.

**Decided: one optional variable, `WORKSPACE_OPEN_JOIN_SLUG`.** When set, any authenticated user
who is not already a member of that workspace is joined as `member` on sign-in. Unset by default,
so an instance is closed unless the operator says otherwise. The boot log states plainly which
workspace is open, because an instance that quietly accepts anyone with a GitHub account is a
thing an operator must not discover by accident.

It is named by slug rather than being a boolean over "the first workspace", because "the first"
is an ordering that nobody chose and that changes as soon as there are two.

The join is audit-logged once `audit_log` exists (D-26, Phase 1).

**Rejected — pulling invitations into Phase 0.** Invitations are an unresolved question (O-2:
email versus shareable link versus GitHub-org auto-join), and answering it under schedule pressure
to unblock a walking skeleton is how a phase boundary stops meaning anything.

**Rejected — seeding the second user with a SQL fixture.** The exit criterion says *signed in as
two different GitHub users*. A fixture proves the message pipe and nothing about the OAuth path,
which is the other half of what Phase 0 exists to prove.

**Rejected — a development-only authentication bypass.** A flag that skips authentication is how
authentication CVEs are written, and it would still not exercise the real path.

**Reversibility:** free. One variable, one branch in the sign-in service. It survives into Phase 1
as a legitimate operator convenience or is deleted; either is a small change.

### D-38. GitHub identity: scopes, the email anchor, and every collision named

D-11 chose GitHub OAuth and made `email` the identity anchor, `NOT NULL UNIQUE`. No document ever
recorded which OAuth scopes are requested, and the default `/user` response omits the address of
any user who has not made it public — which is common among the developers this product is for.
As specified, the first such sign-in violates `NOT NULL` at runtime.

**Decided, with every collision given a defined answer rather than left to discovery.**

**Scopes: `read:user user:email`.** Nothing more. Repository access belongs to the workspace-level
integration token (D-23), not to a member's sign-in.

**Email.** Taken from `/user/emails`, the address that is both primary and verified. If the
account has none, sign-in is refused with `EMAIL_REQUIRED` and a message that says what to fix.

*Rejected: making `email` nullable.* It is the anchor Phase 2's magic links resolve against
(D-11); an account with no anchor cannot be linked later without exactly the guessing D-5 refused.

**Email collision — same address, different `github_id`.** Refused with
`ACCOUNT_EMAIL_CONFLICT`. **Never linked silently.** D-5 already identified "same email via two
providers, therefore the same person" as a classic account-takeover surface and deferred magic
links partly because of it; the same reasoning applies between two GitHub accounts.

**Username.** `users.username` is GitHub's `login`, refreshed on every sign-in and display-only —
identity is `github_id`. GitHub allows an account to be renamed and the freed name to be taken by
someone else, so a refresh can collide with a live row. The incoming user is stored with a numeric
suffix and the collision is logged. Historical mentions are unaffected: `mentions` rows reference
a user id, resolved by the parser at write time (D-12).

**Erasure interaction, which neither D-22 nor D-27 covered.** An erased user keeps their
`github_id` under D-27 as written, so signing in again would upsert onto the erased row and
resurrect an account the person asked to have removed. **Erasure therefore also clears
`github_id`.** A later sign-in creates a fresh account, which is what the person asked for. The
column is nullable already (D-11) and `UNIQUE` permits multiple `NULL`s, so no schema change
follows. Invariant I-11 is extended accordingly.

**Reversibility:** the scopes and the email rule are free to change before the first sign-in and
expensive afterwards — a stored anchor that turns out to be wrong is a migration over live
accounts.

---

## Part D — Open, deliberately

Recorded so they are not silently assumed. None block Phase 0.

- **O-1 · Message editing.** Edit window, history retention, and how an edited message that has
  already been quoted in a resolved thread behaves. *Decide in Phase 1.*
- **O-2 · Invitations.** Email invite vs. shareable link vs. GitHub-org-membership auto-join.
  Depends on D-11's Phase 2 outcome. *Decide in Phase 1.*
- ~~**O-3 · Retention & export format.**~~ **Closed by D-27:** retention is an opt-in
  per-workspace window that defaults to infinite, erasure is two deliberately separate
  operations, and export is NDJSON plus the attachment blobs. Implementation is Phase 2; the
  decision is no longer open.
- **O-4 · Rate limiting.** The earlier draft specified 5 frames/sec/user via Redis. With Redis
  removed (D-7), in-process limiting is sufficient for one node but resets on restart.
  *Decide when the limiter is written, Phase 1.* D-25 adds the `RateLimiter` seam so that a
  shared implementation is later an adapter rather than a refactor — but the seam does not decide
  the number, which is what this question is about.
- **O-5 · Scroll virtualization.** Inline expandable threads produce variable-height rows,
  which is the hardest UI problem in the product. `UX.md` §6 fixes the Phase 1 stance —
  ship **unvirtualized** with a 50-message window — and the scroll-anchoring rules that hold
  either way. What remains open is whether to adopt virtualization at all, decided against the
  `< 100ms` channel-switch budget. *Measure first.*
