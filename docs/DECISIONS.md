# Purlay — Decision Record (`DECISIONS.md`)

> **Status:** Approved 2026-09-07. Amended 2026-09-09 (D-25 – D-53; D-1, D-24 and D-28
> rewritten when the product gained a cloud offering). Binding.
> This file is the SSOT for *why*. `PRD.md` says what, `ARCHITECTURE.md`/`SCHEMA.md` say how.
> Every decision below closes a question that was previously ambiguous or self-contradictory
> across the earlier drafts. Nothing here is inherited from those drafts unchallenged.

Legend: **D-n** = decision. Each records the choice, the reason, what was rejected, and the
cost of reversing it later.

---

## Part A — Product Identity

### D-1. Purlay ships two ways: self-hosted open source, and a cloud we operate

Amended 2026-09-09. The original decision said *not a SaaS* and ruled out billing, metering,
trials, support and an uptime commitment. That is no longer the plan, and this decision is
rewritten rather than patched — everything downstream of it was written against the old answer.

**Four audiences, in priority order:**

1. **Dogfood** — the maintainer's own team replaces Slack with it. Still the only audience whose
   opinion can *kill* a feature. A feature the dogfood team will not use does not ship because a
   prospect asked for it.
2. **Cloud customers** — teams who pay us to run it. They fund the work and they set the
   reliability bar, but they do not get to add surface area the tenets refuse (D-2).
3. **Self-hosting community** — teams who run it themselves, for free, forever. Not a funnel and
   not a lesser tier: they are the distribution channel and the reason the product is trustworthy.
4. **Portfolio** — the codebase is a work sample. Drives code quality standards.

**No open core.** Everything the cloud runs is in this repository under the same licence. There
is no paid tier of features held back from self-hosters, and there never will be — the only thing
the cloud sells is *that we operate it*: backups, upgrades, monitoring, incident response and
somebody to email. Crippling the free product to sell the paid one would destroy audience 3, and
audience 3 is what makes audience 2 believe the data is portable.

The billing and metering modules live in the same repository, ship disabled by default, and are
inert in a self-hosted deployment.

**Consequences — things we now DO build, and did not before:** subscription billing and invoices ·
usage metering · a trial or free tier · transactional email · a support channel · a status page ·
backups with point-in-time recovery · incident response · an on-call expectation · a data
processing agreement and a subprocessor list (D-28).

**Consequences — still refused:** a sales-led enterprise motion · multi-region infrastructure ·
open core · a SOC 2 or ISO programme *until a customer contractually requires one*, at which point
it is a business decision and not an engineering preference (D-28).

**The cost, stated plainly because the original decision warned about it.** D-1 previously
rejected paying customers on the grounds that it *"would force ~40% of the engineering budget into
non-product work."* That estimate was not wrong; it is now **accepted rather than avoided**.
Billing, email deliverability, uptime, backups and support are real engineering, and they compete
with the product for the same hours. Phasing exists to keep that cost from arriving before there
is a product worth charging for: **nothing in this list is built before `v0.2.0` ships and the
dogfood team has stayed off Slack for thirty days.**

**The size of the business is itself a decision.** This is a small, sustainable operation funded
by people who would rather not run a database — **not a growth-stage SaaS**. That is a constraint,
not modesty, and it forbids things a venture-funded competitor would do: no sales team, no
enterprise motion, no upsell pressure on self-hosters, no usage-based pricing designed to grow
with a customer's success, and no feature held back to create an upgrade path (D-43). The cloud
exists to pay for the work and to serve the persona in §1.1 who wants the product without the
server. If it ever needs to grow faster than that, the honest move is to revisit this decision in
writing rather than to let the pressure leak into the product.

**Rejected — a separate hosted fork.** Two codebases diverge, and the divergence always lands on
the free one. One repository, one schema, feature flags where behaviour genuinely differs.

**Reversibility:** shutting the cloud down is cheap — the self-hosted product is the whole product
and survives untouched. Adding the cloud later would have been cheap too; multi-tenancy (D-3) was
retained precisely to keep this door open, and that bet paid.

---

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

---

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

---

### D-4. Four phases, each gated on a demonstrated exit criterion, plus a permanent non-goal list

Work is phased, and each phase ends on something **demonstrated**, not on a ticked task list:
Phase 0 proves the pipe works end to end, Phase 1 gates on the owner's own team switching (S-1),
Phase 2 on a stranger self-hosting it (S-2), Phase 2.5 on the cloud earning a second month (S-3),
Phase 3 is polish.

**Why phase at all:** the earlier drafts had no phases, so every feature was implicitly due at
once — which is how a solo side project produces a monorepo scaffold and no working chat.

**Why a permanent non-goal list, separate from "later":** deferring a feature invites it back
every time someone has a free afternoon. Refusing it permanently is what makes the "subtract
before adding" tenet (D-2) enforceable rather than aspirational.

> **Single source of truth:** phase contents live in `PRD.md` §4. The permanent non-goal list
> lives in `PRD.md` §6. The task-level breakdown lives in GitHub Issues (D-32). This decision records
> only *why the shape is this way* — it deliberately does not restate them.

---

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

---

### D-6. Direct messages are workspace-scoped

A DM is a `channel` with `type = 'direct_message'` and a real `workspace_id`. It has no name;
membership defines it. The tenant guard (`where workspace_id = ...`) therefore holds with **no
exceptions**, which is what makes it enforceable.

**Fixes:** the `UNIQUE(workspace_id, name)` constraint that would have collided on the second
DM — `name` becomes nullable, and uniqueness is enforced by a partial index that applies only
to named channels. A separate unique index on the sorted member pair prevents duplicate DMs.

---

### D-7. Real-time fan-out is in-process for now, behind an interface

Phase 0–2 run a single API process. Fan-out is an in-memory topic registry. All publish/
subscribe goes through one `EventBus` interface so that swapping in Redis/Valkey for Phase 3
is a single adapter, not a refactor.

**Rejected:** Redis from day one. It buys nothing on one node and adds a service to install,
monitor and reason about during the phase where velocity matters most.

**Also decided:** presence and typing indicators are **ephemeral and in-memory**. They are
never persisted and are allowed to be wrong after a restart.

**Amended 2026-09-09.** The cloud (D-1) cannot run on one process with an uptime commitment, so
the shared adapter is no longer a Phase 3 contingency — it is required before the cloud carries
paying customers. **The self-hosted product is unchanged and stays broker-free**: a team of thirty
on one box will never need it, and making them install Redis to use free software would be a
betrayal of the third audience. One interface, two deployments, and the decision to run a broker
belongs to whoever operates the instance.

---

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

---

### D-9. Soft delete never cascades

`messages.parent_id` becomes `ON DELETE RESTRICT`. The previous `ON DELETE CASCADE` directly
contradicted the stated soft-delete policy: hard-deleting a parent would have silently
destroyed an entire resolved thread — exactly the knowledge loss Purlay exists to prevent.

Deleting a message sets `deleted_at` and clears `content` to a tombstone. Threads survive
their parent. Hard deletion happens only via an explicit operator-run purge job.

---

### D-10. Search is honest and scoped

- ~~Text search config becomes **`simple`**, not `english`.~~ **Removed by D-40:** the next bullet
  drops the `tsvector` entirely, so no text search configuration is left to choose. The reasoning
  survives as *why full-text search went away* — English stemming folds `getUserById` into one
  unsearchable token and is actively wrong for Turkish content.
- The generated `tsvector` column and its GIN index are **dropped for Phase 1**. A GIN trigram
  index alone covers substring and identifier lookup.
- Search is scoped: within a workspace, optionally within a channel, newest-first, paginated.
- The performance claim is removed. Trigram GIN on a hot table costs 3–10× the content size
  and slows every insert — we are not trading message-send latency (the actual wedge) for
  search speed.

Real code search across repositories is a **different product**. Not in scope.

---

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

---

### D-12. Notifications are explicit and quiet by default

New tables: `mentions` (parsed at write time, one row per mentioned user) and `notifications`
(delivery + read state).

- Only direct `@username` mentions and DMs generate a notification.
- `@here` / `@channel` are **rejected by the parser**, not merely discouraged. This is the
  "zero-noise" tenet made structural rather than cultural.
- Phase 1 delivers in-app only. Web Push is Phase 2. **We will state plainly that Phase 1
  goes silent when the tab is closed** — pretending otherwise would fail dogfooding on day one.

---

### D-13. Unread counts are denormalized

`channel_members` keeps `last_read_message_id` **and** a maintained `unread_count` /
`unread_mention_count`. Computing unread with a `COUNT(*)` per channel on every sidebar render
is the N+1 the project rules already forbid.

---

### D-14. Desktop is Phase 3, and the memory target is replaced

**Amended 2026-09-09 by D-51**, which settled what the desktop and mobile clients *are*: one
client in a shell, with the bar at polish rather than platform nativeness. Native Swift clients
are not planned, and mobile is an installable progressive web application rather than the separate
"mobile client" this phase list originally implied.

The `<35MB idle` figure is removed from all documents. It is the footprint of an empty Tauri
shell; a React 19 app with a tokenizer and a live socket inside WKWebView realistically idles
at 80–150MB. A requirement that fails on first measurement teaches the team to ignore the
documents. Replaced by D-17.

---

### D-15. Deep Work is a server-side state, not a client toggle

Previously `is_deep_work_active` existed in the schema with no definition anywhere.

**Defined:** when active for a `workspace_member`, the server **suppresses notification
delivery** (rows are still written, so nothing is lost and a digest is possible later); the
client silences sounds and badges. It is stored server-side precisely so it holds across
devices and so the *server* stops pushing — a purely client-side mute would still wake a phone
in Phase 2. Optional auto-expiry timestamp so it cannot be left on forever.

---

### D-16. Attachments ship in Phase 1

A chat tool you cannot paste a screenshot into is not usable, so this cannot be deferred.

- New `attachments` table, linked to a message.
- Storage behind an S3-compatible interface: MinIO locally, any bucket in production, local
  filesystem for the simplest self-host.
- Per-file limit lowered **50MB → 25MB**. Images are downscaled and thumbnailed on upload.
- Per-workspace quota enforced, because self-hosters pay for the disk.

---

### D-17. Performance budgets that can actually be measured

The earlier drafts asserted `<35MB idle memory` and `sub-millisecond` search. Neither was
achievable, and neither was measurable as written. A requirement that fails on first
measurement teaches the team to ignore the documents — which is worse than having no
requirement at all.

**Decided:** every performance claim is replaced by a falsifiable budget with a number, a
percentile where one applies, and a stated measurement condition. Anything that cannot be
enforced in CI does not belong in a document.

> **Single source of truth:** the budget table lives in `PRD.md` §5.

---

### D-18. Client data ownership is split, deliberately

- **TanStack Query** owns HTTP/server state: hydration, channel lists, history pages, search.
  Direct `fetch` inside `useEffect` is prohibited.
- **Zustand** owns real-time and optimistic state: the live message buffer, pending sends,
  presence, typing, socket status.

The boundary: *if it arrives over HTTP it belongs to Query; if it arrives over the socket or
hasn't been sent yet, it belongs to Zustand.* Query's cache is updated from socket events.

---

### D-19. "Local-first" is dropped as a claim

The earlier `OVERVIEW.md` called Zustand "local-first optimistic state". Zustand lives in
memory — closing the tab loses everything. The accurate term is **optimistic**, which is what
we are building. Genuine local-first (IndexedDB persistence, offline queue, sync/merge on
reconnect) is a large, separate undertaking and is **not planned**.

---

### D-20. Stack confirmed, and its costs written down where they can be seen

Keeping Bun + ElysiaJS + Kysely + PostgreSQL + React + Vite + Tailwind + Zustand. Each is
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

**Amended 2026-09-09 — versions, and the one choice that got riskier.**

**Target the latest stable major and say so.** The documents said PostgreSQL 16, released in 2023.
The target is **PostgreSQL 18** (released 2025-09-25, supported to 2030-11), and everything else
is pinned to its current stable line. *Which* line each one is on is not written here — that is
the manifest's answer, and D-56 removed the copies. A stack table with a version nobody checked is
how a project arrives at launch three majors behind; a stack table with a version nobody
*installed* is how it arrives believing things it never ran.

**TypeScript 7 compiles the code; the TypeScript 6 API serves the linter. Both are checked.**

The naive reading is that these are alternatives. They are not — `typescript-eslint` hard-fails on
TypeScript 7 (`typescript-eslint does not support TS 7.0`), and its own error message points at the
side-by-side setup TypeScript 7 shipped for exactly this. Verified rather than assumed:

```
devDependencies: {
  "@typescript/native": "npm:typescript@…",          // provides `tsc`
  "typescript": "npm:@typescript/typescript6@…"      // provides `tsc6` and the 6.0 API
}
```

The exact pins are in `package.json`, which is the only place they are. `tsc` gates the build.
`require('typescript')` resolves to the 6.0 API, so
`no-floating-promises` and the `no-unsafe-*` family — the entire mechanism D-47 rests on — keep
working. Neither is given up.

**The cost, and it is real: two type systems are now in the toolchain.** The compiler that gates
the build and the one the linter reasons with can in principle disagree, and TypeScript 7 aims at
behavioural parity rather than guaranteeing it. That risk is made *detectable* instead of accepted:
**CI typechecks with both**, so a disagreement is a failed build rather than a confusing lint
result. This is the same move as every other decision in D-47 — a risk that is checked is not a
risk that is remembered.

**ElysiaJS, measured.** D-20 called it the highest-risk choice and never ran it. It was run on
2026-09-09 (`docs/spikes/elysia.md`): it typechecks under both compilers, lints clean under the
full strict rule set, and needed **nothing loosened**. One finding goes on the risk row rather than
into nobody's head — **its own published `.d.ts` files produce 104 errors under this project's
strictness**, so its compatibility is contingent on `skipLibCheck: true`. That flag stays on: it
says "we do not typecheck other people's shipped declarations", which is ordinary and is not an
escape hatch of ours. What is not ordinary is not knowing, and now it is written down. The Hono
trigger is unchanged and now has a real data point beside it rather than an intuition.

**Trigger to collapse back to one compiler:** `typescript-eslint` supporting TypeScript ≥ 7.1
(upstream issue 10940). At that point the alias, the second typecheck and this paragraph all go.

**Something has to watch for that.** A written trigger nobody checks is a wish, so dependency
updates arrive weekly as grouped pull requests that pass the same gate as everything else
(`.github/dependabot.yml`). That is also what keeps *target the latest stable major* true six
months from now rather than only on the day it was written.

*Noted, not adopted:* PostgreSQL 18 ships a native `uuidv7()`. D-8 requires the **client** to
generate the id so the optimistic row and the durable row share one value, so the server function
is not used — but the column type and ordering assumptions are now backed by the database's own
implementation rather than only by ours.

**ElysiaJS is now the highest-risk choice in the stack, and it stays.** §2 already accepted
"smaller community, docs move fast". That was a cheap cost for a side project and is a real one
for a service with an uptime commitment (D-1). It stays because the end-to-end type safety in
`ARCHITECTURE.md` §1 is built on Elysia's TypeBox integration, and no equivalent exists elsewhere.
**Hono is the written fallback** — it runs on Bun, has far wider deployment, and is runtime-
agnostic. **Trigger:** if a security fix or a Bun-major compatibility fix is unavailable for more
than four weeks, the ingress layer moves. It is one layer by design (`ARCHITECTURE.md` §1, tenet
3: protocols are adapters, not architecture), which is what keeps that move survivable.

**Named because the documents required the behaviour and never named the tool:** `pino` for the
structured JSON logging `ARCHITECTURE.md` §10 mandates (D-44).

---

### D-21. Testing floor, with tenant isolation as the non-negotiable

Inherited from the owner's standing engineering rules, with one addition specific to this
project: **every workspace-scoped endpoint carries a cross-tenant test asserting 404.**

Why that one is singled out: tenant isolation is the only defect class here that is silent,
unbounded and unrecoverable. A slow query gets noticed; a leaked message does not, and cannot be
un-leaked. It is also the rule most likely to erode, because it must hold on *every* endpoint
forever — so it is enforced by a type (`ARCHITECTURE.md` §7.3) and verified by a test, never by
remembering.

**404, never 403:** a 403 confirms the resource exists, which is itself a disclosure.

> **Single source of truth:** the required test matrix lives in `ARCHITECTURE.md` §10, and lives
> there only.
>
> **Amended 2026-09-09.** This decision used to sanction a copy — `CONTRIBUTING.md` §5 restating
> the matrix in imperative form, with a rule for which won when they disagreed. A sweep found the
> two had already drifted by six rows. A conflict rule is not a substitute for having one copy; it
> is an admission that drift is expected. `CONTRIBUTING.md` now points here and keeps only the
> discipline around the tests: write it first, verify by running it, and fix a violation rather
> than waiving it.

---

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

---

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

---

### D-24. AGPL-3.0, with a contributor licence agreement

Amended 2026-09-09. The original decision chose MIT, and its reasoning was explicit:
*"D-1 explicitly gave up commercial ambition, so AGPL would guard revenue we have decided not to
pursue."* D-1 no longer says that. The premise changed, so the conclusion is re-derived rather
than defended.

**Decided: AGPL-3.0 for the whole repository, plus a CLA on every outside contribution.**

**Why AGPL rather than MIT, now.** With a cloud offering, MIT permits anyone to take this code and
run it as a competing paid service with no obligation of any kind. That was an acceptable trade
when there was no revenue to defend. It is not one now.

**Correcting an error in the original reasoning.** The old D-24 rejected AGPL because *"a
meaningful number of companies ban AGPL dependencies outright."* That is true of **libraries
linked into a company's own product** — and Purlay is not a library. A company running Purlay
internally is not conveying it to anyone and incurs no AGPL obligation whatsoever. The old
decision applied a library-shaped cost to an application, and overstated it as a result. The real
adoption cost is much smaller than it claimed.

**Why the CLA is not optional.** The old decision already noted that *"a project can relicense
forward while it has a single copyright holder. Once outside contributors hold copyright it
requires their agreement."* That is exactly the window we are standing in. Without a CLA, the
first merged outside pull request permanently ends the ability to dual-licence — which is the
mechanism by which a customer who cannot accept AGPL buys a commercial licence instead. The CLA is
set up **before** pull requests open in Phase 2 (`README.md`).

**What AGPL does not do, said plainly.** It does not prevent a competitor from hosting Purlay. It
requires them to publish their modifications, which deters most and stops none. Preventing
competing hosting outright requires a non-compete licence, and that is the next entry.

**Precedent worth naming:** this is the shape Plausible Analytics runs — AGPL source, an
affordable managed offering, no open core, explicitly not chasing growth. It is the closest
analogue to what D-1 describes, and it works.

**Rejected — MIT and Apache-2.0.** Both leave the cloud entirely undefended. Apache's patent grant
is genuinely better for corporate adopters, but that is not the axis that matters here.

**Rejected — BSL or another fair-source licence.** It is the strongest commercial protection and
it would work. It also means the project can no longer honestly call itself open source, and
`README.md`, `PRD.md` §2 and D-1's third audience all rest on that word. Trading the community
that makes the product credible for protection against a competitor who does not yet exist is the
wrong side of that trade.

**Reversibility:** forward relicensing stays possible only while copyright is consolidated. The
CLA is the thing that keeps it true, which is why it ships before contributions open.

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

**Amended 2026-09-09.** The ceiling is no longer hypothetical for one of the two deployments.
The cloud (D-1) is multi-tenant and carries an uptime commitment, so it crosses into multi-node
territory by obligation rather than by measurement, and the three triggers above now describe
*when the self-hosted single node stops being enough* — which for a thirty-person team may be
never. **Two deployments, one codebase:** the cloud runs several nodes behind a sticky load
balancer with the shared adapters; a self-hoster runs one process with the in-process ones, and
nothing about that path gets harder because the cloud exists.

---

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

---

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

**Amended 2026-09-09 — who sets retention differs by deployment.** Self-hosted, it stays exactly
as above: infinite by default, and the operator opts in on disks they pay for. In the cloud the
disk is ours, so retention becomes an attribute of the plan — the mechanism is identical
(`workspaces.retention_days`), only the person who sets it changes. **The tenet survives on the
side where it was made**: a self-hoster is never told what to throw away. And under D-28 the cloud
now *performs* erasure as a contractual obligation rather than documenting how an operator would.

---

### D-28. In the cloud we are the processor; a self-hoster remains their own controller

Amended 2026-09-09. The original decision said the project processes nobody's data and would not
publish a DPA. That was correct for MIT-licensed software somebody else runs. It is **wrong for a
service we operate**, and the two cases now have to be answered separately.

**Two postures, one document set.**

**Cloud — we are a data processor.** The customer is the controller of their team's messages; we
process on their instructions. That is a contractual relationship, so it needs the contract:

- A **data processing agreement**, offered as standard terms and signable without negotiation.
- A **subprocessor list** that is real and maintained — hosting, object storage, transactional
  email, payments, error tracking. Customers are notified before one is added.
- **Retention and erasure become obligations we perform**, not runbooks we hand over (D-27).
- **Breach notification** with a stated timeline, and a record of processing activities.
- Data residency is single-region and stated up front, because D-1 refuses multi-region.

**Self-hosted — the operator is the controller and we are not a party at all.** Unchanged from the
original decision: the project processes no personal data and signs nothing. What ships is what an
operator needs to write their own contract — a **data map** (every table holding personal data,
what it holds, why, how long), a **retention runbook**, an **erasure runbook**, and a statement
that the project itself has no subprocessors.

**Certification.** Still not a programme, and still not an engineering preference: a SOC 2 or
ISO 27001 effort begins when a customer contractually requires one and is budgeted as the business
cost it is. Starting one speculatively is exactly the non-product work D-1 phases against.

**Rejected — one posture covering both.** A single document that tries to describe our obligations
and the self-hoster's at once would be wrong in both directions: it would promise self-hosters
guarantees we cannot give about their own server, and it would let cloud customers think our
obligations end at documentation.

---

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

---

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

---

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

**Amended 2026-09-09.** "Gated on demand" now has a concrete demander: a cloud customer (D-1)
with an identity provider will ask, and will be paying. The gate is unchanged — it is built when
someone actually asks — but the expectation is that it arrives sooner than Phase 3. This is also
the point at which D-11's hand-rolled session layer stops being the obvious choice: a library that
owns OIDC is worth a dependency, and `better-auth` is the current candidate. `lucia`, a plausible
alternative when D-11 was written, has since been deprecated.

---

### D-32. Work is tracked in GitHub Issues and Projects

**Decided: GitHub Issues for the unit of work, a GitHub Project board for the view.** One issue
per task; the milestone is the version it ships in, and carries that version's exit criterion.

**`docs/ROADMAP.md` is retired.** It held the same task list the issues now hold, and keeping
both would have been the duplication `OVERVIEW.md`'s ownership rule exists to prevent — the copy
that drifts is always the one nobody is looking at. Its two unique facts moved: the *working
rule* (a task is done when typed, tested and documented; a milestone is done when its exit
criterion is demonstrated) went to `CONTRIBUTING.md` §7, and the "not on this roadmap, ever"
list was already only a pointer to `PRD.md` §6.

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
3. **S-4 is an access criterion.** A reviewer needs a URL that opens without an account.
4. **`CONTRIBUTING.md` §1.11 applies to us too.** Operating a DevOps platform — backups,
   upgrades, TLS — to track a few dozen issues for a team of one is the complexity this project
   refuses everywhere else.

**What would reverse this:** OneDev wins if Purlay stops being GitHub-native (D-23 and the Phase 2
feeds leave scope) **and** the repository stays private permanently (S-2 and S-4 are abandoned).
Both together describe a different product, so that is a `PRD.md` change and not a tooling choice.

**Rejected — issues in a Markdown file:** it is what the roadmap already is, and it cannot show
what is in flight.

`CONTRIBUTING.md` §8 is unchanged and still binding: **no issue or ticket reference appears in a commit
message.** Linkage lives in the pull request body, where it belongs.

---

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

**Amended 2026-10-09 (#21): how the offset is measured.** The client takes the offset from the first
`PONG`, as the paragraph above says, and places the server's `ts` at the **midpoint** of the round
trip — the two directions are not measured separately, so the midpoint is the least biased guess. It
is taken once and kept: a later sample would only move the clock mid-session, and a message already
in the list was made against the earlier value. A `PONG` that arrives before its `PING` was sent is
refused rather than averaged in. **Rejected — the lowest-latency of several samples:** more accurate
by a few tens of milliseconds, against a window of 65 seconds; the accuracy buys nothing the window
does not already forgive.

**Rejected — generating ids on the server.** It removes the problem and the benefit together:
D-8's entire payoff is that the optimistic row and the durable row share one id, so the message
never moves in the list. Server ids bring back the temporary-id mapping table that D-8 deleted.

**Rejected — validating shape but not time.** The shape check alone stops case 1 and neither of
the other two. The expensive failure is the poisoned cursor, and only the time bound prevents it.

**Reversibility:** free now, impossible later. Validation added after the first bad row still
leaves the bad row, and the row is a primary key referenced by `mentions`, `reactions` and
`channel_members.last_read_message_id`.

**Amended 2026-10-08 (#198): the window guards new ids, not the retry of a stored one.** It was
checked before the idempotency lookup, so an outbox drained after a long disconnect — the retry
D-8 exists for — had its stored message refused as `INVALID_MESSAGE_ID` and marked failed. An id
outside the window that matches the sender's own row in the same channel now returns that row. Any
other id outside the window — a stranger's stored id, the sender's own in another channel, or one
never used — is refused with the same body after the same one query, so the window still admits no
new row and the late path is not an oracle.

---

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

---

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

---

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

---

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

**Amended 2026-10-08, when it was built — two cases the paragraphs above did not decide.**

*A slug with no workspace behind it is not an error.* It is the expected state at first: the operator
signs in, then creates the workspace. Refusing sign-in would lock out the operator; refusing to boot
would make the variable impossible to set before the workspace exists. So sign-in proceeds and nobody
is joined. The cost is that the first person to create a workspace with that slug owns it, and the
boot notice says exactly that rather than leaving it to be discovered.

*Signing in never changes a membership that exists.* The join is an insert that does nothing on
conflict, not an upsert. An upsert would write `member` over the owner on their next sign-in, and with
one owner that breaks I-2 from an endpoint that has nothing to do with roles.

The boot notice is written directly to standard output, because the structured logger is #127; it
moves there with it.

---

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

### D-39. Browser and transport security posture

The documents specified `state` verification, an HttpOnly cookie and a hashed session token, and
stopped there. Four surfaces were never covered, and one of them is built in Phase 0.

**1 · `Origin` is validated on the WebSocket upgrade. Phase 0.**
`SameSite=Lax` does not reliably protect a WebSocket handshake — a page on another origin can open
`wss://…/ws` and the browser may attach the cookie. That is cross-site WebSocket hijacking, and it
hands an attacker a live authenticated socket. The upgrade therefore rejects any request whose
`Origin` is not `APP_URL`, before the session is even looked up.

**2 · CSRF is defended by `SameSite=Lax` plus an `Origin` check on state-changing requests, not by
a token.** Every mutation is `POST`/`PATCH`/`PUT`/`DELETE` with `Content-Type: application/json`,
which a cross-site form cannot produce, and CORS is restricted to `APP_URL` with credentials. A
token would add a mechanism without adding a guarantee. The OAuth `state` cookie stays signed and
short-lived, which is a different problem with a different answer (`ARCHITECTURE.md` §7.1).

**Amended 2026-10-09 by D-80:** this was promised and not built on HTTP (#234). It is now: `POST`,
`PUT`, `PATCH` and `DELETE` are refused with `FORBIDDEN` unless `Origin` equals `APP_URL`'s, logout
and logout-all included; an absent `Origin` is judged by `Sec-Fetch-Site`. "CORS is restricted to
`APP_URL`" stands corrected by D-61: there is no CORS at all, one origin.

**3 · Attachments are served defensively. Phase 1.**
A user-uploaded SVG or HTML file served from the application's own origin is stored XSS, and D-16
already routes downloads through the API. So: `Content-Disposition: attachment` for everything
that is not an image we re-encoded ourselves, `X-Content-Type-Options: nosniff`, a restrictive
`Content-Security-Policy` on the response, and the stored MIME type is never echoed back for
`text/html` or `image/svg+xml` — SVG uploads are rasterised or refused, never served as SVG.

**4 · The image proxy is a hardened fetcher, not a `fetch()` call. Phase 1.**
`ARCHITECTURE.md` §8.1 says external images are proxied, in one line, with no definition. A proxy
that will fetch any URL a message contains is an SSRF endpoint pointed at the internal network.
It resolves DNS first and refuses any address outside public unicast ranges, follows no redirects,
caps bytes and wall-clock time, sends no credentials, and re-encodes what it returns.

*Rejected: not proxying, and rendering remote images directly.* It leaks every reader's IP address
to whoever hosts the image, which in a private team chat is worse than the SSRF risk we can
actually contain.

**5 · A content security policy baseline. Phase 1.**
`default-src 'self'`, no `unsafe-inline` script, images from `'self'` and the proxy only. It lands
with the content pipeline, because that is when there is user-controlled markup to constrain.

**6 · `ENCRYPTION_KEY` is AES-256-GCM.** A random 96-bit nonce per record, stored as a prefix on
the ciphertext, with the record id as additional authenticated data. `CONFIG.md` named the key and
never named the algorithm, which is how two call sites end up encrypting differently.

**Reversibility:** items 1 and 6 are free now and expensive after the first session and the first
stored token. The rest arrive with the features they protect.

---

### D-40. The database is created with a deterministic collation, and `citext` is dropped

Migration `0001` runs in Phase 0, and two identifier rules in `SCHEMA.md` quietly depend on the
locale the operator happened to pass to `initdb`.

`idx_channels_unique_name` is `UNIQUE (workspace_id, lower(name))`. In PostgreSQL, `lower()`
follows the collation of its argument. Under a Turkish locale `lower('İ')` does not produce `i`,
and `I`/`ı` fold differently than they do under `C`. **Channel-name uniqueness would therefore
depend on how the server was provisioned** — the same two names could collide on one deployment
and coexist on another. For a product that will run on machines we do not control *and* in a cloud
we do, that is not acceptable.

**Decided: identifier columns carry an explicit `COLLATE "C"`** — `channels.name`,
`workspaces.slug`, `users.username` and `users.email`. Byte-wise, deterministic, identical
everywhere. Message `content` keeps the database default; linguistic ordering never applies to it,
and trigram matching is unaffected.

**`citext` is dropped.** The extension existed only for `users.email`, and it lowercases using the
database locale — the same defect one column over. Email becomes `TEXT COLLATE "C"`, normalised
(trimmed and lowercased as ASCII) at the application boundary before it is ever stored or compared.
One fewer extension, and `CONTRIBUTING.md` §1.12 prefers exactly that.

**`/health/ready` asserts the expected collation**, so a mis-provisioned database fails at startup
rather than at the first colliding channel name.

**Also settled: the vestigial text-search line in D-10.** D-10 said the search configuration
*"becomes `simple`, not `english`"* and then dropped the `tsvector` column and its index entirely.
With no `tsvector` there is no text search configuration at all. The sentence is removed; the
trigram index is the whole story.

**Rejected — leaving it to documentation.** "Create the database with `LC_COLLATE=C`" in an
operator guide is a rule that holds until somebody uses a managed provider that does not offer it.
A column-level collation travels with the schema.

**Amended 2026-10-09: what a name may contain (second-round attack).** Identifier text handling had
a collation and no alphabet: `{"name":"a\u0000b"}` on a workspace or channel was a `500` and an error
report, because PostgreSQL cannot store a NUL and the contract did not say so (message content did).
A **`name`** format now refuses, at the contract, in workspace and channel names: every control
character (C0, DEL, C1 — a name is one line, so tab, line feed and carriage return too), the line
and paragraph separators, a lone surrogate, and the **bidirectional embeddings, overrides and
isolates (U+202A-202E, U+2066-2069)**. Bidi controls are refused rather than normalised because a
name is an identifier people read and compare by eye: an override makes one name display as another
(`gpj<RLO>exe.txt`), and an unclosed isolate reorders what follows it in the sidebar. The
directional *marks* (U+200E/200F) stay, because a right-to-left name in a left-to-right interface
needs one. A **`plain-text`** format covers a channel topic: multi-line is fine, what PostgreSQL
cannot store is not. A workspace slug already was a whitelist (`^[a-z0-9][a-z0-9-]*$`) and never
held any of this — tested. GitHub's `name` is not refused (sign-in never fails on a value GitHub
controls, #233): the same set is *removed* and an emptied name falls back to the login.

---

### D-41. The interface ships in English and Turkish, with no i18n library

**Decided: real internationalisation from the first screen, built on `Intl` and typed message
catalogues rather than a framework.**

Waiting is the expensive option: Phase 0 builds the client, and retrofitting translation means
touching every component that ever rendered a string.

**The mechanism.** One catalogue module per locale, a `Messages` type generated from the English
catalogue so a missing or misspelt key is a **compile error**, and the platform's own `Intl` for
everything that varies: `Intl.PluralRules`, `Intl.DateTimeFormat`, `Intl.NumberFormat`, and
`Intl.RelativeTimeFormat` for the *"last 12m ago"* strings `UX.md` §3 specifies. Only the active
locale's catalogue is loaded; the other never enters the bundle.

**Why no library.** `PRD.md` §5 fixes the initial bundle at 250 KB gzipped, and React, the markdown
renderer and the highlighter already spend most of it. The runtime this needs is a lookup and a
formatter call. Compile-time key checking is stronger than what most libraries provide, and
`CONTRIBUTING.md` §1.12 prefers a web standard over a dependency. **Lingui is the named fallback**
if message extraction from source becomes the bottleneck — that is a tooling problem, and adopting
it later does not change the call sites.

**Locale selection** follows `navigator.language`, is overridable, and persists in
`localStorage` — per device, no schema. A `users.locale` column arrives with Web Push (Phase 2),
because that is the first user-facing text the *server* generates and the first time the choice
has to follow the person rather than the browser.

**Message content is never translated.** Only the product's own chrome. Translating what people
wrote to each other is not a feature, it is a misunderstanding.

**Accepted cost, stated because it is real.** Two catalogues means every new string is two edits
and the Turkish one will lag. The compile error stops a *missing* key, not a *stale* one.
Turkish text also runs longer than English, so layouts are built to wrap rather than to fit.

**Related:** the Turkish locale is exactly why D-40 pins the database collation. The interface
language must never reach identifier comparison.

---

### D-42. The cloud stays shared-database multi-tenant

A paid cloud raises a question a single-team self-host never had to answer: does every customer get
their own database, their own schema, or a row-level tenant column in one database?

**Decided: unchanged — one database, `workspace_id` on every scoped table, isolation enforced by
`WorkspaceContext` and `ChannelContext` (D-21, D-34).**

**Why not a database per customer.** Every migration would fan out across every customer database,
and a migration that fails on customer 40 of 200 leaves the fleet in two different schema versions
— which is the failure mode that ends small teams. It also breaks D-3 outright: one identity across
workspaces is not expressible when the workspaces live in different databases.

**Why not a schema per customer.** The same migration fan-out, plus connection-pool pressure that
grows with the customer count, for isolation that a row filter already provides.

**The cost we are accepting, and it is the largest one in this document.** With shared tenancy the
blast radius of an isolation bug is *every customer at once*. That is precisely why D-21 makes the
cross-tenant test mandatory on every endpoint, why D-34 added the second axis, and why both are
enforced by types rather than by review. Those two rules stop being hygiene and become the thing
the business rests on.

**Noisy neighbours** are handled by limits that already exist — per-workspace storage quota (D-16)
and the connection rate limiter (D-25's `RateLimiter` seam) — extended with a per-workspace query
budget **only if a measurement shows one customer degrading another** (`CONTRIBUTING.md` §1.11).

---

### D-43. Cloud pricing is per workspace, not per seat, and sold through a merchant of record

**Per-workspace pricing, with a generous included seat band.** D-2 lists *cost* as one of the four
axes Purlay competes on, and `README.md` says it in the first paragraph: no per-seat cost. A cloud
that then charges per seat would contradict the product's own headline and hand every reader a
reason to distrust the rest of it. Charging by workspace keeps the claim true: **adding a
teammate never costs more**, which is a real differentiator against Slack rather than a slogan.

*Rejected: per-seat pricing.* It is the obvious model and it is the one that makes the positioning
a lie.

**Sold through a merchant of record** — Polar, Lemon Squeezy or Paddle — rather than Stripe
directly. Selling software to teams worldwide from a Turkish entity means EU VAT, UK VAT, US sales
tax nexus and invoicing rules in each. That is not engineering; it is a permanent compliance load
on one person, and D-1 already accepted enough non-product work. A merchant of record becomes the
seller and absorbs it.

*Accepted cost:* a higher percentage than Stripe, less control over the checkout, and a dependency
on a smaller company than Stripe. **Trigger to revisit:** when the fee delta over Stripe's rate
exceeds the annual cost of tax compliance tooling and an accountant, migrate. A number, not a
feeling (D-17).

**Priced to be boring.** The number covers infrastructure, the merchant-of-record fee and the time
to operate it, with enough margin to fund development — and not more. D-1 fixed the size of this
business deliberately, and pricing is where that decision either holds or quietly stops holding.
The target customer is a team that finds Slack expensive; arriving with a price they also find
expensive would be an odd way to compete on cost (D-2).

**Metering is per workspace and per month**, and the numbers that matter are already columns:
`storage_used_bytes` (D-16) and the member count. No new usage-tracking subsystem.

---

### D-44. Operating the cloud: backups, observability and incidents

D-1 previously refused all of this. It is now the product, so it gets specified rather than
improvised at the first outage.

**Backups.** Point-in-time recovery on PostgreSQL, plus object-storage versioning. A stated RPO and
RTO, published to customers. **A restore is tested on a schedule and the test result is recorded**
— an untested backup is a belief, not a backup.

**Observability.** `ARCHITECTURE.md` §10 already fixes structured JSON logging with a request id
and a never-logged list; the library is `pino`, named here because §10 required the behaviour and
no document named the tool. Added for the cloud: error tracking with a Sentry-compatible client,
external uptime monitoring against `/health/ready`, and a public status page.

**Self-hosters get the same instrumentation, disabled by default and pointing nowhere.** No
telemetry is collected from a self-hosted deployment, ever — D-1's third audience exists because
the operator owns the data, and phoning home would end that.

**No metrics stack yet.** Logs, health checks and error tracking answer *is it up* and *what
broke*. A time-series stack answers *how is it trending*, which nobody is asking until there are
customers to trend. `CONTRIBUTING.md` §1.11 applies to us.

**Incidents.** A written severity scale, a status-page update before a root-cause analysis, and a
public post-incident note for anything customer-visible. Written now, while it is cheap and
nobody is angry.

---

### D-45. The Kysely types are generated from the applied migrations, not written by hand

`SCHEMA.md` §10 said the types were *"hand-written to match the SQL above"*, guarded by a
schema-drift test. That is a copy plus a test that the copy still agrees — and the first storage
rule of this project, and the first architectural principle it was written under, is that a shape
defined twice will diverge. Testing for the divergence is weaker than not having the second copy.

It is also weaker than it looks. A drift test compares what it was taught to compare. A column
that is nullable in SQL and non-nullable in the type, a `BIGINT` typed as `number` instead of
`string`, a default that makes a column `Generated<T>` — each is a real defect the test only
catches if somebody thought to check for it.

**Decided: `packages/db/src/schema.ts` is generated by `kysely-codegen` against a database with
every migration applied, and the generated file is committed.**

- **The migrations are the single source.** The types are derived, so drift is not detected, it is
  *impossible*.
- **The file stays committed** so that `typecheck` and an editor work without a running database,
  and so a cold CI run does not need one to compile.
- **CI regenerates and requires an empty diff.** This replaces the drift test with a stronger
  assertion: not *do these two agree on the things we checked*, but *is this file exactly what the
  migrations produce*.
- **The hand-written niceties survive as declared overrides**, not as hand-maintained columns:
  `CreatedAt`, `UpdatedAt` and `Json<T>` are configured on the generator, in one place.

**D-20's rejection of an ORM does not apply.** Drizzle and Prisma were refused for putting a layer
between the application and SQL *at runtime*. Code generation runs at build time and leaves the
query builder untouched: we still write SQL and joins by hand.

**Rejected — hand-written types with a drift test.** The current plan. It accepts a copy and pays
for a test to police it, which is the exact trade `OVERVIEW.md`'s ownership rule tells us not to
make.

**Rejected — not committing the generated file.** It makes a live database a prerequisite for
typechecking, which breaks the editor, slows every cold CI run, and turns a five-second feedback
loop into a thirty-second one. Feedback loops that get slower get skipped.

**Accepted cost:** the generator's output shape is now something we depend on, and a major version
of it is a migration of its own. In exchange, an entire defect class disappears.

**Reversibility:** free today, since neither the migrations nor the types exist yet.

---

### D-46. Integration tests run against a real database, in a transaction, rolled back

`ARCHITECTURE.md` §10 requires integration tests against real PostgreSQL and real migrations, and
never said how they are isolated from each other. That gap decides whether the suite is fast and
trustworthy or slow and flaky, and it constrains the service signatures — so it is settled before
the first service is written, not after.

**Decided: one transaction per test, rolled back at the end. Nothing is truncated and nothing is
re-seeded.**

The consequence is architectural and is why this cannot wait: **every service and repository takes
its executor as an argument** — a `Kysely<Database>` or a `Transaction<Database>`, indistinguishable
to the caller. A service that reaches for a module-level database handle cannot be tested this way,
so the rule is enforced by the same lint boundary that enforces the layering.

**Where a transaction cannot work**, a **template database** is cloned per test file instead:
anything that commits on purpose, the realtime tests that need two connections to observe each
other, and anything touching advisory locks. Cloning a template is milliseconds; migrating a fresh
database per file is not.

*Amended 2026-10-09 (D-77): the template-database clone is also where a write that must commit is
tested — atomicity of a multi-write request, which a rolled-back transaction cannot observe.*

*Amended 2026-10-09 (#246): a hook has five seconds, and the harness must stay far inside them. The
template is built once per process by a preload (`bunfig.toml` → `packages/db/src/testing-preload.ts`),
outside every timer, so a clone is a `CREATE DATABASE` and nothing else. Every `DROP DATABASE` makes
the server run a checkpoint, and the checkpoint costs what the run has written: a file that made
thirteen databases (the migrator's) spent its `afterAll` on thirteen checkpoints and the CI job failed
with "a beforeEach/afterEach hook timed out", twice in a run. Reproduced on a disk throttled to 8 MB/s
(`docker run --device-write-bps`): 2 hook timeouts per full run before, 0 in 10 runs after. So: a test
that only needs to break the schema does it in a rolled-back transaction (readiness), one that needs
a place of its own for the migrator takes a schema, and a clone is for what must commit. A guard in
`harness.integration.test.ts` holds template build, clone and drop to budgets (2.5 s, 1 s, 1 s;
measured 0.12 s, 0.03 s, 0.01 s on a laptop).*

*Built 2026-10-08, with the first file that needed it (#31): `cloneIntegrationDatabase` in
`packages/db/src/testing.ts`. The template is `<database>_template`, and it is migrated on every
clone — a no-op when current, and the only thing stopping a template left by an older run from
hiding a migration added since. The clone is dropped in `afterAll`.*

**Rejected — truncating tables between tests.** Slower, and it leaves sequence state and ordering
coupling behind, which is how a suite starts failing only when run in a different order.

**Rejected — a mocked database.** D-21 already requires the real thing. Half of this schema's
correctness lives in partial indexes, CHECK constraints and foreign keys; a mock asserts that our
misunderstanding of them is self-consistent.

**Flaky tests are a defect with a deadline.** A test that fails intermittently is quarantined the
day it is noticed and either fixed or deleted within one working day. A suite people learn to
re-run is a suite that has stopped being a gate, and every enforcement decision in this document
rests on the gate holding.

---

### D-47. A rule that is not mechanically enforced is not a rule

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
generator is still the wrong size; a **list** of mutations is not. `scripts/mutations.ts` holds
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
`modules/messages/replay.ts` (`replaySince`), and the router sends what it returns. The two
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

---

### D-48. Escape hatches are expensive and visible, not closed

D-47 made the stated rules fail the build. It did not close the hatch that makes all of them
optional:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const parse = (x: any) => x;
```

Nothing stopped that. A ban with an unrestricted bypass is a suggestion, and the cost is not
theoretical — it is the days someone spends later removing `any` and ignore comments one file at a
time, long after the reasoning behind each has been forgotten.

**Decided: the hatch stays open, and is made expensive enough that nobody uses it casually.**

- **Every `eslint-disable` carries a rule name, a description and a linked issue.** No blanket
  disables, no file-level disables. The issue is what turns an exception into a countable, ownable
  piece of debt instead of an anonymous one.
- **An unused disable is an error.** When the code changes and the exception stops being needed,
  CI says so. The debt cleans itself up rather than accumulating.
- **`@ts-expect-error` follows the same rule** and is preferred over `@ts-ignore`, which stays
  banned: `@ts-expect-error` fails once the underlying error is gone.
- **A `TODO` or `FIXME` without an issue number is a lint error.** An unowned TODO is unowned debt.
- **Dead code is debt.** `knip` runs in CI: an export nothing imports is either wired up or
  deleted, not left for later.

**Rejected — banning disable comments outright.** It sounds stricter and is worse. A genuinely
unavoidable case — a third-party type that is wrong — pushes people to loosen
`eslint.config.mjs` instead, and a rule quietly weakened for the whole repository is far more
expensive than one line marked as an exception. The goal is not zero exceptions; it is **zero
invisible exceptions**.

**Accepted cost:** filing an issue for a one-line exception is friction. That is the point. The
friction is what makes the count stay near zero.

**Amended 2026-10-09 (#136).** The `knip` bullet was written and not run; it now is. `knip` 6.39.0
runs in `bun run verify` and in CI's `verify` job, and `verify:enforcement` plants an unused export
to show the build go red (`docs/spikes/knip.md`). Its first run found 19 things: ten exports and one
dev dependency were deleted or made private, and the exceptions are the whole of `knip.jsonc` —
three scripts run by shell inside a container, and the browser's realtime client, which nothing
imports until the client store lands (#26). Each carries a reason and an issue; none is a
`knip` ignore setting. Delete the realtime entry when #26 merges.

---

### D-49. Deterministic budgets block; noisy ones block on regression

`PRD.md` §5 lists seven performance budgets and calls every one CI-enforceable. **None was being
measured.** That is precisely the failure D-17 was written to prevent, reproduced by the document
that contains D-17.

They do not all have the same measurement maturity, and treating them identically is how the whole
gate loses credibility.

**Blocking, measured on every pull request:**

| Budget | Why it can block |
|---|---|
| Initial JS bundle, gzipped < 250 KB | A single deterministic number from a build. It does not vary between runs. |
| API idle RSS < 120 MB | Measured by starting the process and reading it. Stable enough to threshold. |

**Blocking on regression, not on an absolute threshold:** ACK round-trip p95, fan-out p95, cold
load, channel switch, keystroke→paint. Each is recorded per commit and compared with the previous
measurement; a **jump** fails, a number near the line does not.

**Why not threshold everything.** A p95 latency measured on a shared CI runner moves by tens of
percent between identical runs. Make that blocking and within two weeks the team is saying "flaky,
re-run it" — and that habit does not stay confined to one check. It spreads to the whole gate, and
then nothing is enforced. **A gate people learn to re-run has already stopped being a gate.**

**The bundle budget is the urgent one and it is architectural.** The markdown renderer, the
syntax highlighter and the i18n approach are all still unchosen (D-36, D-41), and 250 KB is the
constraint that decides them. Measuring after they are wired in is sitting the exam with the
answers already written.

**This is also the honest answer to why the incumbent is heavy.** Slack is not slow because of how
it renders; it is slow because of how much it ships and how much it holds. The remedy is these two
numbers, enforced from the first build — not a different rendering architecture (D-50).

---

### D-50. The client stays a single-page application, with a prerendered shell

Making load speed a first-class constraint reopens the question D-20 settled: React + Vite as a
single-page application, or server rendering.

**Decided: it stays an SPA, and the shell is prerendered to static HTML at build time.**

**Why not server rendering.** This is chat: people leave it open all day. A cold load happens once;
interaction latency happens thousands of times, and the product's central promise is an
interaction one — *keystroke → your own message painted, under one frame, never awaiting the
network* (D-17). Server rendering does not improve that and it fights the model the whole client is
built on: the Zustand optimistic buffer, ACK reconciliation and reconnect replay (D-18) all assume
the client owns this state, and a hydration boundary is where that assumption breaks.

**What the prerendered shell buys.** The application frame — sidebar, channel header, message-list
skeleton — is real HTML in the initial response, so the first paint is immediate and the JavaScript
fills it rather than creating it. Most of what server rendering would have bought for a
logged-in-all-day product, at none of the architectural cost.

**Cold load is met by shipping less, not by rendering elsewhere:** route-level code splitting,
lazily loaded highlighter grammars (D-36), one locale catalogue (D-41), and the budget in D-49
that fails the build when any of that slips.

**Trigger to revisit:** if the cold-load budget cannot be met with code splitting and a prerendered
shell, server rendering returns to the table — with a measurement behind it. Switching now would
trade a proven interaction model for an unmeasured fear.

---

### D-51. Desktop and mobile are the same client in a shell, and the bar is polish rather than nativeness

The quality bar was set by naming two groups: Vercel, Supabase and GitHub for interface quality,
and Microsoft, Adobe and Google for the macOS and iOS applications. Those halves pull apart, and
the tension is worth recording rather than resolving quietly.

**None of the three interface exemplars ships a native macOS application.** Vercel does not.
Supabase does not. GitHub Desktop is a web technology shell. They reached that interface quality
partly *because* they concentrated on one client. Adobe, on the other side, has tens of thousands
of employees.

**Decided: one client, wrapped. The bar is polish, not platform nativeness.**

- **Desktop:** the Tauri shell already scheduled for Phase 3 (D-14) — a real application bundle, a
  dock badge, a global shortcut, native notifications, remembered window state.
- **Mobile:** an installable progressive web application. iOS has supported installation and web
  push since 16.4, which covers what a chat client actually needs.
- **Native Swift clients are not planned.** Not "later" — not planned, until a measurement says
  otherwise.

**Why this is a decision and not a deferral.** Polish and nativeness look like the same road with
different lengths, and they are not. Native clients require a second design system, a second
release channel, App Store review, platform expertise and permanent maintenance — and they require
choosing that **now**, because it changes how the API contract and the design system are shaped
from the first component. Deciding it in Phase 3 is not deciding it; it is discovering that the
first two phases were built for something else.

**Said plainly: a web-technology shell does not feel native, and it will not.** That is exactly why
Teams is criticised on macOS. This decision accepts that trade in exchange for one client that is
excellent, which is the trade the interface exemplars all made.

**Trigger to revisit:** paying customers asking for it, with numbers. At that point it is a
business decision with revenue behind it (D-1), not an engineering preference.

**Consistent with:** D-1's stated size — a small operation funded by its users — and D-2's
*subtract before adding*. Three clients maintained by one person is the most reliable way to have
three mediocre clients.

---

### D-52. The frontend architecture: constraint, evidence and friction

`UX.md` specifies behaviour beautifully and says nothing about how the code is shaped. Interface
quality of the kind named as the bar is not produced by taste applied repeatedly; it is produced by
**having few choices, checking the result, and making novelty cost something**.

**1 · Constraint — one source for every visual value.**

Design tokens (colour, spacing, type scale, radius, shadow, motion duration and easing) are
declared once and consumed through Tailwind's theme. **A raw value in a component is a lint
error** — `CONTRIBUTING.md` §4 already forbids arbitrary Tailwind values, and this extends that
rule to the whole vocabulary. What makes an interface look designed rather than assembled is not
inspiration; it is the absence of a way to be inconsistent.

**2 · Primitives — headless, for the five things that are genuinely hard.**

Dialog, menu, combobox (the command palette), tooltip and popover. Focus management, focus
trapping, ARIA wiring and keyboard semantics are where hand-written components fail **silently**:
they look correct and are unusable with a screen reader, while `PRD.md` §5 states accessibility as
a requirement.

**Radix**, verified rather than assumed: actively published, one package per primitive so only what
is used ships, which matters against D-49's budget. **Amended 2026-09-09 — it is four primitives,
not five.** Radix publishes no combobox; `@radix-ui/react-combobox` does not exist, which was found
by installing them rather than by re-reading this paragraph. Dialog, menu, tooltip and popover are
real and were built against; the command palette is **O-7**. *`@base-ui-components/react` was the obvious
modern alternative and is **deprecated at release-candidate stage** — checked, not remembered.*
Everything outside those five primitives is written here: a button that pulls in a dependency is a
dependency that owns your button.

**3 · Evidence — the interface is checked, not admired.**

- `axe` on every component and every screen, in CI. A stated accessibility requirement with no
  check is not a requirement.
- A **keyboard-path test per screen**: every action reachable by mouse is reached by key, because
  `UX.md` §7 says the product is keyboard-first and that claim needs an owner.
- **Visual regression snapshots.** The only mechanical way to notice an interface breaking
  quietly. Its maintenance cost is real and accepted; the alternative is finding out from a user.

**4 · Friction — a new primitive must justify itself in the pull request.**

Exactly what `CONTRIBUTING.md` §1.12 does for runtime dependencies, applied to components.
Interfaces do not decay by a bad decision; they decay by fifty reasonable ones, each adding a
variant nobody consolidated.

**Testing shape:** `bun test` with `happy-dom` and Testing Library for component logic and
accessibility; Playwright for keyboard paths, visual snapshots and the cold-load measurement
D-49 needs. Two tools with two jobs, not two tools doing one job.

**Rejected — a component library with opinions** (a full design system package). It brings a visual
identity that is not ours and a bundle we do not control, and the interface is the product's face.

**Rejected — no primitives at all.** Hand-writing a combobox with correct ARIA and focus behaviour
is a fortnight, and it will still be wrong in a way nobody notices until somebody using a screen
reader tries the command palette.

---

### D-53. "Production-ready" is a per-screen definition of done, not a phase

The requirement was stated directly: no output that feels like a prototype, production quality from
the beginning. Read as scope that would contradict D-4's phasing and sink the project. Read
correctly it is a **quality bar per unit of work**: phase order decides *what* ships, this decides
*what shipping means*.

`UX.md` §8 already says it — *"an unhandled empty state is an incomplete feature, not a polish
item"* — and nothing checked it. Prototype feel has specific, mechanical causes, so each gets a
mechanism rather than an intention:

| What makes it feel unfinished | What prevents it |
|---|---|
| Default browser styling on form controls | Tokens and primitives; a raw value is a lint error (D-52) |
| Inconsistent spacing and type sizes | One scale, no arbitrary values |
| Missing loading, empty or error states | A test per screen asserting all four states render (`UX.md` §8) |
| Invisible or default focus ring | `axe` plus the keyboard-path test; `outline: none` is a lint error |
| Animation that is arbitrary or absent | Duration and easing are tokens; `UX.md` §9 keeps motion near zero |
| Text that overflows or truncates badly | Visual snapshots at narrow and wide widths |
| Icons of mixed weight and size | One icon set, one weight, sized from the type scale |
| A screen that only works in one theme | Snapshots in **every theme that exists** — one until light arrives in Phase 2 (`UX.md` §9), both after |

**No screen is merged with a state unhandled.** Not "styled later" — `UX.md` §8 names the empty,
loading and error state for every view already, so a screen missing one is missing specified
behaviour, not polish.

**What this does not mean.** It does not mean building Phase 1 features during Phase 0. The walking
skeleton ships *few* screens; each is finished. A small excellent product is what the interface
exemplars in D-51 all are.

---

### D-54. A context is branded by a module-private symbol key, and asserting one is a lint error

D-21 and D-34 make isolation structural: a scoped repository takes a context the caller cannot
construct. `ARCHITECTURE.md` §7.3 originally wrote that brand the way it is usually written:

```typescript
readonly __brand: unique symbol;
```

It type-checks as a declaration and is **uninhabited**. In property position `unique symbol` names
a symbol no expression has — not a fresh `Symbol()`, not another `unique symbol` — so *nothing*,
including the guard, can produce a value of the type without an assertion. The mechanism would have
shipped with its escape hatch at the one place that must not have one, and every compile-time proof
that "a caller cannot forge a context" would have passed vacuously: nobody could make one at all.

The brand is a property keyed by a symbol its own module does not export:

```typescript
const tenancy: unique symbol = Symbol('WorkspaceContext');

export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly [tenancy]: true;
}
```

Naming that key is the capability, and it stays in the file that verifies the membership row. A
plain object is rejected for a missing property; a `Symbol('WorkspaceContext')` declared elsewhere
is rejected as a different symbol. The type is inhabited exactly once, by the guard.

**Rejected: a class with a private field.** `class WorkspaceContext { #brand }` is nominal too, but
it turns a value that only ever travels between functions into a runtime construct — a constructor
to keep private, an instance that stops surviving serialization — and buys nothing the symbol key
does not.

**The hole that remains, and what closes it.** No type system refuses `{} as WorkspaceContext`.
Lint does: an assertion to any type whose name ends in `Context` is rejected repository-wide, with
**no exemption**, because the guard builds its context from a literal and never needs a cast —
there is no legitimate case to make room for. The rule matches by name so `ChannelContext` (D-34)
is covered before it is written, rather than on the day somebody remembers to extend a list.
`scripts/verify-enforcement.ts` proves the ban by writing a violation and requiring *that rule* to
be the one that rejects it.

**Amended 2026-10-09 (#183): the local object store is Garage, not MinIO.** The pinned MinIO images
can no longer be pulled — Docker Hub answers *repository does not exist* and quay.io has no manifest —
so `bun run db:up` failed on any machine without them cached, and CI had stopped starting them. Three
S3-compatible stores were run against the operations Phase 1 attachments need (`docs/spikes/object-storage.md`):
**Garage** and **RustFS** passed all of them, including a 25 MiB multipart write and a refused
anonymous read; SeaweedFS did not, on one attempt, and was not pursued.

**Decided: Garage.** 11 MB image and about 7 MB of memory at rest, against 106 MB and 120 MB for RustFS.
It is AGPL-3.0, the licence this project already ships under, and is maintained by a non-profit
association rather than a company that can change terms — the failure that created this issue was a
vendor ceasing to publish. The cost is a bootstrap: its image has no shell, so the cluster layout, the
bucket and the development key are created by `scripts/storage-init.sh` (idempotent), where MinIO
needed a compose sidecar.

**Rejected — RustFS.** The simplest to run (environment variables, one container), Apache-2.0 and
under active development, but its first stable release is three weeks old as of this entry. Worth
revisiting if Garage's bootstrap proves a burden to self-hosters; the application depends only on the
S3 API, so the switch is a compose change. **Rejected — SeaweedFS:** an unresolved signature error
with the configuration tried, which may be the configuration and not the software; a rejection resting
on one attempt is recorded as that.

**Reopened when** Garage misses an S3 operation the upload path needs, or stops publishing images.

---

### D-55. Bun workspaces are the build orchestration; there is no task runner

The stack table listed **Bun workspaces + Turborepo** and accepted "Turborepo config is another
thing to maintain" as its cost. Nothing was ever installed: there is no `turbo.json` and no `turbo`
in any manifest. The table described a repository that does not exist, which is worse than either
choice — a reader following it looks for a file that is not there, and a claim nobody checks is a
claim that stays wrong.

Resolved by deciding rather than by installing. **Bun workspaces are the orchestration.** Five
packages, one `tsc --build` that already caches incrementally through project references, and a
pipeline whose longest job is under a few minutes: a task graph and a remote cache have no defect
class to justify them here. It is the argument D-47 makes against DDD ceremony, one layer down.

**The trigger, named rather than implied.** Add one when the pipeline repeats work it has already
done — concretely, when `verify` exceeds five minutes locally or a CI job exceeds ten, and the
cause is rebuilding unchanged packages rather than the work itself growing. Until then the
orchestration is a shell `&&`.

**Rejected: installing it now to make the document true.** Configuration written before there is
anything to cache is configuration nobody can evaluate, and it would have to be maintained through
every packaging change in the meantime for a benefit measured at zero.

---

### D-56. A version is a fact, so it lives in the manifest and nowhere else

`ARCHITECTURE.md` §2 named versions alongside choices: *Bun 1.4+*, *PostgreSQL 18*, *React 19*. Two
of the three were bound to reality by a test. The third was not, and could not be — nothing had
installed React, so there was nothing to bind it to. The table was asserting a fact about a
repository it had never looked at.

That is the general shape, not an accident of one row. A version in a document is a **copy**, and
the copy is the one that goes stale silently: this project already carried *PostgreSQL 16* for
months after deciding to move, and D-55 found *Turborepo* named in the same table with nothing
installed at all.

**So §2 names choices and never numbers.** `check-docs.py` already refused a version outside its
owners; `ARCHITECTURE.md` has simply stopped being one. `DECISIONS.md` keeps the exemption because
it records dated history — *"the documents said PostgreSQL 16"* has to remain sayable — and the
changelog by definition.

**And every dependency is pinned exactly.** The repository was mixed: `eslint` exact,
`kysely` caret, with no rule written down for which was which. A caret range is the polite form of
*I do not know which version this is*; the lockfile knows, but a lockfile is a consequence, and a
pass from a differently-resolved tree is "green in one state is not green" one layer down. An exact
pin turns an upgrade into a commit CI judges — which is what the weekly grouped Dependabot pull
requests already are. `workspace:*` is exempt: it is not a range, it names a package in this
repository and cannot resolve to anything else.

**Rejected: generating the table from the manifests.** It would be accurate, and it would still be
a second thing to read that adds nothing — the manifest is already legible, and a generated copy
is a copy whose generator has to be maintained. **Rejected: a rule for which dependencies are
pinned and which are ranged.** Two policies separated by a line nobody remembers is how the
repository got into this state.

---

### D-57. A choice that has not been run is not a choice

Three defects in a row had one shape. D-54: the branded type `ARCHITECTURE.md` §7.3 specified was
uninhabited — it could never have compiled. D-55: Turborepo was in the stack table and had never
been installed. D-56: the table named a web framework version while nothing had installed the
framework. Each was written down as decided, and each was a guess.

The count, taken before fixing it: **19 rows in the stack table, 6 of which had ever been run.**
One of the remaining thirteen did not even name a package — *"a small CommonMark/GFM renderer"* sat
there as though it were a choice.

**So a tool enters the stack table on a spike record, not on an argument.** `docs/spikes/` holds
one file per tool, carrying the date, the versions actually resolved, the commands and their real
output, and what had to be **loosened** to make it work. `CONTRIBUTING.md` §6.7 states the rule;
the directory is where the evidence lives.

**"Nothing was loosened" is stated explicitly, never by omission.** Silence there is
indistinguishable from not having looked, and this project already treats absence as
non-evidence (§6.4).

The first two records exist because the two riskiest claims were finally run. Both hold, both
needed nothing loosened, and both **found things the documents did not know**: ElysiaJS's own
declarations produce 104 errors under this project's strictness, so its compatibility is contingent
on `skipLibCheck` (recorded on D-20's risk row); the web skeleton consumes a third of the bundle
budget before a product screen exists; `happy-dom` alone cannot render a component; and `apps/web`
was compiling zero `.tsx` files while reporting success.

**Rejected: installing everything now to make the table true.** Thirteen dependencies nobody uses
yet, each with an upgrade and audit cost, to answer a question a scratch directory answers for
free. The spike produces the knowledge without taking on the debt.

**Rejected: a checklist item.** A box beside "did you actually run it" is the theatre `CONTRIBUTING.md`
§6.2 forbids. The mechanism is that the record has to exist and say what it cost.

---

### D-58. What the client sends refuses what it did not declare

Measured, not assumed (`docs/spikes/elysia.md`): a request body carrying an undeclared property
returns **200**, and the property is silently dropped. TypeBox does not set
`additionalProperties: false` and the server framework does not add it.

That is the silent-swallow class this project refuses everywhere else. A client sending
`roleOverride: "owner"` is told it worked.

**So every shape the client sends is closed**, through one helper in `packages/types` rather than
per call site — including nested payloads, which is where a shallow rule would miss it. The set of
shapes is **derived rather than listed**: the socket frames come out of `ClientFrame` itself, which
by definition is everything a client may send, so a new frame cannot escape by not being added to
a list.

**Responses are deliberately left open.** Adding a field to something we produce must not break a
client that has not been rebuilt. The asymmetry is the point: strict about what we accept, additive
about what we emit.

**Rejected: tolerating unknown fields.** The usual argument is a third-party client on an older or
newer version. There is no third-party client — D-51 ships one client with the server — so the
tolerance would buy nothing and cost a silent failure mode.

---

### D-59. The stack table says what is installed, and a test agrees

D-57 required a spike before a tool enters the table. That stops a *future* guess; it does nothing
about the ones already there. Turborepo sat in §2 for months with nothing installed, and a web
framework version sat beside it while nothing had installed the framework. Neither was catchable,
because the table recorded what the project had **chosen** and nothing compared that to what it
**had**.

**A third column, and it is checked.** A cell names the packages or compose services that make the
row real, and every one is resolved against the manifests and `docker-compose.yml`.

The important half is the other direction. **`not yet` names its packages too, and they must be
absent.** Without that, a row can quietly stay behind after its thing is installed — the same
drift, pointing the other way, and the one nobody would think to look for. `undecided` means no
package has been chosen at all and must cite the issue or open question that will choose it, so a
category cannot sit in the table wearing a decision's clothes.

**It found one immediately.** *"A small CommonMark/GFM renderer"* and *"a sanitising serialiser"*
had no packages to name and nothing watching for the choice. They are **O-6** now.

**Rejected: generating the column.** It would be accurate and it would prove nothing — a generated
column agrees with the manifests by construction, which is exactly the question being asked. The
column has to be **written** and then contradicted by a check, or it is not evidence.

**Rejected: requiring an issue for every `not yet` row.** Most are Phase 1 features whose issue does
not exist yet, and forcing one would create board noise to satisfy a check. The feature that needs
the package installs it; the check only insists the row moves at the same time.

---

### D-60. `last_used_at` is refreshed lazily, and every refusal to resolve looks the same

`SCHEMA.md` §3.2 gives `sessions` a `last_used_at` and says nothing about when it moves. Two
answers were available and neither is obviously right, so it is recorded rather than chosen in
passing.

**Refreshed at most once an hour.** Writing it on every request puts an `UPDATE` on the hottest
path in the system — every HTTP request and every socket upgrade validates a session — to maintain
a column whose only consumer is a device list nobody has built. An hour is precise enough for
*when was this device last seen* and costs one write per session per hour. The resolve already
reads the column, so a stale value is noticed without an extra query.

**Rejected: writing it on every resolve.** Correct, and it turns a read path into a write path at
the exact point the system is busiest. **Rejected: not maintaining it at all.** A column that never
moves is worse than an absent one: it reads as data and is fiction.

**Every reason to refuse produces the same answer.** Expired, revoked, unknown, or belonging to a
user who has been deleted — all resolve to nothing, with no way for the caller to tell which. The
alternative hands an unauthenticated caller an oracle about accounts it does not own: *this token
was real once* is information, and so is *this account was deleted*. It is the same argument as
404-not-403 at the tenant boundary (D-21), one layer earlier.

A deleted user's live session stopping is the part that would otherwise be missed: the session row
is untouched by a soft delete, so without the join it keeps working.

---

### D-61. One public origin, and development is proxied so it matches

`CONFIG.md` says the OAuth callback registered with GitHub is `${APP_URL}/auth/github/callback`.
`APP_URL` is documented as *the public origin of the web client*, and the API is a separate process
— in development on another port, and `ARCHITECTURE.md` §11 listed `api` and `web` as separate
containers. As written, the callback lands on the client, which has no such route. The gap was
found while building the handshake, not by reading, because every document was individually
consistent.

**Decided: the browser talks to exactly one origin.** `APP_URL` is that origin. In production the
API serves the built client from it; in development Vite proxies `/auth`, `/api` and `/ws` to the
API process, so what the browser sees is identical in both.

The documents were already assuming this — the callback sentence only makes sense with one origin
— and three separate rules get simpler by it rather than by accident:

- D-39 requires the socket's `Origin` to equal `APP_URL`. Same-origin makes that an equality rather
  than a list.
- The session cookie is `SameSite=Lax` (`ARCHITECTURE.md` §7.1). Same-origin means that setting is
  the whole story, with no cross-site exception to reason about.
- **There is no CORS at all**, so there is no CORS to misconfigure — which for a self-hosted product
  is a support burden removed rather than a feature lost.

**Development and production differ in the one place bugs are hardest to see.** Cookies, origins
and redirect URIs are exactly what a developer cannot test on a machine whose topology is different
from the deployed one. Proxying makes them the same.

**Rejected: two origins with CORS.** Three more things to get right — the CORS policy, a
`SameSite=None` cookie, and the socket's origin list — each of which fails in a way that looks like
a bug in something else.

**Rejected: a reverse-proxy container in front of both.** It works, and it makes the routing table a
second place that has to agree with the application's own. A self-hoster who has to understand a
proxy before signing in has met the friction `PRD.md` §3 exists to remove.

**Reversibility:** changing to two origins later is configuration plus a CORS layer, not a
migration. Cheap to reverse, which is why it is decided now rather than escalated.

---

### D-62. The state cookie is signed with a key derived from `ENCRYPTION_KEY`

The OAuth `state` cookie must be signed (D-39), and no document named a key for it.

**Rejected: not signing, and comparing the cookie to the query parameter.** Sound only while
nothing else can write a cookie for this origin. A sibling subdomain can, and *cookie tossing*
plus an attacker-chosen `state` is a login-CSRF: the victim ends up signed into the attacker's
account. A signature the attacker cannot produce closes it; a bare comparison does not.

**Rejected: a second secret in `CONFIG.md`.** Every additional key is another thing an operator
generates, stores and rotates — and the failure mode of *one more secret* is the one nobody
rotates.

**Decided: derive it.** `ENCRYPTION_KEY` is the root secret; the signing key is
`HMAC(ENCRYPTION_KEY, "purlay:oauth-state:v1")`. Domain separation means the state signature and
the integration-token cipher cannot interact, and rotating the root invalidates in-flight sign-ins
— a ten-minute window, which is the intended cost of rotating a root secret.

**Corrected 2026-10-08 (#199): the signature does not stop cookie tossing, and the first paragraph
said it did.** An attacker can ask `/auth/github` for a validly signed state of their own, plant that
cookie from a sibling subdomain, and send the victim to the callback with their own code — the victim
is signed into the attacker's account. The signature proves the server issued the state; it cannot
prove the server issued it *to this browser*. What stops the planting is the cookie's name: both the
state and the session cookie are `__Host-`-prefixed, which a browser accepts only from this origin,
`Secure`, with `Path=/` and no `Domain`. The state is also spent by every callback, accepted or
refused, so it cannot be replayed within its ten minutes. The signature stays: it is what keeps a
cookie this server did not issue from being accepted at all.

---

### D-63. Which endpoints need a cross-tenant test is read from `API.md`, not remembered

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

---

### D-64. Every scoped endpoint says where it sits on the visibility axis, and the test follows

D-34 put the second axis in the guard, and the guard was tested — at the guard. Whether each
endpoint actually reached it was proven by one loop, and that loop's stranger was in another
workspace: it crossed the first axis twice and the second never. A private channel was not seeded
anywhere above the guard.

**Decided: the axis is a required field of the case D-63 already demands.** `channel` — it names a
channel, and a workspace member who cannot see it gets the never-existed answer for each of the
three intra-workspace refusals: private and not theirs, a DM they are not in, deleted. `workspace-wide`
— it reads across channels, and no id of a hidden channel may appear anywhere in the response.
`none` — with the sentence saying why. Required means the compiler refuses a case that has not
decided; and a path containing `:channelId` may not choose `none`.

**The control is the same caller on a channel they can see**, not the owner on the hidden one. The
owner differs from the outsider in more than visibility; the outsider differs from themselves only in
which channel the request names. For a workspace-wide read the control runs the other way: the
owner's identical read does contain the hidden ids, so an absence is one the read could have
broken.

**Search and open questions are named, because they are where the leak was found.** Neither is
built. When either is served it must be `workspace-wide`, and neither may be declared `UNSCOPED`;
until then the check holds them by name and fails if either leaves `API.md`, so it cannot pass by
skipping them. That is how the issue's demand on two Phase 1 endpoints is met in Phase 0: not by a
test of something that does not exist, but by a build that will not serve them without one.

**Rejected: seeding hidden channels only when Phase 1 creates them.** The guard is written whole
(`ARCHITECTURE.md` §7.5) so that it is right before the first private conversation exists; a test
that waits for the creating endpoint proves it right only afterwards.

---

### D-65. A replay starts below the cursor, and says when it is not finished

The first test with two real sockets (#31) found two ways §5.4's replay lost messages without
saying so, and a third way the server broke its own contract.

**A cursor is not a watermark.** D-33 accepts an id up to a minute behind the server's clock,
because a laptop that has been asleep has not synced. A message accepted *after* a client stopped
listening can therefore sort *below* the newest id that client holds — and the obvious case is not
a slow clock but a send that sat in its author's buffer while their connection was down. Replaying
`id > cursor` skips it permanently: it is in history, at the place its id puts it, and no reconnect
will ever deliver it.

**Decided: replay from `cursor − REPLAY_OVERLAP_MS`.** The overlap is `behindMs + aheadMs`, derived
from `MESSAGE_ID_SKEW` rather than written, and it is exactly enough: a message accepted at server
time *S* has an id no older than *S* − `behindMs`, and the cursor is no newer than the moment the
client stopped listening plus `aheadMs`. The cost is re-sending up to sixty-five seconds of
messages the client already holds, which a client keyed by id (D-8) discards for nothing.

**A replay longer than a page now says so.** It returned the first hundred messages and an
acknowledgement that read like completion, so a client away for longer believed it had caught up.
The acknowledgement carries, per channel, the page's `nextCursor`; `null` means the present was
reached, and anything else is continued over HTTP with `?after=` — the cursor and the contract every
other page already uses, so there is one way to page, not two.

**And the acknowledgements now match the contract.** `SUBSCRIBE` and `UNSUBSCRIBE` were answered with
an `ACK` whose `data` the declared `AckFrame` does not allow; the router builds frames behind a
cast, so the compiler never saw it. Both have declared shapes now, and the socket tests check every
frame on the wire against `ServerFrame`, so the next one is caught by a test rather than a client.

**Rejected: a server-assigned sequence as the replay cursor.** It is a watermark, and it is the
column D-8 rejected: one counter per channel serialises every insert into it. Commit order is not
even what it would need to be: two concurrent transactions commit in either order.

**Rejected: replaying everything since the cursor, without a page limit.** A client back from a long
weekend would receive thousands of frames in one burst over the socket that §5.5 bounds.

**Rejected: a `received_at` column as the cursor.** It moves the problem rather than removing it — a
transaction that inserts at *T* and commits after *T*+1 is invisible to a reader who has already
moved past *T*+1 — and it costs a column and an index on the hottest table.

---

### D-66. The socket's two limits: a cap the server enforces, and a budget it refuses by frame

§5.5 stated both limits and nothing enforced either (#174).

**The 64 KB cap is server-wide, because the per-route option is ignored.** Measured, with Elysia
1.4.30 on Bun 1.4.2: setting `maxPayloadLength` on the `.ws()` route let a 100 KB frame reach the
handler; setting it on the application let the same frame end the connection before any handler ran,
and a 60 KB frame through. The router's own size check was removed rather than kept beside it: by
the time the router sees a JSON frame the framework has parsed it, so the check measured what had
already been paid for. A connection that sends an oversized frame is dropped, which is the right
answer to a client that ignored a published limit — and the wrong one for a person whose message
is merely long, which is the open question about message length (#190).

**The budget is a token bucket per connection, and over it a frame is refused, not the
connection.** A bucket because §5.5 states a rate *and* a burst, which are exactly a bucket's two
parameters; a sliding window has one. The refusal is an `ERROR` carrying `RATE_LIMITED` and the
frame's id, so the client marks that one send failed and offers a retry, and a resend with the same
id is idempotent (D-8). The budget is spent **before** the frame is parsed: if malformed bytes cost
nothing, they are the cheapest flood there is. The number itself stays open (O-4).

**Rejected: closing the connection over budget.** It turns one burst — a paste of several lines,
each a frame — into a reconnect, a replay and a resubscribe, all of which cost more than the frames
did.

**Rejected: keying the budget by user.** Two tabs would share one budget and starve each other.
The quota a user could multiply by opening connections is bounded by the connection count, which
is an instance-level concern rather than this one.

---

### D-67. A message is at most 16,000 code units, and the limit is proven to fit the frame

Nothing bounded a message (#190). HTTP accepted five million characters; after D-66 the socket
refused a long one by dropping the connection, and a client that resends pending sends on reconnect
would loop on it. A limit nobody chose had become a disconnect nobody could explain.

**Decided: 16,000 UTF-16 code units, in the contract, at both doors and in the database.** Roughly
four hundred lines of stack trace, which `PRD.md` names as what this product's users paste; a
ceiling that also bounds what the trigram index digests per row. `MESSAGE_CONTENT_MAX` in
`@purlay/types` is the one number. The migration repeats it as a `CHECK` because a job, a script or
an import is a writer too, and an integration test fails if the two part. `char_length` counts code
points, never more than code units, so the database refuses nothing the contract accepts.

**The frame cap is the reason for the character rule.** JSON escapes a C0 control character and an
unpaired surrogate to six bytes, so without a rule a message's size on the wire is unbounded relative
to its length, and no length limit could be shown to fit 64 KB. Those characters are refused — none
occurs in text a person typed or pasted; tab, line feed and carriage return are kept — and every
other code unit costs at most three bytes. A test measures that for all 65,536 code units, then
builds the longest, most expensive message as a real frame and weighs it.

**`MAX_FRAME_BYTES` moved into the contract.** A client that does not know the cap learns it by
losing its socket.

**Rejected: a byte limit.** It is what the frame cares about, and not what a person can see; a
composer would have to tell somebody their message is too long in a unit they cannot count.

**Rejected: 40,000, as Slack allows.** It does not fit the frame at three bytes a unit, so it would
mean raising the cap — every connection's worst-case buffer — for the rare message that should have
been an attachment.

**Rejected: refusing only by the database.** A `23514` surfaces as `INTERNAL`; the contract refuses
first, with the field named, at both doors.

---

### D-68. A socket ends when its session does, announced over the bus, not checked per frame

A socket resolved its session on its first frame and kept the answer (#194). Verified against a
running server: after *sign out everywhere* returned 204 and every HTTP request answered 401, the
same socket kept receiving the channel and kept having its sends acknowledged. *Sign out everywhere*
is the capability D-11 chose database-backed sessions for, and a live socket defeated it — the
stolen-laptop case it exists for.

**Decided: the two moments a session ends end its connections.** Revocation writes the session row,
then publishes `SESSION_ENDED` on `session:{id}`, the topic each socket subscribes to when it opens;
the hub delivers the frame and closes the connection with `CLOSE_CODES.SESSION_ENDED`. Expiry is a
timer from `expires_at`. Identity is resolved when the socket opens rather than on its first frame,
so a socket that only listens is reached too.

**Through the bus, because a call reaches one node.** On several nodes (Phase 3) the sign-out lands
on one of them and the socket may be on another. Publishing on a topic is what the shared bus
adapter already carries, so this needs nothing new when that adapter arrives (D-7, D-25).

**The timer is chained.** A JavaScript timer longer than 2³¹−1 ms — about 24.8 days — fires at once,
and the default session lives thirty days: an unchunked timer would have closed every connection the
moment it opened, and every test with a short session would have passed.

**Rejected: re-reading the session on every frame.** It puts a query on the hottest path to answer a
question whose answer changes at two known moments, and it still never closes a socket that only
listens.

**Rejected: closing without announcing.** A client sees an abnormal close, reconnects with backoff,
and is refused by a handshake it then has to interpret. One frame first makes the reason part of the
protocol.

---

### D-69. A subscription costs two queries and a bounded replay, whatever it names

One `SUBSCRIBE` frame could name any number of channels, repeats included, for one rate-limit token
(#196). Each cost its own authorisation — three or four queries — and its own replay of up to a
page; a frame near the 64 KB cap was thousands of queries and tens of thousands of outbound frames,
ten times a second from one connection.

**Decided: bound the frame, and make its cost independent of its size.** At most
`SUBSCRIBE_MAX_CHANNELS` (100), each named once. Authorisation is one query over all of them, all or
nothing: the frame is refused if any is invisible, and nothing is subscribed first. Replay is one
query — `unnest` pairs each channel with its cursor and a lateral subquery reads each range by the
primary key — and the channels share a total of a thousand messages, a full page for one channel
and never fewer than ten each. What does not fit is continued over HTTP from the `nextCursor` D-65
added. A test counts the queries and requires one channel and thirty to cost the same.

**The visibility rule became one query for every entry point.** It had been written three times —
the nested guard, the by-id guard and the workspace-wide list — and the by-id guard swallowed every
error from the membership check into `CHANNEL_NOT_FOUND`, a database outage included, and answered
"never existed" faster than "exists elsewhere". All three now run one query builder: one round trip
whatever the outcome, and nothing caught that was not the guard's own refusal.

**Rejected: charging a rate token per channel.** The bucket's burst is twenty; a reconnect to forty
channels would be refused outright and have to be spread over seconds. The cost belongs in the query
plan, not in the client's patience.

**Rejected: one replay query per channel, run concurrently.** It bounds the latency and not the work:
a hundred queries from one frame still hold a hundred pool connections' worth of time.

---

### D-70. A connection that falls behind is closed to resync, never left open with a gap

§5.5 promised a high-water mark and nothing implemented it (#197). Measured against a reader that
stops reading: the transport answered each send with bytes written, then `-1` (queued), then `0` —
**dropped** — once it held 16 MB for that one connection, and the connection stayed open. The client
missed messages without knowing, and since it was never disconnected it never asked for a replay. A
slow phone on a bad network becomes a person who silently does not see part of the conversation.

**Decided: every frame to a socket goes through the hub, and the hub closes a connection the moment it
cannot be trusted to have everything** — a send the transport dropped, or more than
`OUTBOUND_HIGH_WATER_MARK` (4 MiB) queued. The close is `CLOSE_CODES.RESYNC` (4408), which says
*reconnect*: the client resubscribes with its cursors and D-65's replay fills the gap. A dropped frame
becomes a reconnect, never a hole.

**The mark and the replay are one decision.** A replay is sent as one burst; if it could exceed the
mark, a slow but healthy reader would be closed by its own replay, reconnect, receive the same replay,
and loop. So a replay is bounded in bytes as well as messages — `REPLAY_BYTES_MAX`, 1 MiB, the
thousand-message count alone being up to 48 MB — and a test requires the mark to exceed it plus a
frame. When the byte budget stops a channel, its cursor resumes after the last message sent, or from
its start; a test continues every channel from its cursor over HTTP and requires every message back.

**Measured honestly: loopback cannot show the loop.** A local reader drains faster than any burst
fills the queue, so a socket test passed with the mark set below the replay. That test now claims only
what it shows, and the relation is enforced where it can be.

**The transport's buffer is read through a checked adapter.** Bun has `getBufferedAmount`; the
framework's copy of the socket type does not declare it. A runtime without it refuses the first
connection rather than running every connection without backpressure.

**Rejected: Bun's own `closeOnBackpressureLimit`.** It closes without a code the client can act on, at
a limit the replay budget is not bound to.

---

### D-71. A request's id is carried by the runtime, not passed through every signature

D-47 required a request id that flows through HTTP, the socket and service calls from the first
handler, and warned that threading it through signatures afterwards touches every one (#127).

**Decided: `AsyncLocalStorage`.** Each HTTP request is entered as a scope from the framework's first
hook, each socket frame is run inside one, and the logger reads the id from the scope it is called
in. A service several calls down that has never heard of a request writes lines that carry its id.
Measured before it was relied on: twenty concurrent requests, through `handle()` and a real
listener, never saw each other's scope, and the error hook saw the failing request's
(`docs/spikes/pino.md`).

**Rejected: a context parameter on every service.** It is the cost D-47 named — every signature —
and it is worse than cost: a request is a transport concept, and the layering rule exists so that
nothing below the doors knows one exists (`ARCHITECTURE.md` §4). A parameter would put it into
every module's arguments to serve a logger.

**Rejected: an id only at ingress.** The line a service writes about why it failed is the one an
operator needs to join to the request that caused it.

**The cost** is implicitness: a line's id comes from where it is called, not from what it is
passed. That is the trade every tracing system makes for the same reason, and it is contained in
one module with tests that cross requests on purpose.

---

### D-72. A restart drains: readiness first, sockets told to come back, in-flight work finished

SIGTERM ended the process where it stood (#220). A deploy cut every request in flight, dropped every
socket with an abnormal close its client had to interpret, and kept readiness answering *ready*
until the process vanished. Phase 0's exit criterion is a message that survives a restart; a restart
every client experiences as an outage meets the letter of it and not the point.

**Decided: drain, in an order where each step makes the next safe.** Readiness answers 503 first, so
a balancer stops sending new requests. Every socket is then closed with 1012 — RFC 6455's own
*service restart*, in the contract as `CLOSE_CODES.RESTARTING` — which tells the client to reconnect
and replay from its cursor (D-65), so nothing is lost and nothing is shown as an error. The listener
stops accepting while requests in flight finish; the pool closes; the process exits 0. A deadline of
ten seconds bounds it: a request that never finishes must not keep a restart from happening, and
past it the process exits 1 and writes what was still open.

Tested against a running server with a request deliberately still in flight — a sign-in waiting on
a slow GitHub — which must finish with its redirect while the socket beside it is told to come back.
Stopping abruptly fails that test; not telling the socket fails it too.

**Rejected: a configurable delay before stopping, for the balancer to notice readiness.** Useful
behind a balancer that polls slowly, and a guess about infrastructure this project does not run yet.
It can be added when a deployment measures the need; a delay nobody measured is a slower restart.

**Rejected: closing sockets with 1001 *going away*.** Clients treat it as the end of the page's
life, not as a cue to reconnect. 1012 says exactly what is happening.

---

### D-73. Phase 1 is dogfooded on the team's own server — provisionally, and portably

S-1 gates Phase 1: the team stops opening Slack for thirty consecutive days. That requires the team
to be *using* Purlay during Phase 1, on an instance somebody runs — and the self-host path, with its
operator documentation, is Phase 2 (`PRD.md` §4). Without a decision here, Phase 1 would finish with
nothing to dogfood it on.

**Decided, for now: one server the team already operates.** A single node — the same shape as any
self-hosted instance (D-7, D-25): the API, PostgreSQL and object storage behind one origin with TLS.
What this pulls into Phase 1 is an *internal* deployment, not Phase 2's public one: a container image,
a production compose file, migrations on start, the built client served from the origin, and a
backup that has been restored once. Operator documentation for strangers stays in Phase 2.

**Provisional, and built so changing it is a move rather than a rewrite.** Nothing in the deployment
may assume this server: configuration only through the variables in `CONFIG.md`, state only in the
database and the bucket, no host paths in the application. Moving to a VPS or a platform is then a
matter of where the same image runs.

**Reopened when any of these happens** — watched by whoever owns the deployment issue (#224):
the server cannot give the instance its own TLS origin; dogfooding needs availability the server
does not have (the thirty days of S-1 are not interrupted by the host); a backup cannot be restored
from it; or Phase 2.5's cloud begins, which runs elsewhere by definition (D-44).

**Rejected, for now: a PaaS.** It would answer the hosting question and leave the self-host path
untested by the people writing it; dogfooding on the shape a self-hoster runs is part of what S-1
proves. **Rejected: waiting for Phase 2's self-host path.** S-1 cannot start until something runs.

---

### D-74. A pull request names its task, fits a measured budget, and stays in its area

Scope creep inside a task is how debt arrives unreviewed: asked to fix X, a change also reworks Y, and
the review that would have caught Y is now too large to do properly (#126). CONTRIBUTING said *one
issue, one pull request*; nothing checked it.

**Decided: three rules, run by CI on every pull request** (`scripts/check-pull-request.ts`):

- **It names its task** — `Closes #n`, or `Part of #n` for a task that takes several pull requests.
  Dependabot is the one author excused, its changes being the manifests every task may touch.
- **It fits the budget: 400 changed lines of production code.** Measured, not chosen: of the 32
  pull requests merged before the rule, the largest focused one changed 357; half changed under 120.
  Tests, documents and generated files are not counted — counting tests would charge a change for
  being well tested. Over budget passes only with the `large-change` label, so the size is a decision
  the reviewer can see rather than one they discover.
- **It touches what its task is about.** The issues it names carry area labels, each allowing some
  paths; `infra`, `testing` and `security` are cross-cutting and restrict nothing. A file outside
  every allowed area fails, with no label to wave it through: split the change, or name the issue
  the file serves.

Run against the eighteen pull requests merged that day before it existed, it refused two — both
rightly, each naming its issue only in prose — and passed the rest, dependabot's included.

**Rejected: counting every changed line.** It punishes tests and documents, the two things this
repository most wants a change to carry.

**Rejected: an override label for the area rule.** Being over budget can be a deliberate decision;
touching another area's files under one issue is exactly the bundling the rule exists to refuse.

---

### D-75. Thumbnails are made with the runtime's own `Bun.Image`

D-36 and `ARCHITECTURE.md` §2 left the thumbnail library undecided, with the reason written down:
native image libraries are Bun's most common incompatibility, and finding that out in Phase 1 would
be expensive (#6). The spike (`docs/spikes/image-pipeline.md`) ran three installable libraries and the
runtime's built-in against generated fixtures, on macOS and in a Linux container.

**Decided: `Bun.Image`.** Nothing is installed, so there is no native binary to build in the image, no
platform package to resolve, and no dependency to audit — the cost D-36 expected to pay does not
arise. Orientation is applied and all metadata is stripped from what it writes; a 30000×30000 PNG that
is 2.6 MB on disk is refused by default before it is decoded.

**Three rules the spike earned, which the upload path (#53, #54) inherits:**

- A thumbnail is made with `{ fit: 'inside' }` and one bound. `resize(width, height)` means *exactly
  this size* and stretches.
- An image is valid when it **decodes**, not when its header parses — a truncated file passes
  `metadata()` and fails only when read. That failure is a rejection, not a server error.
- The default `maxPixels` guard is somebody else's default. The upload path states its own bound.

**Rejected — `sharp`.** It works under Bun, and is the more established library. It is also a native
dependency with a prebuilt binary per platform, which is the thing this spike existed to avoid, now
paid for nothing. **Rejected — `jimp`:** pure JavaScript, so portable, and slow enough to matter on a
25 MiB upload with no native fallback. Neither was benchmarked against the built-in, because the
built-in met every requirement; a rejection that rests on cost is stated as such, not as a measurement.

**Reopened when** `Bun.Image` misses a requirement a Phase 1 test finds — an animated thumbnail, a
format it cannot write — or when it breaks on a Bun upgrade. The upload path keeps it behind one
function, so replacing it is a change to that function.

**Reversibility:** free until thumbnails are stored; after that, existing thumbnails stay valid whatever
produced them.

---

### D-76. Reconnect waits in the upper half of each step, and forgives only a connection that held

`ARCHITECTURE.md` §5.4 said *exponential backoff with jitter, capped at 30 s* and left two things
open that decide whether it protects the server: where in the step the jitter lands, and when a
connection counts as having recovered.

**Decided: the delay is drawn from the upper half of the exponential step** — 0.5–1 s, then 1–2 s,
2–4 s, up to 15–30 s. Every client of a server that restarted lost its connection in the same
instant, so without jitter they return in lockstep at each step; with it they spread across half
the step.

**Decided: the backoff starts over only after a connection has stayed open for ten seconds**, not
at the moment it opens. A server that accepts a connection and then drops it — a crash loop, a
proxy refusing after the upgrade — is "successfully connected" every time by the first rule, and
would be retried at the shortest delay for as long as it kept failing.

**A close with `SESSION_ENDED` is not retried.** Reconnecting into it is refused each time and
teaches the user nothing; the application is told the session is over instead (#194). Every other
close — a restart (`1012`), a resync (`4408`), a network drop — is reconnected from, because the
cursor makes the gap recoverable (D-65).

**Rejected — full jitter (any delay from 0).** The most even spread, and it also lets one client
retry at once, repeatedly, against a server that is refusing it. **Rejected — resetting on open:**
above. **Rejected — resetting on the subscription's ACK:** a client watching no channel never
receives one, so its backoff would never recover.

**Reversibility:** free. Nothing is stored; the numbers are one constant each.

---

### D-77. A service that writes twice takes a `Transaction`, and a test can see it fail

`createWorkspace` wrote the workspace and then its owner, `createChannel` the channel and then its
creator, and sign-in the account, the open-join membership and the session, each on the connection
pool. A failure between two writes left a workspace nobody could reach whose slug was taken for
good (I-2). The suite could not have said so: every integration test runs inside one rolled-back
transaction (D-46), which cleans up a half-finished request exactly as an atomic one would be
cleaned up (#232).

**Decided: the boundary is in the signature.** `Atomically` hands its body a `Transaction`, and
`createWorkspace` and `createChannel` accept nothing else, so passing the pool is a compile error
(`@ts-expect-error` in `modules/atomic-signature.test.ts` fails the build if it ever compiles).
`Transaction` differs from `Executor` in the literal type of `isTransaction`; narrowing is by
`instanceof`, not by reading that flag. The handlers open the boundary with `atomicallyOn`, which
still *joins* a transaction it is already inside, so the harness's outer transaction keeps working.
Sign-in's three writes share one boundary for the same reason; moving that orchestration out of the
handler is #245.

**Decided: committing behaviour is tested on a cloned database, by making the second write fail.**
`ingress/http/atomic-writes.integration.test.ts` clones the template database (D-46), installs a
trigger that refuses inserts into the second table, and asserts that the first row is gone and the
retry succeeds. The clone is dropped afterwards, so nothing is left behind and nothing depends on
the harness transaction.

**Rejected — a lint rule or a comment saying "pass a transaction".** The comment was already
there; the pool was passed anyway. **Rejected — each service opening its own transaction:** it
could not then join a caller's, which is the property D-46 needs. **Rejected — deleting rows in
`afterEach` on the shared database:** a crash between the test and its cleanup leaves rows a
developer's own database keeps; a dropped clone leaves nothing.

**Reversibility:** free. A type and a test.

---

### D-78. A client's mistake is a 4xx whichever layer noticed it, and sign-in never fails on a long name

Three requests a client can make answered `500` although nothing on the server was wrong (#233): a
body that is not JSON (the framework's `PARSE`, which `refusalFor` did not know), two requests for
one workspace slug or channel name at once (the existence check races; the index is the authority
and nothing mapped its violation), and a sign-in whose GitHub login fills `VARCHAR(39)` and so cannot
take a `-1` suffix, or whose display name passes 128 characters (`22001`).

**Decided: `refusalFor` is the one place a failure becomes a response, and it now knows the
database's.** `PARSE` is `400 VALIDATION_FAILED` with no echo of the body. A unique violation maps
by **constraint name** to the code the contract already has — `workspaces_slug_key` to
`WORKSPACE_SLUG_TAKEN`, `idx_channels_unique_name` to `CHANNEL_NAME_TAKEN`, `users_email_key` to
`ACCOUNT_EMAIL_CONFLICT`, `messages_pkey` to `MESSAGE_ID_CONFLICT`. `22001` and `23514` are
`VALIDATION_FAILED`. Nothing the driver says — message, detail, column, value — is passed on. A
unique violation on an index not in the table stays `INTERNAL`: an unexpected collision is a defect
to be logged, not a mistake to be explained.

**Decided: sign-in truncates.** The login is shortened to leave room for its suffix, and the display
name to 128 characters, counted as the database counts them. The value belongs to GitHub, so the
only choices are to store a shortened one or to lock the person out of the product.

**Rejected — catching `23505` in each service.** Every new unique index would need the same
try/catch in a place that can forget it; the mapping table is one line per index and a test lists
them. **Rejected — mapping on SQLSTATE alone:** it cannot choose between `WORKSPACE_SLUG_TAKEN` and
`CHANNEL_NAME_TAKEN`. **Rejected — retrying the sign-in on a collision:** a name that is too long
does not become shorter on the second attempt. **Left — a race between two first sign-ins of one
GitHub account** (a double-clicked callback): it violates `users_github_id_key`, which maps to
nothing and answers `500`; the contract has no code for it and the fix is a different mechanism
(an upsert), not a mapping.

**Reversibility:** free. A table and a function.

---

### D-79. Configuration refuses an unsafe production, and names the variable without quoting it

`ENCRYPTION_KEY` was checked for 44 characters, so 44 repeated letters passed, and the development
key committed to this repository was accepted in production; `DATABASE_SSL` defaulted to `false`
there; `APP_URL` accepted any scheme. The development key itself turned out to decode to 33 bytes,
not 32 — the check that would have caught it did not exist.

**Decided: the key is decoded.** Strict base64 of exactly 32 bytes, and not one repeated value
(all-zero included, which is what `AAAA…` decodes to). `Buffer.from` ignores what it cannot read, so
the shape is checked with a pattern first; a typo must not become a shorter key.

**Decided: in production the public development key is refused** — `DEVELOPMENT_ENCRYPTION_KEY`
lives in `platform/config.ts`, one home, imported by the test fixtures that use it. It is now a real
32 bytes.

**Decided: production refuses `DATABASE_SSL=false` (the default) unless `DATABASE_ALLOW_PLAINTEXT=true`.**
A self-hoster whose database shares a private compose network has a legitimate reason; the
acknowledgement makes that a sentence in their configuration rather than a silent default.
**Decided: `APP_URL` is `http` or `https`.** Every refusal is collected, names its variable and
never prints a value (`ARCHITECTURE.md` §10).

*Rejected: refusing plaintext outright.* It would make the default compose deployment impossible to
start. *Rejected: inferring TLS from `DATABASE_URL`'s `sslmode`* — a second source of truth for one
fact. *Rejected: an entropy estimate* — it rejects honest keys and accepts clever bad ones; the
checks above are the ones that are never wrong.

**Reversibility:** free; nothing is stored. An operator on a bad key sees it at the next start.

**Amended 2026-10-09 (second-round attack, all three verified against a real loader).**
*Canonical spelling:* the last base64 character of a 32-byte key carries two bits decoding drops, so
changing the public development key's final `E` to `F` produced the same bytes under a different
string and passed the string comparison. The key must now re-encode to exactly what was set, and the
development key is compared as **bytes**. *Low entropy:* a key that is a short pattern repeated
(`abcd`), a constant-step sequence (bytes 0..31) or has fewer than 16 distinct bytes is refused.
The threshold is measured: of 2,000,000 random keys the fewest distinct bytes was 22, and the
chance of one below 16 is under one in 10^12, so it never rejects an honest `openssl rand`. This is
a screen for patterns a person types, not an entropy proof — *rejected: estimating entropy*, as
above. *Integers:* `Convert` truncates `1.5` to `1`, so `SESSION_TTL_DAYS=1.5` was a day, silently;
every integer variable must now be written as digits.

---

### D-80. The HTTP edge is bounded before a handler runs

An audit found a 60 MB JSON `POST` fully parsed and answered `200` (the body is read before
authentication), the `Origin` check D-39 promised absent from HTTP, no `nosniff`, HSTS,
referrer or framing policy on a response, and an inbound `x-request-id` discarded (#234).

**Decided: the body limit is the socket's frame, 64 KiB, enforced by the server.** A message over
HTTP is the message the socket would carry (D-67), and every other body is a few hundred bytes, so one
number — `JSON_BODY_MAX_BYTES` in `ingress/http/edge.ts`, equal to `MAX_FRAME_BYTES` and tested to be —
is both generous and exact. It is Bun's `maxRequestBodySize`, not a handler check, because only the
server refuses *before buffering*. **Measured** on Bun 1.4.2 / Elysia 1.4: a 60 MB body answered `200`
in 27 ms with no limit; with it, `413` in 2 ms with no request hook run, for a `Content-Length`
body and for a chunked one alike. When attachments arrive their route raises the server cap and
holds the JSON routes to this number itself.

**Decided: `Origin` is checked on `POST`/`PUT`/`PATCH`/`DELETE`, before the body is read.** Present,
it must be `APP_URL`'s (the equality the socket upgrade uses, now `platform/origin.ts`). Absent,
`Sec-Fetch-Site` decides: only `same-origin` and `none` pass. Neither header: not a browser, and
allowed — CSRF needs a browser holding an ambient cookie, and every browser that can send a
cross-site `POST` sends `Origin` on it. When both are present both must hold. The OAuth callback
and sign-in are `GET`s and unaffected; the cost of `SameSite=Lax` alone was that a sibling subdomain
could sign every device out.

**Decided: every response carries** `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
`Cache-Control: no-store`, and `Strict-Transport-Security: max-age=15552000` when `APP_URL` is
https. No `includeSubDomains` and no `preload`: both bind a domain this product does not own.

**Decided: an inbound `x-request-id` matching `[A-Za-z0-9._-]{1,64}` is kept**; anything else is
replaced by a fresh id. It is a label for correlating an edge trace — never trusted as identity.

*Rejected: a CSRF token.* D-39 item 2's argument stands. *Rejected: requiring `Origin` on every
mutation.* It would refuse every non-browser client for a threat that only exists in a browser.
*Rejected: a body limit per route in the handler,* which runs after the buffering it is meant to
prevent. *Rejected: a larger limit "for headroom":* the frame is the bound the product already chose.

**Amended 2026-10-09 (second-round attack): the JSON-only claim is now enforced.** D-39 item 2
rests on every mutation being `application/json`, which a cross-site form cannot send — but nothing
refused the types a form can: with neither `Origin` nor `Sec-Fetch-Site`, an
`application/x-www-form-urlencoded` post created a workspace (`201`). A mutation whose body is not
`application/json`, or has no content type, is now `415 UNSUPPORTED_MEDIA_TYPE`, at the edge, before
a session is looked up or the body parsed. A request with no body at all (logout, join) is not
affected; a form with no fields still carries its type and is refused. `415` joins the contract's
statuses. *Rejected: also requiring `Origin`* — the same reasoning as above.

**Reversibility:** free; nothing is stored.

---

### D-81. HTTP is rate limited by client address for sign-in and by user for writes, and a client is only who the socket says

The only limiter was the socket's. `GET /auth/github` minted state cookies without limit and a valid
state made the callback call GitHub three times; `POST /api/channels/:id/messages` reached the same
`send()` as the socket with no budget at all; `sessions.ip_address` existed and was never written
(#235).

**Decided: two limiters behind the existing `RateLimiter` seam (D-7, D-25), applied before the
handler runs, after the body — already capped at 64 KiB (D-80) — is parsed, so a malformed body is
a 400 for everyone and costs no session lookup.** `/auth/*` is keyed by client address: 30 requests at once, then
one every two seconds (a sign-in is two requests, and an office behind one NAT must be able to
arrive together). Mutations under `/api/*` are keyed by the **signed-in user**: the socket's own
budget, 10 a second with a burst of 20, so the two doors to `send()` cost the same. Reads are not
limited here. A request with no valid session is not charged — it is answered `401` as before and
no bucket is created for a caller we cannot name. **Both numbers are provisional and say so (O-4);**
they are closed by the same measurement as the socket's.

**Rejected: keying writes by connection, as D-66 does for the socket.** HTTP has no connection; the
user is the only stable key, and D-66's objection (two tabs starving each other) is a socket
property — tabs share the user's HTTP budget, which is one person's writing.
**Rejected: threading a limiter through every handler's signature,** which is a change to a dozen
files for what one hook does at the edge; the cost is a second session lookup on a write.

A refusal is `429` with `RATE_LIMITED` and `Retry-After` (seconds until one more request fits, at
least one). The in-process limiter now drops buckets that have refilled once 10,000 are held,
at most once a second: with a key per client address, an attacker rotating IPv6 prefixes would
otherwise grow it without bound. An IPv6 client is keyed by its /64, because a subscriber holds a
whole one and a budget per address would be none.

**A client is who the socket says, unless `TRUST_PROXY=true`.** `X-Forwarded-For` is written by the
caller; honouring it by default lets an attacker take a fresh budget per request (tested: rotating
it with `TRUST_PROXY=false` changes nothing). With `TRUST_PROXY=true` the **last** entry is used — the
one the single proxy in front appended — and an unusable one falls back to the peer, not to an
earlier entry. Exactly one hop; a CDN in front of a load balancer is not a configuration this
product claims. **Rejected: counting hops (`TRUST_PROXY=2`),** which is a number nobody sets right
until it matters.

**`sessions.ip_address` is written at sign-in** with that address (an `INET` column; null when the
peer is unknown). It is personal data. It serves the device list and an incident (which address
created this session), and nothing else reads it. It lives and dies with the session row, and the
account erasure of D-27 must null it when it revokes sessions — recorded here because the job that
performs it does not exist yet. For a cloud this joins the data map D-28 promises.

**Reversibility:** free. Nothing is stored but the address, which can be nulled.

---

### D-82. The client notices a dead socket, stops retrying a refusal, ignores what it does not know, and does not trust a cursor past an unfinished replay

D-76 made reconnecting polite. Four ways the client still failed to come back, or came back wrong
(#239).

**Decided: a heartbeat, with any frame counting as proof of life.** After `PING_AFTER_IDLE_MS`
(25 s) of silence the client sends `PING`; with no frame of any kind within `PONG_DEADLINE_MS` (15 s)
it closes the socket and reconnects *without waiting for the `close` event* — a half-open socket's
may be minutes away, and the late one is ignored by the generation. A busy connection is never
pinged. The first `PING` leaves as the socket opens, and its `PONG` (matched by `refId`) feeds the
server clock (D-33); a sample whose round trip is negative, because the local clock stepped back, is
skipped and measured again at the next `PING`. The real clock is read in
`apps/web/src/system-clock.ts` and nowhere else in the client.

**Decided: refusal and outage are told apart by asking.** The browser hides a handshake's status, so a
401 and a dead server both read as close code 1006. After `CHECK_SESSION_AFTER_FAILURES` (3)
consecutive attempts that never reached `open`, the client calls an injected `checkSession()`
(`GET /api/me`, written where the client is assembled) while the retry timer keeps running. `ended`
means a 401 and only that; a network error, a 5xx or a rejected check means `unknown`, and retrying
goes on — reading an outage as a sign-out would sign everyone out whenever the server restarts. An
answer that arrives after the connection recovered, or after `stop`, is ignored. One check is in
flight at a time.

**Decided: an event the contract does not define is ignored, and still proves the peer is alive.**
`parseServerMessage` replaces `parseServerFrame` with three outcomes: a frame, an `unknown` event
(an object with a string `event` the contract lacks) and `malformed`. A known event with the wrong data
stays malformed and ends the connection, so validation of what the client does understand is not
weakened. Without this a rolling deploy that adds an event makes every older client loop
close-and-reconnect.

**Decided: the cursor is withheld while a replay's continuation is owed.** The cursor advances on any
live frame, and that is unsafe in one case: a replay was one page, a live frame moves the cursor
past the rest, and the socket drops again — the next `SUBSCRIBE` skips the gap silently. The
connection records each channel's `nextCursor` from the `ACK` as pending and ignores live frames
above it for the cursor (still delivering them) until the store calls `continuationDone(channelId,
from)` with the cursor the continuation started from. A mismatching `from` is ignored, so an old
continuation cannot release a newer replay's. Pages the store `observe`s meanwhile advance the
cursor, being contiguous. Each connection discards what the last one owed.

**Decided: `ended` is a state `start()` leaves.** Signing in again is how a session comes back, and
the watched channels and cursors are still what to resume from. Entering `ended` forgets the failures,
so the first retry after it is the shortest delay, not the cap earned by the last session.

**Rejected — waiting for the browser's `close` event after a missed deadline:** that is the bug.
**Rejected — a `PING` on a fixed interval regardless of traffic:** it spends frames, and rate-limit
tokens (§5.5), on connections already proving themselves. **Rejected — ending on the first 1006:** a
restart or a Wi-Fi change is a 1006. **Rejected — checking the session before the third failure:**
every blip would cost a request. **Rejected — one global "unfinished replay" flag:** a hundred
channels, one of them a page behind, would freeze every cursor. **Rejected — dropping live frames
while a continuation is owed:** the user would see messages arrive late for no reason; only the
cursor needs withholding. **Rejected — relaxing `parseServerFrame` to let unknown events through:**
the same function would then let a known event with garbage data through as well.

**Reversibility:** free for the numbers. The `parseServerMessage` rename is a contract change inside
the monorepo, with one caller.

---

### D-83. A subscription is made before its replay is read, and live frames wait behind the replay

`router.ts` read a channel's replay and then subscribed the socket. A message committed between the
two was in neither — the replay had been read without it and the subscription did not exist when it
was published — and the client's cursor then advanced past it for good. Found by the audit of
2026-10-09 (#237).

**Decided: subscribe first, hold, reply, release.** The router subscribes the socket to every
channel it names, tells the hub to **hold** live frames for that connection, and reads the replay.
The hub then writes the acknowledgement and the replay, and after them the frames it held — **minus
any message the replay already carried, by id**. A message committed before the read is in both and
is sent once; one committed after is only live and follows the replay; none is in neither.

- **A held frame is bounded.** Past `HELD_FRAMES_MAX` the connection is closed `RESYNC` — a channel
  outrunning its own subscription is what a resync is for, and the held list cannot grow without limit.
- **`SESSION_ENDED` is never held.** The end of a session does not wait behind a replay.
- **A subscription that fails undoes only what it added.** `EventBus.subscribe` reports whether the
  socket was already listening, so a failing resubscribe leaves the earlier subscription alone.
- **A connection that closed meanwhile subscribes nothing.** The router asks the hub whether the
  connection is still held before it subscribes, and the replay read is no longer a window in which a
  closed socket is added back.
- **The replay read is a seam** (`RouterDependencies.readReplay`) so a test commits a message at the
  exact point the old order lost one. Production passes nothing.

**Rejected — read the replay again after subscribing.** Doubles the query for the common case to
repair the rare one, and still needs the de-duplication. **Rejected — a transaction around read and
subscribe.** The bus is not transactional; a commit after the read is not blocked by it.
**Rejected — hold every frame, not only subscriptions.** It would put a send's own echo after its
`ACK`, reversing the order D-35 fixes (published, then acknowledged).

**Reversibility:** free. The hold is one list in the hub.

---

### D-84. A socket's frames are handled one at a time, in order, behind a bounded queue

Elysia starts a `message` handler for each frame as it arrives and does not wait for the last. A
`SUBSCRIBE` that waits on the database was therefore overtaken by an `UNSUBSCRIBE` sent after it and
then subscribed anyway, and a continuation that outlived `close` could add a dead socket back to the
bus, which then kept receiving `deliver` calls (#237).

**Decided: the hub runs one connection's frames as a promise chain.** `hub.enqueue(socketId, work)`
starts a frame's work when the previous one has settled; a frame that fails is logged and the chain
goes on; work still queued when the connection closes never runs. This is the "socket generation": a
connection's id is unique, the hub's entry for it is the generation, and everything a continuation does
afterwards is checked against it (`isOpen`, `held.get(id) === entry`) before it can subscribe.

- **The queue is bounded at `FRAME_QUEUE_MAX` (32)**, above the limiter's burst of 20, so a connection
  inside its budget never meets it. Past it the connection is closed with the new
  `CLOSE_CODES.TOO_BUSY` (1013, *try again later*) and what was queued is dropped. A client reconnects,
  and a send that was never acknowledged is retried like any other.
- **The drain waits.** `hub.settled()` resolves when no queued work is running, and `drain` awaits it
  beside the listener's own stop, so the pool is not closed under a frame being handled. The shutdown's
  existing deadline bounds it.

**Rejected — a mutex per frame handler, taken inside it.** Ordering would then depend on the order
the framework happens to call handlers, which is the thing that is not promised. **Rejected — an
unbounded queue.** A flood becomes memory. **Rejected — RATE_LIMITED for the overflow, as an error
frame.** The limiter already answers a flood that the server keeps up with; a queue that is full is
a server that cannot, and refusing frames one by one leaves the client sending into it.
**Rejected — `RESYNC` (4408).** That says the client fell behind what it was *sent*; this is the other
direction, and the two want different diagnoses in a log.

**Reversibility:** free. One constant and one close code.

---

### D-85. A change that removes visibility is a bus event: a membership is unsubscribed, a session or an account is closed

A subscription is authorised once, at `SUBSCRIBE`. A user taken out of a workspace and a channel kept
receiving the channel on an open socket while every HTTP read answered 404 (verified with the rows
removed directly, #203). And `SESSION_ENDED` reached only the node that handled the sign-out, so on a
second node a revoked session's sockets lived until the session's fixed expiry — up to 30 days; deleting
a user ended nothing (#238). Phase 0 has no endpoint that removes a member, so none of this is reachable
today; Phase 1 adds them, and private channels turn a miss into a disclosure.

**Decided: three events on the bus, none of which makes the hub read the database.**

| Event | Topic | Effect on every node holding a matching socket |
|---|---|---|
| `SESSION_ENDED` (`signed-out`) | `session:{id}` | Frame, then close `SESSION_ENDED` — as before, now shown across nodes |
| `SESSION_ENDED` (`account-deleted`) | `user:{id}` | The same, for every session the user holds |
| `ACCESS_REVOKED {channelIds}` | `user:{id}` (one user lost channels) or `channel:{id}` (the channel is gone) | The socket is **unsubscribed** from those channels and told; it stays open |

Every socket subscribes to its `session:` and its `user:` topic when it opens. A node needs no list of
who may see what: the publisher names the channels, and the hub only unsubscribes. A message delivered
costs no visibility query.

**Unsubscribe or close — the cost of each, written down.**

- *Closing* is correct by construction (a reconnect re-authorises everything) and needs no
  bookkeeping, but it costs every **other** channel the user has open a reconnect, a resubscribe of
  all of them and a replay — and removing someone from a workspace, or deleting a channel many people
  watch, is a reconnect burst from sockets that did nothing wrong. It is the right tool when
  *everything* is gone: a session, an account. It is what those two do.
- *Unsubscribing* touches only what was lost and costs the client one frame, but it must be told
  (`ACCESS_REVOKED`) and it can race a `SUBSCRIBE` in flight. The race is closed by order, not by a
  check: a subscription is made **before** its channels are authorised (extending D-83's
  subscribe-first), so a revocation published at any moment finds it and ends it, and a refused
  subscription undoes what it added and drops what was kept for it. It is what membership does.

**What Phase 1 must publish** — the decision binds it, and the tests call these functions
(`platform/events.ts`) because there is nothing else to call yet:
removing a member from a workspace (#51) → `publishAccessRevoked(bus, clock, userId, <every channel of
that workspace they could see>)`; leaving a channel, or being removed from a private one →
`publishAccessRevoked(…, [channelId])`; deleting a channel (#98) → `publishChannelRevoked`; deleting a
user → `publishUserDeleted`. **After the transaction commits**, as every publish does (D-35).

**Two nodes are demonstrated, not argued.** `Backplane` (`realtime/bus.ts`) is the shared transport
that nodes publish through; one process makes its own, and a test shares one between two
applications. A sign-out on one closes the socket the other holds; an account deletion and a removal
published from a third node that holds no sockets reach both. Phase 3's Redis adapter is this
interface across processes.

**Rejected — re-checking visibility per delivered frame.** A read on the hottest path to answer a
question whose answer changes at three moments. **Rejected — closing on every membership change.**
The reconnect burst above, for the common case, to avoid a frame. **Rejected — a `workspace:` topic
that sockets listen to for membership.** It would make every socket listen to every workspace and
still not say which channels. **Rejected — the hub resolving which channels a workspace holds.** It
would make the hub touch the database, which is the separation D-7 stands on.

**Left:** `ACCESS_REVOKED` for a channel turning private is not published by anything yet; nothing
makes a channel private in Phase 0–1's endpoints, and the event it needs is this one.

**Amended 2026-10-09 (second-round attack): a send re-proves its session in the transaction that
writes it.** A socket authenticates once and caches the identity; a sign-out racing a send let one
write commit *after* `revoked_at` (found by attack: one write, zero frames reaching the closed
socket). The guard query that runs per send cannot carry the session — it answers about the
channel — so the send path adds one primary-key read of the session row, `FOR SHARE`, as the first
statement of its transaction (`requireLiveSession`). Revocation updates that row, so it waits for the
transaction holding the lock: **a write by a session commits before the session's revocation does,
or is refused `UNAUTHENTICATED`; there is no third order.** Measured on a cloned database with real
commits: a revocation held open while a send starts makes the send wait and then refuse, writing
nothing (without the lock the same test commits the write); a send holding the session makes the
revocation wait (it does not complete while the transaction is open). Cost: one indexed read per
send, share locks being compatible with each other. Both doors use it — the socket's cached identity
and the HTTP `POST /messages` — because they share `send()`. **Left, stated:** other HTTP writes
(workspace, channel, join) resolve the session at the start of the request and are not locked, so
their window is one request's duration; none writes into another member's view (a message is the
only thing that reaches a room), and the cost of locking every write was not justified by a
measurement. A socket frame other than a send only reads.

**Reversibility:** one frame and one close behaviour; nothing is stored.

**Amended 2026-10-09 (second-round audit): the contract is watched, and out-of-band SQL is not
covered.** The three publish functions had no caller, so nothing noticed when a path that removes
visibility did not publish. `revocation-contract.test.ts` now finds every production statement that
revokes a session, soft-deletes a user, workspace or channel, or deletes or updates a membership, and
holds each to a table of the event it publishes (or, with an owner, why none): a new write path with no
decision fails the build, and a row whose write has gone fails it too. Today's sites are all sessions —
sign-out publishes after the write, and the dead-session purge removes only rows already announced or
expired. Nothing existing needed wiring; no path soft-deletes a user, workspace or channel yet.
**A write made outside the application** — SQL by hand, a script — **does not end open sockets** until
the session expires or the process restarts, because the bus is in-process (D-7): a command-line tool is
another process and cannot reach this one's bus, and a network bus is not built for it (`CONTRIBUTING.md`
§1.11). An operator who revokes by SQL restarts the node (a drain, D-72) to make it take effect.

---

### D-86. A migration is one transaction unless its file says otherwise, and a file that has run cannot change

Kysely's migrator ran every pending migration in one transaction and recorded nothing about the file. Two
consequences were measured on 1,000,000 messages (#240). `0007` claimed that adding a constraint `NOT VALID`
and then validating it "lets writes continue"; inside one transaction the `ACCESS EXCLUSIVE` lock of the
`ADD CONSTRAINT` is held to the commit, and a concurrent `SELECT` hit its 2 s statement timeout while the
validation scanned the table (the same migration, opted out, delayed no `SELECT` by more than 150 ms). And
`CREATE INDEX CONCURRENTLY` is refused inside a transaction, so no index could be added to a large table
without locking its writes.

**Decided: the migrator is ours, and the opt-out is declared in the file.** A comment in the file's leading
block, `-- purlay: no-transaction`, runs that migration statement by statement with no transaction around
it. The default stays one transaction per file, with its record written in the same transaction, so a
failed migration leaves nothing behind. A file that opts out gives that up and must be written to run again:
`IF NOT EXISTS`, and `DROP INDEX CONCURRENTLY IF EXISTS` before a `CREATE INDEX CONCURRENTLY`, because a
build that fails leaves an invalid index. Each statement is sent on its own, because PostgreSQL treats a
string of several statements as one implicit transaction. Concurrent starters take a session advisory lock
and run in turn; the third waits for the first and finds nothing to do.

**Decided: each applied migration records the SHA-256 of its file**, and a mismatch, a missing file or an
out-of-order name is a failure before any migration runs. A database migrated before checksums existed has
none recorded for its rows; they are **adopted once**, from the files as they stand. That is trust on first
use, and the cost is stated: an edit made before the first run of this migrator is not caught. The one edit
this change itself makes to an applied file, the corrected `0007` comment, is of that kind.

**The CLI reads `DATABASE_SSL`** like the application, through the same client, and refuses a value it
cannot read rather than connecting in the clear.

**Rejected — Kysely's `disableTransactions` for the whole run.** It is all or nothing: every migration
loses its atomicity because one needs to leave the transaction. **Rejected — a separate directory or
extension for non-transactional migrations:** the order of the migrations is one sequence, and a second
place to look is a second place to forget. **Rejected — a checksum that ignores comments:** needs a SQL
lexer to be right and decides what counts as a change; the file is the unit. **Rejected — refusing to
adopt unchecksummed rows:** it would fail every existing database for a risk that cannot be measured.

**Reversibility:** costly once migrations carry checksums, since the recorded values are the contract; the
opt-out line is one comment and costs nothing to remove from a file that has not run.

*Amended 2026-10-09:* readiness asks the same question the migrator asks before it runs
(`migrationHistoryProblem`), read-only, and reports an edited, missing or out-of-order migration as not
ready. A database that predates the checksum column has nothing to compare and is not accused. Without it,
a process whose files had parted from its schema would pass readiness and fail on the first query that
depended on the difference.

*Amended 2026-10-09 — the lock is polled, not waited for:* with two processes starting on an empty database,
one died with `deadlock detected` on every run (ten of ten in the test written for it). A blocking
`pg_advisory_lock` is a statement, and a statement is a transaction to PostgreSQL while it waits;
`CREATE INDEX CONCURRENTLY` (migration 0009) waits for every transaction that could see its table to end.
The runner waited for the starter, the starter for the runner's lock, and PostgreSQL ended one. The
earlier test of three starters had no concurrent index build and could not see it. The migrator now tries
`pg_try_advisory_lock` and sleeps between attempts (25 ms, doubling to 500 ms, for at most 120 s, then an
error that says another process held the lock). Between attempts the session is idle, which an index build
has nothing to wait for. The lock is taken on the one session the run holds, is released on every path past
acquiring it (a test fails a migration and then expects another starter to get the lock at once), and
ends with the session if the process dies. Two `db:migrate` processes started together on a fresh database
exit 0 five times in five, with all ten migrations applied once between them.
**Rejected — a lock per migration:** the wait would still be a statement in a transaction, now repeated
for every file. **Rejected — only a `lock_timeout`:** it turns the deadlock into a timeout error that
exits one of two healthy starters, instead of making it wait its turn. **Rejected — running the build and
the wait on separate connections without polling:** the waiting connection is the transaction the build
waits for; only not being in a statement avoids it.

---

### D-87. The pool waits a bounded time and says what is wrong; a session that cannot authenticate can be purged

`createDatabase` set a pool size and nothing else (#243). With a pool of two, a third query waited 7,612 ms
for a connection to free: no timeout, so under load every request queues behind the slowest query and the
client sees a hang. A dropped idle connection emitted `error` on a pool with no listener, which ends the
process. TLS was `rejectUnauthorized: true` and nothing more, so a database behind a private or managed
root could not be reached with verification on.

**Decided: fixed limits, in code, published in `CONFIG.md`.** A 3 s wait for a connection; a 30 s
`statement_timeout`; a 15 s `idle_in_transaction_session_timeout`; a 30 s idle connection; and an
`application_name`. Running out of connections raises `DatabaseUnavailableError`, which the HTTP boundary
maps to a new code, `DATABASE_UNAVAILABLE`, with status `503` and no detail: it is the server being busy,
the request changed nothing, and a client may retry. The wait is bounded at the moment the connection is
asked for, in the pool wrapper, so no caller has to remember to classify a driver error by its text. A
pool error is handed to a callback, and the composition root logs it.

**Decided: `DATABASE_SSL_CA_FILE`, a path.** A mounted file is how a deployment already carries a
certificate, and it keeps a multi-line PEM out of an environment variable. It needs `DATABASE_SSL=true` and
a file that cannot be read stops the boot; the migration CLI reads the same two variables.

**Decided: `purgeDeadSessions(db, now, batch)`.** Deletes at most `batch` expired or revoked sessions per
call and returns the count; a scheduler (#71) calls it until it returns zero.

**Rejected — configurable limits (`DATABASE_*_TIMEOUT`).** Each is a way to lower a safety into an outage
and a line of operator documentation to get wrong; the three numbers are defaults a deployment has no
measured reason to change. They become variables when one does. **Rejected — matching the driver's
`timeout exceeded when trying to connect` text:** it is a string in another package's source. **Rejected — a
statement timeout for the migrator:** an index build on a large table is meant to take as long as it takes,
and a migration cut off halfway leaves an invalid index.

**Reversibility:** free. The numbers are one constant each; the error code is the only part clients see.

*Amended 2026-10-09:* a frame that fails for want of a connection is answered with the same
`DATABASE_UNAVAILABLE` `ERROR` frame, with the HTTP body word for word, instead of `INTERNAL`; the cause is
still logged. A client that retries a refused request now has one code to recognise on either transport.

*Amended 2026-10-09 — the migrator is not the application:* the 30 s statement limit belongs to the
application's pool alone. A node migrating as it starts (D-93) ran `migrateToLatest` on that pool, so a
migration with a 33 s statement was cancelled, the node exited, and its restart was cancelled at the same
point; a large `CREATE INDEX CONCURRENTLY` or `VALIDATE` would have kept a node in that loop. Migrating now
always opens a connection of its own through `createMigrationDatabase`, which `bun run db:migrate` uses too:
one connection, no statement timeout, the idle-in-transaction limit kept (the runner is never idle inside its
transaction). **Rejected — raising the application's limit:** it exists to bound a runaway request.
**Rejected — `SET statement_timeout = 0` inside the migrator on the borrowed connection:** it would work
until someone reused the connection, and leaves the pool's other users one forgotten reset from running
unbounded.

---

### D-88. A send does not rewrite the channel row's indexes, and a retried send is announced again

`sendMessage` updated `channels.last_message_at` on every send, and that column was the second key of
`idx_channels_workspace` (#244). Measured on 2,000 sends to one channel: **0 of 2,000 updates were HOT**, and the
channel's indexes grew from 57,344 to 155,648 bytes, in step with traffic instead of with channels. The write
came from the application's clock with nothing to stop it going backwards, so two concurrent senders, or two
nodes whose clocks differ, could move the channel's recency back. It also took the channel's row lock for
the rest of the transaction.

**Decided: the column leaves the index.** Migration `0008` rebuilds `idx_channels_workspace` on
`workspace_id` alone (concurrently, in the way the migrator allows, D-86). A workspace has tens or hundreds
of channels, so sorting what the index finds costs nothing next to the write it removes. The same 2,000
sends then made **1,999 HOT updates, and the indexes stayed at 57,344 bytes**.

**Decided: the update is monotonic and skipped when it would not advance.** `where last_message_at is null
or last_message_at < $sent_at`: a send whose clock is behind the channel's writes nothing and takes no lock,
and one that is ahead cannot be undone by a slower neighbour. It is the last statement of the send, so the
row lock it takes lasts as little of the transaction as possible. `updated_at` is deliberately not touched;
it records edits to the channel, not traffic through it.

**Decided: a retried send publishes `MESSAGE_CREATED` again.** `send()` announces the stored message every
time it is called with an id it already holds. The failure that makes this correct: the write commits, the
publish fails, the sender is told so and retries. If the retry stayed silent the room would never hear of a
message that is in the database, and nothing else would tell it while its sockets stay open. The cost is one
frame that changes nothing, because clients de-duplicate by id (D-65), and a retry is rare and backed off.
Both behaviours have a test.

**Rejected — publishing only when the row was inserted.** It makes the failure above permanent, and it
trades a duplicate frame that is harmless for a lost one that is not. It becomes right if a delivery
guarantee exists elsewhere (a transactional outbox), and the reopening condition is that. **Rejected — a
`GREATEST(...)` in the `SET`:** it is monotonic as well, but it still writes the row, takes the lock and
leaves the old tuple behind when nothing advanced. **Rejected — rounding `last_message_at` to the minute so
most sends skip the write:** the sidebar's order between two busy channels would then be wrong. **Rejected —
a separate `channel_activity` table:** moves the same write to another row, and costs a join on every
sidebar read for a problem the index change already removes. **Rejected — `fillfactor`:** HOT pruning
reclaimed the old versions on its own (1,999 of 2,000); a setting that was not needed is not added.

**Reversibility:** free. The old index is one `CREATE INDEX`.

---

### D-89. Every foreign key has an index, and a test reads the catalogue to keep it so

`SCHEMA.md` §1 said every workspace-scoped table has an indexed `workspace_id`, and `messages` did not (#241). On
1,000,000 messages (10 workspaces, 200 channels, 200 users) the cost of that was measured: **deleting 100
messages took 4,756 ms**, and deleting one channel of 5,000 messages did not finish in 60 s, because enforcing
a foreign key is a query on the referencing table, one per deleted parent row, and `messages.parent_id`,
`messages.channel_id`, `messages.workspace_id`, `messages.resolved_by` and
`channel_members.last_read_message_id` had no index that query could use. The `idx_messages_*` indexes are
partial, and the enforcement query filters on the column alone, so none of them applies. The retention purge
(D-27), channel deletion and workspace deletion were unusable at scale.

**Decided: migration `0009` indexes every foreign key column**, `CONCURRENTLY` and outside the migrator's
transaction (D-86), re-runnable after a crash. A nullable column is indexed only where it is set. The five
`idx_messages_*` partial indexes stay, since they answer the feed, the thread, the search and the open
questions. The same 1,000,000-row database after: **8.7 ms** for the 100-message delete and **90 ms** for the
channel, both through index scans (plans in the pull request); the four new `messages` indexes add 14 MB to
376 MB and make 20,000 single-row inserts 5 % slower (1,107 to 1,168 ms).

**Decided: `idx_workspaces_slug` is dropped.** It indexed the column the `UNIQUE` constraint already indexes,
partially, so no query could prefer it and every write paid for it.

**Decided: a test reads the catalogue.** Every foreign key's first column must lead a valid btree that is whole,
or partial only on `col IS NOT NULL`; and no non-unique index may be a leading prefix of another whole one.
Both ran red against the previous schema, listing exactly the seven columns and the one redundant index. The
check reads what exists in the database, so it is a rule about tables not yet written.

**Decided: the search index stays, and its cost is written down** (`SCHEMA.md` §6.2). `idx_messages_search`
is 206 MB of the 376 MB of indexes on `messages`; removing it made inserts 1.8 times as fast on high-entropy
text and 1.45 to 1.6 times on prose, 15 to 25 µs a message. Search is a Phase 1 feature (D-10) and the index is
what makes it work in one database, so the cost is accepted. It is reopened when insert latency shows up in a
measurement of the send path, or when search moves out of the database.

**Rejected — one composite index `(workspace_id, channel_id)` in place of two.** It serves the workspace key and
a composite key, but not a lookup by `channel_id` alone, which is what the existing channel foreign key asks;
the two single-column indexes are 7 MB each. **Rejected — turning `idx_messages_thread` into the `parent_id`
index** by dropping its `deleted_at` predicate: a tombstoned reply keeps its place in the thread (D-9), so the
predicate may be wrong already, and that is a decision for the thread feature, not for this change.
**Rejected — a full-column index on each nullable key:** most rows are null, and the index would be mostly
nothing.

**Reversibility:** free; each index is one statement either way.

---

### D-90. Tenant integrity is a constraint where a constraint can say it

D-21 calls a tenant leak the one defect class that cannot be recovered from, and until now the rule that
prevents it was a convention (#242). In one transaction a message was inserted with `workspace_id` of
workspace A and `channel_id` of a channel in B; a reply with a channel and workspace unlike its parent's;
a DM with `dm_key = 'garbage'`; and a `messages.id` that was a v4. The database accepted all of them,
because the rules (`SCHEMA.md` I-1, I-3, I-4, I-5) were enforced by the services that were meant to write.
A writer that is not one of them (a job, an import, a script, a later endpoint written in a hurry) was not stopped.

**Decided: composite foreign keys, so the tenant check cannot be skipped.** `channels` gains
`UNIQUE (id, workspace_id)` and `messages` gains `UNIQUE (id, channel_id)`, which are what a composite key must
point at. Then: `messages (channel_id, workspace_id)` references `channels` (a message is in its channel's
workspace); `messages (parent_id, channel_id)` references `messages` (a reply is in its parent's channel,
hence workspace); `channel_members (last_read_message_id, channel_id)` references `messages` (a read position
is a message of that channel). Each replaces the single-column key it contains and keeps its action (cascade,
restrict, set null), so a pair of triggers per row is not paid twice. The read-position key is
`ON DELETE SET NULL (last_read_message_id)`: the plain form nulls both columns, and `channel_id` is not null.

**Decided: two CHECKs.** `messages_id_is_uuidv7` is the contract's `isMessageIdShape` in SQL (version 7, RFC
variant), and a test compares the two on seven ids so they cannot part. `dm_key_form` requires two lower-case
ids, the first not above the second byte-wise (`COLLATE "C"`). It is `<=`: a conversation with oneself is a
product question, and a constraint should not be the place it is answered.

**Decided: added the way it has to be added to a large table.** `0010` leaves the migrator's transaction
(D-86). The unique constraints are built `CONCURRENTLY` and attached; each key and check is added `NOT VALID`
and `VALIDATE`d in the next statement; a lock wait is bounded at 10 s. On the 1,000,000-message database,
with a reader and a writer running throughout, the migration took 9.7 s: the slowest `SELECT` was 6 ms, the
slowest `INSERT` 57 ms, and none of about 900 statements waited out a 2 s lock timeout. A test reads the
catalogue and fails on any constraint left unvalidated.

**Decided: a refusal test for each**, naming the constraint and the SQLSTATE the database answered with,
inside its own transaction (a refused statement aborts it). `ON DELETE RESTRICT` answers `23001`, not `23503`.
Two tests are not refusals but guard the other direction: deleting a message clears only the read position that
named it, and deleting a channel still takes its messages and memberships.

**What stays service-level**, and why, is `SCHEMA.md` §11: thread depth (a key cannot say "the row I point at has
a null column"); counters kept equal to other rows (a trigger on the hottest table); the timestamp inside an id
(a `CHECK` must be immutable); that a DM's two ids are members of its workspace; and I-6, which could be a
`CHECK` but belongs with the read-state service that defines it.

**Rejected — triggers for the tenant rules.** A trigger runs on every write to the hottest table to do what a
key does with an index, and it is the form of rule that gets disabled during a bulk load. **Rejected — dropping
`messages.workspace_id` and deriving it through the channel:** every workspace-scoped read would join, and D-3
makes the tenant filter structural so that it cannot be forgotten. **Rejected — a `CHECK` calling a function to
look the channel up:** a constraint cannot see another table's rows, and a function that pretends to is not
checked on the other table's update. **Rejected — `MATCH FULL`:** every column is `NOT NULL` or null together
with the one that matters, and the default already skips an unset `parent_id`.

**Reversibility:** each is one `DROP CONSTRAINT`. Once the keys exist, a writer that violates them fails, which is
the point and is also what a bulk loader must be told.

---

### D-91. The supply chain is checked by the machine: pins, audit, scanning, licences

The documents claimed every image and action was pinned; the workflow named `actions/checkout@v7`,
a tag its owner can move to code that then runs with the repository's token (#247). The dependency
tree carried five advisories (four high) that nothing reported, and nothing checked that a
dependency's licence could ship inside an AGPL-3.0 distribution. Each of those is a rule that was
true only while somebody remembered it.

**Decided: each is a failing check.**

- **Actions are pinned to a full commit SHA with a trailing `# vX.Y.Z` comment.**
  `scripts/workflow-pins.test.ts` fails any `uses:` that is not 40 hex digits plus a version
  comment, so it fails in the pull request. Dependabot's github-actions ecosystem stays on, so a
  new SHA arrives as a reviewable bump instead of a silent tag move. The repository setting
  `sha_pinning_required` is the second lock, applied by the maintainer, not by a pull request.
- **`bun audit` blocks at high severity** (`scripts/audit-gate.ts`, run by `bun run audit:gate` in a
  job of its own). A finding that cannot be fixed goes in `scripts/audit-allowlist.json` with an
  advisory id, a reason and an **expiry date** no more than 180 days out; the gate fails on an
  expired entry and on an entry that matches no finding, so an allowlist cannot become a place
  findings are forgotten. It also runs weekly, because an advisory arrives without a commit. One
  finding (`braces`, a development-time dependency with no patched release) is allowed this way
  today.
- **CodeQL scans JavaScript and TypeScript** on pull requests, on main and weekly, with read-only
  permissions except the one write it needs to report. On a private repository without Advanced
  Security it cannot upload results, so the job fails on any result in the SARIF itself.
  `scripts/workflow-permissions.test.ts` holds every workflow's top-level token to read.
- **A licence is checked against AGPL-3.0 distribution** (`scripts/licenses.ts`) over the installed
  tree, as an **allow-list**: an unknown licence fails, and so does a package that declares none.
  The workspace manifests state `AGPL-3.0-or-later` — what `NOTICE` grants ("version 3 ... or any
  later version"); `LICENSE` is the licence text and does not choose, and a test binds the two.
- **`SECURITY.md` and `CODEOWNERS`.** Reports go through GitHub's private vulnerability reporting
  (a public-repository feature), and the response targets are the ones one maintainer can keep.
  `CODEOWNERS` names the one maintainer so review is *requested* on every path. Branch protection
  stays strict with `enforce_admins` and **zero required approvals** — deliberate for one
  maintainer, since a required approval nobody else can give is a lock only the owner holds.
  Repository settings (alerts, security updates, secret scanning, SHA-pinning required) are
  applied by the maintainer, not by a pull request, and each is listed with its reversal.

**Rejected: tag pins with Dependabot only.** It reports a moved tag never; it only proposes the next
one. **Rejected: failing the build on any severity.** A moderate finding in a dev-time tool that has
no fix would block every merge for something with no exploit path in the product; the threshold is
a number in one file and moves down when the tree is clean. **Rejected: a third-party scanner
service.** Another account, another token, and a dependency of the pipeline itself; `bun audit`
and CodeQL are already in the platform we run on.

**Reversibility:** free. All of it is workflow and script; nothing is stored.

---

### D-92. The API ships as a distroless image that runs the source, pinned by digest

There was no Dockerfile, so "nothing assumes this server" (D-73) was a sentence about a deployment
that could not yet be made (#248). The shape of the image decides what an attacker who reaches the
process finds, and what an operator must trust.

**Decided.** Two stages. The first (`oven/bun`, slim) installs production dependencies from the
frozen lockfile and nothing else. The second (`oven/bun`, **distroless**) receives `node_modules` and
the sources of the API and the two packages it uses, and runs as the numeric user `65532`. There is
no shell, no package manager and no `curl` in it; the container's `HEALTHCHECK` is the Bun runtime
asking `/health/ready`, so a process that is up but not ready — database away, migration pending,
draining (D-72) — is reported unhealthy. Both bases are pinned by digest with the tag beside it, and
Dependabot's docker ecosystem proposes the next digest, for the reason pins are CI-checked (D-91).
It starts with `--read-only --cap-drop ALL --security-opt no-new-privileges`, which
`scripts/image-smoke.sh` does on every pull request that touches it.

**Nothing is compiled.** Bun runs the TypeScript the repository contains, which is also what the
tests run, so there is no second artefact that could differ from the one that was tested. A
pull request builds the image and runs it against the compose PostgreSQL, pushing nothing; a push to
main publishes it to GHCR tagged by commit and by branch (never `latest`: an operator pins a commit
or a release), with provenance and an SBOM attached as attestations. The publish job can be exercised
for real only once it is on main.

**What stays with #224.** This is the API. Serving the built client from the same origin waits for
the prerendered shell (#141), and the image grows a stage for it then; the production compose
assumes only that one origin fronts the API.

**Rejected: an Alpine or Debian base.** A shell, a package manager and musl or glibc differences for
no benefit to a program that needs only its runtime. **Rejected: `bun build --compile` into one
binary.** It would be a second artefact the tests never ran, and the migrations are files read from
disk. **Rejected: an init process (`tini`).** The process handles SIGTERM itself and drains
(`lifecycle.ts`); an init adds a binary to a shell-less image to do what the code already does.
**Rejected: a floating tag, even `1`.** The digest is the claim the documents make.

**Reversibility:** free. Nothing is stored in the image; the volumes are the database and the bucket.


*Amended 2026-10-09:* the smoke test ran the API container against the development compose database through
`host.docker.internal`. When that database's port was bound to the loopback address (the superuser's password
is in the repository, so it should be), a container on a Linux runner could no longer reach it, the log said
`migrating on start failed`, and the `image` check was red on main for three commits, because it was not a
required check. The smoke test now creates a throwaway network and a throwaway PostgreSQL of its own (the
image named in `docker-compose.yml`, nothing published), runs the API on the same network by container name,
and removes both when it ends; `scripts/image-smoke.test.ts` fails if it references the host again. It no
longer depends on what any other file publishes.

*Amended 2026-10-09 (a second-round audit that opened the image):* it shipped every `*.test.ts` — 75 test
files, 83 with the directory of test-only code beside them — because the Dockerfile copies the source
directories whole. `.dockerignore` now leaves out `**/*.test.ts` and `apps/api/src/testing`, and the smoke
test asks the **image** (not the ignore file) how many are in it and fails on any: 83 on the image as it
was, 0 now, the rest of the smoke test unchanged. Lint already refuses production code importing the
test-only directory, so nothing the process loads is among them. The image is 1 MB smaller; the point was
never size. Separately, the probes `/health` and `/health/ready` were most of the log (a balancer and the
container's own check poll them every few seconds): they are written at `debug`, and a probe that fails is
still visible because readiness writes its reason at `warn`.

---

### D-93. Migrations run on start: every node calls the migrator, which makes starters take turns

Migrations were run by hand with `bun run db:migrate`, and nothing designed what happens when several API
nodes start together — which a deploy of the cloud shape (D-25, D-44) does every time (#248). Readiness
already answers 503 while migrations are pending (#108) and reports a history the files no longer describe
(D-86), so a node ahead of its schema takes no traffic; what was missing was something to apply them.

**Decided: `MIGRATE_ON_START=true` makes the process migrate itself after its listener opens**, through the
migrator's public `migrateToLatest` (D-86). It is off by default: a developer's `bun run dev:api` should not
rewrite a database by being started. It listens first, so liveness answers during a long migration and
readiness says 503, which is the state a balancer already understands; a request sent straight to the node
can reach an unmigrated schema, and the production compose puts the proxy behind readiness. A node whose
migration fails logs it and exits 1, so an orchestrator shows a crash loop instead of a half-started node.
Every node calls the migrator and the migrator's session advisory lock makes them take turns; the starter
that comes second finds nothing to do.

**What this change first found, and what removed it.** The migrator's lock was at first a blocking
`pg_advisory_lock`, and two real API processes started together against an empty database deadlocked: a
starter waiting in that statement is inside a transaction, the running migration `0009` builds its indexes
with `CREATE INDEX CONCURRENTLY`, which waits for every transaction that could see the table to end, and the
waiter waits for the runner's lock. PostgreSQL aborted one with `deadlock detected` and that node exited 1,
three runs in three. This change therefore carried a lock of its own, taken without waiting, to keep
waiters out of the migrator. **That lock was removed when the migrator was fixed (#286)**: it now polls
`pg_try_advisory_lock`, so a waiting starter holds nothing open. The two-process test is unchanged in what it
asks and now passes because of the migrator; with the migrator's lock taken out it fails three runs in three
(the node that lost the race exits), which is the honest check that the test still needs the protection
it claims.

**What this still adds**, since the lock it carried is gone: the opt-in, the order (listener first, so
liveness and readiness tell the truth during a migration), the exit on failure, and the process-level proof
that two nodes starting together both become ready with every migration recorded once.

**Rejected: a separate migration job (an init container, `compose run`).** Right for a large cloud and wrong
for a one-container self-host, where the second thing to remember is the thing nobody installed; it stays
possible by leaving the variable off and running `bun run db:migrate` from the same image. **Rejected: leader
election or a heartbeat table.** The database already provides a lock that disappears with its owner.
**Rejected: keeping a second lock "in case".** Two locks that must agree are one more thing to be wrong; the
test is what would show the migrator regressing.

**Reversibility:** free. A variable and a function; migrations themselves are unchanged.

*Amended 2026-10-09:* `migrateOnStart` takes the connection settings, not the application's pool, and
opens and closes a connection of its own (D-87, amended): the pool's 30 s statement limit must not apply to a
migration. A test has the migration record the `statement_timeout` its own session was given (`0`, where
the application's pool shows `30s`) and counts sessions afterwards (none left, on success or failure).

---

### D-94. The production stack is one compose file, one proxy, and nothing that names a server

D-73 put an internal deployment into Phase 1 and made it a condition that nothing assume the server
it first runs on (#248). The shape had to be decided before the file: where TLS ends, what is
published, and what the operator must supply.

**Decided: `docker-compose.production.yml` — API, PostgreSQL, Garage and Caddy.** Caddy is the only
service with published ports (80 and 443, UDP 443 for HTTP/3), and its site address *is* `APP_URL`,
so the origin it answers for and the one the API checks sockets against cannot differ. Certificates
are issued and renewed by Caddy itself (ACME); for `https://localhost` it uses its internal CA, which
is how the file was exercised without a domain. WebSockets pass through `reverse_proxy` unchanged.
The proxy starts only when the API reports ready, and the API only when PostgreSQL and Garage are
healthy. The API runs with the image's read-only, capability-free profile (D-92) and migrates itself
(D-93). Every image but the API's is pinned by digest; the API's is a variable (`PURLAY_IMAGE`), so a
deployment names a commit or a digest, never a moving tag.

**Inputs are variables, and only those.** The tables in `CONFIG.md` plus three the stack needs
(`PURLAY_IMAGE`, `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`). A required one that is missing stops
`docker compose` with its name. A test asks `docker compose config` itself for the resolved model and
fails if a port other than 80/443 is published, an image lacks a digest, the API loses its read-only
profile, a host path other than this repository's read-only config files appears, or a variable the
file reads is missing from `CONFIG.md`. The one-time storage layout, bucket and key are created by
`scripts/production-init.sh` from the same variables — Garage's image has no shell to do it in compose.

**Its own Compose project name** (`purlay-production`), so its volumes cannot be a developer's.

**Rejected: Traefik, nginx, or the platform's ingress.** Caddy's automatic TLS is the whole point for a
self-hoster who will not run certbot; nginx needs a second tool for certificates, Traefik needs a
dynamic configuration model for one upstream. A platform ingress is the PaaS D-73 declined for now.
**Rejected: publishing PostgreSQL or Garage "for convenience".** Backups run inside the network
(`docker compose exec`), and a published database port on a server that holds a team's conversations
is the incident the stack exists to prevent. **Rejected: a `.env.example` for production.** A second
list of the variables beside `CONFIG.md`, which owns them; the test binds the file to the document.

**Not here, deliberately:** the built client (the proxy has one upstream until #224 adds the client
stage), the scheduler container (D-30; there are no jobs yet), and multiple API nodes (D-25; the
compose file is the single-node shape, and a second node is `--scale api=2` behind a sticky balancer
only after Phase 3 builds the shared adapters).

**Reversibility:** free. The volumes (database, bucket, certificates) outlive the file.


*Amended 2026-10-09 (a second-round audit that ran it):* (1) Caddy's access log recorded the full URI, so
`/auth/github/callback?code=...&state=...` was written to a file that is shipped and kept; it now logs the
path and removes everything from the `?` on, checked on a real run. (2) 80 and 443 were written into the
file; `HTTP_PORT` and `HTTPS_PORT` move them, with the caveats in `CONFIG.md` (the HTTPS port must also be in
`APP_URL`, and a public certificate needs the standard ports). (3) The variables were only in a table;
`docker/production.env.example` is the file to copy, bound to the compose file by a test, with secrets
left empty so an unedited copy fails by name instead of starting with a default.

---

### D-95. A backup is a directory that has been restored: a dump, a bucket copy, and a comparison

D-44 says a restore is tested on a schedule and D-73 that one is performed before the team moves in.
There was no script for either, and nothing copied the object store at all (#248).

**Decided: `scripts/backup.sh` writes one directory** — `pg_dump --format=custom` taken inside the
database container (so the client is the server's version), the dump's table of contents (reading it
back is the proof it is an archive), every object in the bucket with a manifest of size and SHA-256
(`scripts/bucket-copy.ts`, run in the API image on the stack's network because the store is published
nowhere), and a `SHA256SUMS` over all of it. **`scripts/restore.sh` verifies those sums first**, then
restores into a *new* database by default, refuses a target that already has tables, refuses to
replace the live database while the API runs, and imports only into an empty bucket.
**`scripts/compare-databases.sh` judges the result**: per-table row count and an MD5 over every row,
in a fixed order, plus index and constraint counts; the bucket is judged against its manifest.

**It is rehearsed, not assumed.** `scripts/restore-rehearsal.sh` builds a throwaway stack, fills it with
awkward data, backs it up, restores into a new database and bucket, compares, then destroys every
volume and rebuilds from the backup alone. It runs weekly in CI and on any change to what it covers.
The first run by hand, what it found and what it does not show are
`docs/spikes/backup-restore.md`.

**Rejected: `pg_basebackup` or file-level copies of the data volume.** They restore only onto the same
major version and architecture, and cannot be taken from outside the container without stopping it.
**Rejected: a bucket copy with `rclone` or `mc`.** A tool to install on every operator's machine for an
operation the runtime's own S3 client performs, in the image they already have. **Rejected: compressing
the dump in a pipeline.** A failed `pg_dump` in a pipe can leave a valid-looking empty file and a zero
exit; the dump is written directly and read back. **Rejected: encrypting the backup in the script.**
Key management is the operator's problem and one this project should not half-solve; the spike says
plainly that the directory is plaintext.

**Not covered, said out loud:** point-in-time recovery (WAL archiving, the cloud's requirement in D-44),
off-host copies, a production schedule, and the `ENCRYPTION_KEY`, which a backup must never carry.

**Reversibility:** free. Scripts and a workflow; the format is `pg_dump`'s and a directory of files.

*Amended 2026-10-09 (a second-round audit that ran it):* four things the first rehearsal could not see.
(1) `restore.sh --replace` dropped the live database **before** reading the dump, so a truncated dump with
regenerated checksums left it with its tables and none of its rows; it now checks the dump reads back and
the target and bucket will accept it, restores into a **staging** database, checks that, and swaps by
renaming, keeping the old one as `<name>_before_restore_<time>`. A failure drops the staging database and
leaves the target as it was. (2) A backup was written with the caller's umask and any local user could read
every message; it is `0700`/`0600`. (3) A backup on a stack whose object store was never initialised left a
partial directory with no checksums; it now removes it and points at `scripts/production-init.sh`.
(4) The default restore put the database in a new place and the bucket into the live one, which refused
after the database was done; both now default to new names, `--bucket live` is the recovery spelling, and
the bucket is checked **before** the database is touched. The rehearsal asserts each of them. `--no-bucket` restores the database alone, for rolling back an upgrade: the live bucket is not empty, and a schema migration does not touch attachments.

---

### D-96. Error tracking is the logger's `error` lines, sent on if a DSN is set — no SDK, off by default

D-44 specified error tracking for the cloud and it did not exist (#248). Left to grow, it would arrive
as a vendor SDK, a second description of every error beside the log's, and a default someone forgot to
turn off on a self-hosted instance.

**Decided: the logger is the only seam.** `withErrorTracking` wraps it so that whatever is logged at
`error` — a failed request, a failed socket frame, a failed shutdown — is also reported, and what is
sent is the same value `clean` produced for the log: nothing on the never-logged list, at any depth, and
the id of the request it happened in. There is no second place an error is described, so no second place
a secret can leak from. A new `error` line anywhere is reported without being touched.

**Off means absent.** With no `ERROR_TRACKING_DSN` the logger is returned as it came and no tracker
exists; nothing leaves the process (D-44: no telemetry from a self-hosted deployment, so there is no
default). A DSN that does not parse, or is not `https://` in production, **refuses to start**, naming the
variable and never repeating the key — the alternative is a deployment that believes it is reporting.

**No vendor library.** A Sentry-compatible envelope (accepted by Sentry and GlitchTip) is one `POST`
over `fetch`. It can never make the process worse: a report that cannot be delivered is counted and
handed to `onFailure`, logged at `warn` (an `error` there would be reported in turn), never retried in a
loop; at most ten are in flight and a burst beyond that is dropped and counted rather than queued, because
an error storm is when memory is least available; a bug in the tracker is caught, logged and ignored by the
caller; shutdown waits for what is in flight.

**Rejected: the vendor SDK.** A runtime dependency with its own supply chain and auto-instrumentation that
patches `fetch` and the HTTP server, for one `POST`. **Rejected: reporting from `onError` in the
framework.** It covers one path and describes errors a second way; the socket router, shutdown and every
future call site would need their own. **Rejected: retrying failed reports.** The log has the line; a retry
queue is memory held during the incident. **Rejected: grouping, sampling and breadcrumbs.** The receiving
service does the first two, and breadcrumbs are request content, which the never-logged list exists to keep
out.

**Not done:** stack frames are sent as the stack text in `extra`, not parsed into frames, so the receiving
service groups by message and type rather than by frame; source maps are not applicable to a server that
runs its source. The client's errors (`apps/web`) are a separate surface and not covered.

**Reversibility:** free. One module and one variable; unset it and the process is as it was.


*Amended 2026-10-09 (a second-round audit that pointed it at a collector that accepts and never answers):*
"it can never make the process worse" was not true of three things. (1) A report had no timeout, so ten
silent connections held every slot for ever: of 25 failing requests ten were delivered and no error was
ever reported again until restart, nothing said reports were being dropped, and SIGTERM ran to the whole
ten-second deadline. A report now gives up after five seconds; drops are announced at `warn`, at most once a
minute, with the running total; and shutdown waits for the reporter two seconds at most and abandons what
is left. A redirect is not followed (`redirect: 'manual'`): a report goes to the host in the DSN and
nowhere else. (2) Stack traces named the machine — `/Users/…`, `/home/…`, the build directory. Absolute paths
are made relative to the working directory, to the package inside `node_modules`, or to the file name
alone, in the stack, the message and every string in the fields; a request path such as `/api/channels`
is not a place on the machine and is left alone. Run again: 25 failing requests, ten delivered, one drop
notice, the next five delivered after the timeout, SIGTERM answered in two seconds.

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
- **O-4 · Rate limiting — the number.** The limiter is written (D-66); the budget it enforces is
  §5.5's working value, ten frames a second with a burst of twenty, per connection, and that value
  is still a guess. Phase 0 sends little — messages, subscriptions, pings — so nothing it does can
  confirm or refute the number; typing indicators (Phase 1) are the volume that will. *Closed by a
  measurement during Phase 1 dogfooding:* the highest frame rate a connection reaches in normal
  use, as the 99th percentile over a week, and the count of `RATE_LIMITED` refusals that week —
  which must be zero for legitimate use. Recording both needs the structured logger (#127).
- **O-7 · What the command palette is built on.** D-52 named a Radix combobox; Radix does not
  publish one (`docs/spikes/frontend-budget.md`). `cmdk` is built on Radix and is what the budget
  measurement used; a listbox hand-built on `@radix-ui/react-popover` is the alternative, and the
  argument for primitives — that focus and ARIA fail *silently* when hand-written — applies hardest
  to exactly this component. *Decide with #138, and measure it.*
- **O-6 · The two markdown packages D-36 named as categories.** *"A small CommonMark/GFM
  renderer"* and *"a sanitising serialiser"* are descriptions, not choices — they sat in the stack
  table beside real packages as though something had been decided. Surfaced by D-59's column, which
  had nowhere to put them. Both are Phase 1, both are chosen together because the client renderer
  and the server sanitiser have to agree on what they accept, and the fixture suite D-36 requires is
  what will prove they do. *Decide when the markdown pipeline is built.*
- **O-5 · Scroll virtualization.** Inline expandable threads produce variable-height rows,
  which is the hardest UI problem in the product. `UX.md` §6 fixes the Phase 1 stance —
  ship **unvirtualized** with a 50-message window — and the scroll-anchoring rules that hold
  either way. What remains open is whether to adopt virtualization at all, decided against the
  `< 100ms` channel-switch budget. *Measure first.*
