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

**Amended 2026-10-12 (#69).** Also recorded: an invitation link made or revoked, a person joining by
one (D-115), and **a message deleted by somebody other than its author** — moderation, with the
message's id and its author's, never what it said. An author taking back their own words is not an
administrative act and is not recorded. Every role-gated write in the permission table
(`testing/permissions.ts`) is held to exactly one row by a test that reads the same table, so an
administrative endpoint added there cannot ship off the trail. Sign-in, sign-out and session
revocation, which have no workspace, are the `sessions` table's to record (D-116).

**Amended 2026-10-13 (D-123).** A channel renamed (from and to) and a channel archived (its name) are
recorded; a topic is not, being somebody's words.

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
`deleted-user-<short>`, `display_name` and `avatar_url` nulled, and the profile's `title`, `time_zone`
and `status_text` nulled — D-131), revokes every session, and sets
`deleted_at`. Messages are retained with anonymised authorship — this is what keeps a team's
technical history intact and is defensible under legitimate-interest grounds, provided it is
documented. A separate, explicit *content erasure* operation tombstones that user's message
bodies (D-9's mechanism, applied in bulk) for the cases where anonymised authorship is not
enough. Two operations, because they answer two different requests and conflating them destroys
history nobody asked to destroy. (Built as D-139, which settles the edges this is silent on: a thread across the
window, what else of a person is theirs, and who may erase.)

**3 · Export is workspace-scoped, admin-triggered, and machine-readable.** NDJSON per table plus
the attachment blobs, produced by a CLI command (D-30) and downloadable once. Phase 2. (Built as D-140.)

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
purlay reconcile:storage    purlay purge:retention        purlay export:workspace (D-140: an operator's command, not scheduled)
purlay sweep:github-deliveries   (D-134 §5)   purlay sweep:email-sign-ins   (D-138)
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

**Amended 2026-10-12 — a job is proven the day it is installed (#440).** The scheduler starts by
running `jobs:first`: once, each job that has never succeeded. Without it a new deployment's
`jobs:status` was red for up to a day, so a monitor alarmed on every install, and whether a job worked
there at all was known only the next night. A restart of a deployment whose jobs have all succeeded
once runs nothing more. Two cases do run a job twice in a row, and are accepted because every job is
an idempotent sweep: a first start just before a job's slot, and a job that has never succeeded,
tried again at each restart. *Rejected:* running
every job at each start, which repeats the nightly work on every restart; and running them from
`scripts/production-init.sh`, which may run before the API has migrated the database.

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

> **Amended 2026-10-11 by D-101.** The rejection above was never measured, and when it was the
> engine `remark` wraps fit the budget with room to spare (`docs/spikes/markdown.md`). D-101 chooses one engine on both
> sides; the two category rows of the table above are what it names. Parts 1–3 stand.

**Rejected — highlighting in a Web Worker by default.** Unchanged from §8.2: for a clamped
12-line block the `postMessage` round-trip costs more than the highlight.

---

### D-37. Phase 0 gets one explicit open-join variable, because its exit criterion is otherwise unreachable

**Superseded by D-115 (2026-10-12).** Invitation links replaced it; the variable is retired, and the
loader refuses it when set so an operator who left it in is told rather than ignored. What follows is
kept as the record of why Phase 0 had it.

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
*(Amended 2026-10-11 by D-102: the document carries this baseline, with inline style and GitHub's
avatar host as two measured exceptions; the API's own responses keep `default-src 'none'`.)*

**6 · `ENCRYPTION_KEY` is AES-256-GCM.** A random 96-bit nonce per record, stored as a prefix on
the ciphertext, with the record id as additional authenticated data. `CONFIG.md` named the key and
never named the algorithm, which is how two call sites end up encrypting differently.
*Amended 2026-10-12 (#113): the cipher's key is derived from the root as D-62 derives the state
key — `HMAC(ENCRYPTION_KEY, "purlay:credential:v1")` — so the two cannot interact; a version byte
precedes the nonce so a later key or algorithm is told apart rather than guessed. One helper,
`platform/crypto.ts`, and a test that no other production source encrypts.*

**Reversibility:** items 1 and 6 are free now and expensive after the first session and the first
stored token. The rest arrive with the features they protect.


> **Amended 2026-10-12 by D-109.** §2: the one upload route takes `application/octet-stream` — a type a
> form cannot send either, so the defence stands; every other mutation is still JSON. §3: an image is
> served inline only as Purlay re-encoded it; every other file, SVG included, as a download.
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
| API idle RSS < 120 MB | Measured by starting the process and reading it. Stable enough to threshold. *Since 2026-10-12, `bun run budget:api` (#73): 80.6 MiB on its first run.* |

**Blocking on regression, not on an absolute threshold:** ACK round-trip p95, fan-out p95, cold
load, channel switch, keystroke→paint. Each is recorded per commit and compared with the previous
measurement; a **jump** fails, a number near the line does not. *Since 2026-10-12 the first two are
`bun run budget:latency` (#73): 19.7 ms and 19.7 ms on its first run against budgets of 120 and 200; a
jump is more than 1.5× the recorded p95 and past 20 ms. CI judges every run against the last
measurement main kept (`actions/cache`, written only by a passing run on main, so a regression that
lands there fails and is not adopted as the baseline).*

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

*Amended 2026-10-09 (#231): the unit is code units **everywhere, and the database now counts them.**
`char_length` counts code points, which is never more than code units — so it refused nothing the
contract accepts and also accepted what the contract refuses: sixteen thousand emoji, which are
thirty-two thousand units and sixty-four thousand bytes of content, that no 64 KiB frame can carry back
out. `0011` replaces the `CHECK` with one that adds a unit for each character outside the Basic
Multilingual Plane, and an integration test writes 8,000 and 8,001 emoji straight to the table. The
cost is stated: a person who writes in emoji gets 8,000 of them, not 16,000, which is what `String.length`
in their composer already says. **Rejected: counting code points in the contract** — the frame proof
below is made per code unit, and four bytes a code point leaves 1,536 bytes for the envelope, under the
4,096 the test requires. **Whitespace-only content is accepted:** neither `PRD.md` nor `UX.md` says a
blank message is not a message, so refusing it would be inventing behaviour; whether the composer
disables Send on blank is a UX decision for the composer.*

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
does not become shorter on the second attempt. **Closed — a race between two first sign-ins of one GitHub account** (a double-clicked callback). It
violated `users_github_id_key` and answered `500`; the insert is now `ON CONFLICT (github_id) DO UPDATE`,
which refreshes the display fields and keeps the first username, and the email-owner check no longer
counts the same account as a stranger. Two simultaneous callbacks are two sessions and one user, tested
on a cloned database. Still `500`, deliberately: a soft-deleted account signing in again (its GitHub id is
never reused, D-38, and the contract has no code for it), and two *different* accounts racing for one
username (`users_username_key` maps to no code).

*Amended 2026-10-09 (#231): sign-in also removes control characters from the login, the display name and
the avatar address — PostgreSQL refuses a NUL in text, so GitHub sending one failed sign-in. A login left
empty becomes `user-<id>`; an email address with one is not an address and is never repaired, since
stripping would make it someone else's.*

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
*(Amended 2026-10-11 by D-102: the client's files are the exception — the HTML document carries its
own policy, a hashed asset is cached for good and every other file is revalidated by entity tag; every
API response keeps the headers above.)*

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


> **Amended 2026-10-12 by D-109 §4.** The server's own limit rises to what an upload needs; the 64 KiB
> bound on every other body is kept at the edge, by `Content-Length`, before parsing — and a bodied
> request with no length is refused.
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

**Amended 2026-10-13 — reads that cost the server have a bucket of their own.** A card (`POST
/api/integrations/github/unfurl`) and an external image (`GET /api/images`) cost the server a call on
the reader's behalf, so they are charged per user. They were charged to the *writes* bucket, the one a
person sends with, and drawing a channel asks for one per link it shows. In the browser suite, a page
of GitHub links went over the burst: the unfurl was answered `429`, and the person's next message
would have been too. They are now charged to `COSTLY_READ_BUDGET`, per user, sixty at once and then
ten a second. **Provisional (O-4)**, like every number here. **Rejected — not charging them:** one
person could then spend the node's outbound calls. **Rejected — a bigger write burst:** it would let
a person send sixty messages at once to make room for drawing.

**Amended 2026-10-13 again, after a security review.** The limiter compares the path the router
matches (`routeOf`: repeated slashes one, a trailing one dropped). The router is not strict, so
`/api/images/` reached the image handler while the limiter, comparing the raw path, charged it nothing.
And calls to GitHub are charged **per workspace** too (`GITHUB_CALL_BUDGET`, a hundred at once, then one
a second, under the hourly quota of the workspace's one token). The unfurl cache is keyed by workspace
and link, and any link is accepted, so one member asking for links nobody wrote spent a call each, and
could spend the token for everyone in minutes. A card refused a call is a plain link and is not cached,
so it is drawn when there is room again. **Provisional (O-4).**

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

**Amended 2026-10-09 — a large subscription is paced.** A second-round audit drove the real client
against the real server: 2,500 watched channels (25 chunks) got 20 acknowledgements and five
`RATE_LIMITED` errors nothing retried; 3,500 (35 chunks) got a close with `TOO_BUSY` (D-84) on every
attempt, so the client looped for good. All chunks left in one synchronous burst.
**Decided: one `SUBSCRIBE` in flight; the next leaves when the last is acknowledged** (matched by
`refId`). A `RATE_LIMITED` or `DATABASE_UNAVAILABLE` answer to a chunk sends it again, with the channels
still watched, after the reconnect ladder's wait (reset by any acknowledgement); any other error moves
on, because waiting will not change it. A close with `TOO_BUSY` starts the reconnect wait at
`TOO_BUSY_BACKOFF_STEP` (4–8 s), never lower than the failures already counted. Cursors are read when a
chunk leaves, and a chunk is dropped if its channel was unwatched while it waited. **Rejected — a
fixed number in flight, or a fixed gap between chunks:** either needs the server's budget (10 a second,
burst 20, `FRAME_QUEUE_MAX` 32), which lives in `apps/api` and may change; waiting for the answer is
correct at any budget and costs one round trip a chunk. **Rejected — importing the budget into the
contract:** a client written against today's number is wrong the day it changes. **Rejected — only
retrying `RATE_LIMITED`:** pacing alone cannot honour a budget that refills with time, and the
fix for the close is to not cause it. Sustained pacing faster than the budget is still answered
`RATE_LIMITED`; the retry is what makes that safe.

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

**Amended 2026-10-09 (second-round audit): the budget is the user's, and so is the number of sockets.** The
per-connection bucket multiplied by the connections a user opened: one user with 100 sockets sent 20
`MESSAGE_SEND` each, all 2,000 acknowledged in about eight seconds with no `RATE_LIMITED`, against HTTP's
ten a second for the same person (D-81). `MESSAGE_SEND` is now also charged to a per-user bucket **shared
with HTTP's write budget**, so a user's writes cost the same over either door and many sockets are one
budget; the per-connection bucket still bounds every frame. A user may hold `SOCKET_CONNECTION_LIMITS.perUser`
(20) sockets and a node `total` (2,000): over them the upgrade is refused before a socket is bound — `429
RATE_LIMITED` for the user, `503` for the node. Upgrades that all passed that check at once are held to the
cap when they bind, by closing the excess with `TOO_BUSY`. A socket that stops reading costs up to 4 MB before
it is closed (D-70), so the node-wide cap is also a memory bound. **Provisional (O-4):** unmeasured, as every
number in this family. **Rejected — one bucket per user in place of the per-connection one:** it would make a
runaway tab starve the user's other tabs of pings and subscriptions. **Rejected — counting sockets in the
database:** the hub already knows, and a query per upgrade is a read on the door.

**Amended 2026-10-09 (second-round audit): a socket that cannot say who is on it is told in a frame.** When
the identity read on open failed after the upgrade was admitted, the framework answered with a raw
`{"error":…}` body that is not a `ServerFrame`; the client took it for malformed and reconnected into the
same failure at once. The open now catches it, writes the cause to the log once, sends an `ERROR` frame from
the contract and closes: `CLOSE_CODES.TOO_BUSY` when the database had no connection to give, the new
`CLOSE_CODES.INTERNAL` (1011) otherwise. The client reconnects with its backoff either way.

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

**Amended 2026-10-09 (second-round audit): a socket is listening before its session is confirmed.** The hub
read the session and only afterwards did the socket subscribe to `session:` and `user:`, so a sign-out
published between the two reached nobody and the socket stayed open and authenticated — a `MESSAGE_SEND`
sent in that window was acknowledged and stored. The hub now reads the session, calls `listen` (which
subscribes), and **reads it again**: a sign-out before the second read is seen by it, one after is heard on
the topic, and no instant is in neither. Reproduced deterministically by a hook that runs the sign-out when
the first read returns. **Rejected — subscribing to a topic named after the cookie's token:** the topic would
carry a credential, and the session id is what the rest of the system names.

**Amended 2026-10-09 (second-round audit): a replay never outlives a revocation seen while it was read.** A
subscription is authorised, the member is removed and `ACCESS_REVOKED` published, a message commits, and
the replay — read after the removal — carried that message to the socket ahead of the notice. The hub now
remembers which channels were revoked while a connection's frames were being held, and does not write
replayed messages of those channels; the notice still follows. Deterministic: the replay read's seam
publishes the revocation and commits a message before reading. **Rejected — authorising again after the
read:** a second query on every subscription for a race the hub already hears about as an event.

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

*Amended 2026-10-09 — a deadlock against live traffic is retried, and "for an instant" was wrong:* a
second-round audit ran migration 0010 against live sends. At about 150 writes a second ten runs in ten
were untouched; at about 5,000 the migrator was ended with `deadlock detected`. An `ALTER TABLE` is granted its
exclusive lock only after every transaction already using the table, and a send takes `messages` and then
`channels` where the migration asks for them the other way round, so under load the two wait for each
other and PostgreSQL ends one. The migration's header said the lock was held "for an instant"; it is held
for as long as it takes to be granted.
**Decided: a migration is run again when PostgreSQL ends it with SQLSTATE `40P01`**, at most five attempts
in all, waiting 250, 500, 1000 and 2000 ms, each retry reported (`onRetry`: the CLI prints it, the API logs
it at `warn`), and the last deadlock thrown as it was when the attempts run out. Nothing else is retried: a
violation, a syntax error and a timeout belong to the migration or the data. **Why this is safe, for each
kind of file.** A transactional migration is rolled back whole by the deadlock, so running it again starts
from the state it started from the first time. A non-transactional migration may have committed earlier
statements, and the unit of retry is the *file, from its top*, not the statement that was waiting: D-86
already requires such a file to be safe to run again from the top, because a crash and a restart do exactly
that. A single statement is not retried on its own, because the one that was ended might be a `CREATE INDEX
CONCURRENTLY` that left an invalid index, which only its file's own `DROP INDEX IF EXISTS` clears.
**Rejected — retrying a statement:** that. **Rejected — retrying every error:** it hides a bad migration
behind a delay. **Rejected — taking the application's locks first, or locking the table up front:** it blocks
every writer for the duration, which is the cost the non-transactional form exists to avoid.
**Operators:** run migrations at low traffic. A retry makes a deadlock survivable, not cheap; a node migrating
on start under heavy load may need several attempts, and the log says so.
**A corrected comment in an applied migration is allowed, by a table in `migrator.ts`, not by editing
silently.** The files are checksummed whole, so a corrected comment looks like an edited statement and
would make every database that applied the migration refuse to start. `COMMENT_ONLY_EDITS` names the
checksum those databases recorded and the checksum of what the file *does* (comments removed, whitespace
collapsed, `executableText`); the edit is accepted only when both match, so a change to any statement is
refused as before, and the new checksum is recorded on the next run. A test fails if an entry stops
describing its file. The header of 0010 is the first use; 0007's earlier correction predates checksums and
was adopted instead. **Rejected — ignoring comments in every checksum:** it would change what every
recorded checksum means and makes any comment edit invisible, including a misleading one.

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

**Amended 2026-10-09 (second-round audit): what a retry publishes is the stored row as it is now.** Once
messages can be deleted, a retried send of an id the database already holds would, if it published what the
retry carried, republish the original content of a message that has since been tombstoned (D-9). The
constraint on the retry's publish: **it reads the stored row and publishes that — tombstone included — and
never the content the retry sent.** Today's `send()` returns the stored row on a repeated id; the delete
endpoint's work is to keep it so, and its test must retry a send of a deleted message and see a tombstone.

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


*Amended 2026-10-09 (a second-round audit):* every `actions/checkout` left the job's token in
`.git/config`, where any later step — an installed package's script included — can read it. No job pushes,
so none keeps it: `persist-credentials: false` everywhere, and `scripts/workflow-pins.test.ts` fails a
checkout without it (shown failing on nine before the change).

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

*(Amended 2026-10-11: while Actions cannot run, `scripts/release-image.sh` publishes a merged commit
from a machine — a commit on `origin/main`, from a clean tree, after `verify` with the database, built
once for the server's platform, smoke-tested, then pushed as `sha-<commit>` and named by digest. It is
not the workflow's equal and says so: the image carries no provenance or SBOM, it is smoke-tested
before the push rather than as the pushed digest, and no `main` tag moves. It is for the gap and
nothing else; when the pipeline runs, it publishes. Rejected: waiting for the pipeline, which would
leave S-1 with nothing to dogfood; building on the server, which puts a toolchain on it and runs an
image no digest names.)*

**What stays with #224.** This is the API. Serving the built client from the same origin waits for
the prerendered shell (#141), and the image grows a stage for it then; the production compose
assumes only that one origin fronts the API. *(Amended 2026-10-11: #224 added the middle stage, which
builds the client; only `apps/web/dist` reaches the runtime stage, which sets `CLIENT_DIST` (D-61,
D-102).)*

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

*Amended 2026-10-09 (a second-round audit):* the `image` workflow had a path filter, so a pull request that
broke the Dockerfile ran no check at all, and a check that does not run cannot be required. It now runs on
every pull request and decides inside the job (`scripts/pr-touches.sh`) whether there is anything to build;
when there is not, its steps are skipped and it reports success. And the publish job **built a second time**
instead of promoting what had been tested: on main the image is now built once, pushed **by digest** (untagged,
with provenance and an SBOM), the same smoke test is run against that exact digest, and only then is it given
its tags (`sha-<commit>` and `main`) by `imagetools create` — a retag, not a rebuild. Exercised locally against a
registry: the digest the build reported is the digest `:main` resolves to, the attestation manifest is
there, and the smoke test passed on the pulled digest. The check names to require: `build` (pull requests).

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

*(Amended 2026-10-11: the built client is served by the API itself (D-102), so the proxy keeps one
upstream. Compression is the proxy's — `encode zstd gzip` — and the API sends bodies as they are.
Rejected: compressing in the API, which a self-hoster behind a proxy of their own would pay for twice,
in the process whose memory is budgeted.)*

**Not here, deliberately:** the scheduler container (D-30; there are no jobs yet), and multiple API nodes (D-25; the
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


*Amended 2026-10-09 (a second-round audit):* the `restore-rehearsal` workflow had the same path filter and
now runs on every pull request, deciding inside the job whether the change touches what it exercises, so
`rehearse` can be a required check. The weekly run and a push always rehearse.

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

**Amended 2026-10-13 (#492) — the client's render failures.** Still not reported to the tracker, and
still no client endpoint or SDK for it: that would be a new service for what this decision left out on
purpose. What changed is where a failure lands: a boundary around the routed screen, inside the shell
and keyed by the address, so the rail and the sidebar outlive it; and one directly under the words, for
anything else that can still be said in the person's language. Each offers Reload and Go home as full
loads. The report is React's own, to the console. **Rejected:** a boundary above the words — it could
only speak English, and the catalogue that failed is what it would need.

---

### D-97. Visual values are tokens in one file; the vocabulary is generated and the build judges it

D-52 said a raw value in a component is a lint error, and `UX.md` §9 listed the values in prose.
Nothing turned either into code with one owner (#137). The first question was whether Tailwind's
theme alone could enforce it, and the spike (`docs/spikes/design-tokens.md`) measured that it
cannot: with the default theme replaced by our tokens, `bg-red-500`, `p-7`, `rounded-lg` and
`text-sm` stop existing — and `z-50`, `duration-300`, `border-2`, `w-[13px]` and `bg-[#fff]` keep
building, because Tailwind makes them from a bare number or an arbitrary value whatever the theme
says. Lint alone is no better: it sees syntax, and `z-50` is ordinary syntax.

**Decided: one source, a generated vocabulary, and three independent refusals.**

**1 · One source.** `packages/tokens/tokens.json` holds every colour in every theme, the spacing,
radius, shadow, size, stacking, stroke, duration and easing scales, and the type styles. The file is
shaped so the design system it came from can still read it; **this repository owns it** from now on
and the design system is re-synced from it, not the reverse. The schema is stricter than the design
tool's: unknown keys are refused, a colour must be written in every theme (a theme never inherits —
inheritance is how a light theme ships with one dark panel), a spacing step must sit on the 4px grid,
there is no weight above 600, no motion over 200ms, and no font file (the stack is the system's own).

**2 · Generated, committed, checked.** `bun run tokens:generate` writes `tokens.css` (custom
properties, no framework), `theme.css` (the Tailwind binding) and `names.ts` (the names as types).
They are committed so they can be read, and `bun run tokens:check` — in `verify` and in CI — fails if
they differ from what the source would produce, the same shape as `.env.example` and the database types
(D-45). Light is declared after dark so the later block wins on `<html data-theme>`; every motion
token is `0ms` under `prefers-reduced-motion`.

**3 · Tailwind's default theme is never imported.** The stylesheet takes `preflight` and `utilities`
and the generated `theme.css`, so the vocabulary is exactly the tokens. `@theme inline` keeps
utilities pointing at the custom properties, which is what lets the theme change at runtime. A type
style is one `@utility` that sets family, size, leading, weight and tracking together, because the
theme namespace has no key for a style's family.

**4 · Three layers refuse a raw value, each seeing what the others cannot.**
- *The file* (`parseTokens`): shape, grid, weights, motion, themes, aliases.
- *Syntax* (`purlay/no-raw-visual-value`, lint): an arbitrary Tailwind value or property, a string that
  is a colour or a length, a literal in a `style` object, a numeric `width`/`height`/`strokeWidth`, a
  class list assembled with `${}`. Demonstrated in `verify-enforcement`.
- *Tailwind's own output* (`styles.test.ts`): every class the application writes is compiled against
  the real stylesheet, and fails if it builds to nothing (a typo, a palette class) or to a raw value
  (`z-50`). Classes are found with the TypeScript parser in the places that are *for* classes —
  `className`, `cn`/`clsx`/`cva`, and a variable named `…Classes` — because Tailwind's own scanner
  takes every word of every comment for a class.

**5 · Contrast is arithmetic, and complete.** `pairs.ts` states which colour must be readable on which
(4.5:1 for text, 3:1 for a control's edge and the focus ring) and the build computes it in every theme.
Every colour must be in a pair or in `EXEMPT` with a reason, so a colour added without deciding what it
must be readable against fails. The usage notes carry no figure: a number in prose is a second copy.
The first run found a real defect in the design system's seed — `border-strong` was 2.85:1 on a
mention row in the dark theme, below the 3:1 the notes claimed — and it is fixed in the file.

**6 · Icons: `lucide-react`, behind one component.** `components/icon.tsx` is the only importer
(lint), the vocabulary is `glyphs` — a screen asks for `channel`, not `Hash` — the size is one of
three `size-icon-*` tokens that sit beside the caption, body and title styles, and the one weight is
the `stroke-icon` token (2.25 units on the 24-unit grid, which is 1.5px at 16px). `Icon` accepts no
pixel size and no stroke width, so there is no second weight to ask for. Measured against
`@tabler/icons-react` with twelve icons in a production build: Lucide +2.4 KB gzipped, Tabler +1.2 KB;
the marginal cost per icon is the same, ~0.08 KB, so the gap is a fixed base of about 1.2 KB. In
Vite's dev server the pre-bundled barrel is 1.5 MB for Lucide and 4.4 MB for Tabler. Both are
`sideEffects: false`; Lucide is ISC, Tabler MIT. **Chosen: Lucide**, accepting about 1.2 KB of the
250 KB budget for the smaller catalogue to audit and the lighter dev server.

**7 · The measurements of the approved prototype are tokens, found by running the rule on the
prototype.** The first screens were drawn as a prototype and approved before any component existed
(`UX.md` is the behaviour, `tokens.json` the values). Running this decision's own rule over that
prototype found five lengths with no token — the height of a control (28px), of the channel header
(48px), the timestamp column of a message row (56px), a mention badge (18px) and a presence dot (8px)
— and each became a `size-*` token rather than a literal, bound to the utility that reads it
(`h-control`, `h-header`, `w-gutter`, `h-badge`/`min-w-badge`, `size-dot`) because `--height-*` is the
namespace Tailwind reads for `h-` and `--container-*` the one for widths, measured and not assumed. A
badge is bound twice, as a height and as a minimum width: one digit is a circle and two are not. The
prototype also drops the 56px workspace rail for a switcher in the sidebar header, which `UX.md` §2
still draws; `size-rail` stays until that section is rewritten with the screens. D-110 brings the rail back,
holding only destinations that already exist.

**8 · Amended 2026-10-10: a name shared by a theme key and a token is a utility, not a key.** The
first screens in a real browser showed a serif font, 24px icons and square corners: Tailwind writes
every theme key to `:root` even under `inline`, so `--radius-md: var(--radius-md)` was written after
the token's own `--radius-md: 6px`, won, and — a custom property that refers to itself being invalid —
the radius, the icon size and the whole font stack fell back to the browser's. Every test that
compiled classes passed, because none ran a cascade. The generator now refuses such a key and writes
the utility that reads the token (`rounded-*`, `size-*`, `shadow-*`, `font-*`); `radius-full` became
`radius-pill`, because Tailwind's own `rounded-full` is a static utility the generated one would
have sat beside; and `e2e/tokens.e2e.ts` reads the computed values in a browser, in both themes.

**Rejected — Tailwind's theme plus lint alone.** Measured above: it cannot see `z-50`, and a typo
builds to nothing silently.

**Not adopted, and not evaluated — Style Dictionary.** A generic token transformer; the three
checks that matter here (readable contrast, a complete decision for every colour, a vocabulary check
against Tailwind's output) would have been written either way, and it adds a build dependency and a
configuration for the transform we do in under 300 lines. A rejection on cost and not on a
measurement, and it is recorded as one.

**Not adopted, and not evaluated — the ESLint plugins for Tailwind.** The changelog said a spike was
owed to find out which of them refuses an arbitrary value before either entered the stack. None
enters, so nothing is owed: they judge class names as text, and the question this needed answered is
what Tailwind *builds*.

**Rejected — a second weight, or a pixel size, on `Icon`.** The point of the component is that they
cannot be asked for.

**Reopened when** a web font is wanted (the schema forbids one: adding it is a decision and a budget
line), a transition longer than 200ms is wanted, Tailwind changes what `@theme inline` or the
`--text-*` namespace means (the vocabulary test fails first), or a second theme beyond dark and light.

**Reversibility:** the values are free to change. The *shape* — one file, generated outputs, the
refusals — is cheap to keep and costly to add later, which is why it is built before the first screen.

### D-98. The client is built end to end: no screen without its backend, and the owner pulls the wedge forward

The tokens (D-97) and the approved prototype exist; the client does not. This records the analysis
that decides the order and the edges before any screen is written, because the expensive mistakes in
a client are architectural and cheap to make in the first week.

**What the analysis found.**

1. *The backend serves less than the prototype shows.* Phase 0 has sign-in, workspaces, channels,
   messages (keyset) and the socket. Threads, resolution, the open-questions view, read state,
   reactions and DMs are Phase 1 (`API.md`) with no contract in `@purlay/types` — but the schema
   already has the columns (`parent_id`, `resolved_at`, `resolved_by`, the thread counters,
   `last_read_message_id`, the unread counters, `reactions`, `mentions`).
2. *The transport is done and the rest is not.* `apps/web/src/realtime` holds the connection,
   reconnect, cursors and clock, tested. There is no router, data layer, store, i18n, theme switch,
   accessibility harness or browser test.
3. *The budget decides the tools.* 250 KB gzipped initial, with the empty shell already about 60 KB
   (`PRD.md` §5). Every dependency below is justified against that number, and the build fails when
   it is exceeded (#140).

**Decided by the owner (2026-10-10): every control on a screen works against a real backend, end to
end.** D-53 already said no screen ships with a state unhandled; this adds that no screen ships with an
action unbacked — a button wired to a fixture is the prototype feeling D-53 exists to prevent, and a
fixture backend is a second implementation of an API that would have to be rewritten against the real
one. **`PRD.md` §4 and D-4 bind the phases, so this is the exception stated, not assumed:** the owner
pulls forward the slices of Phase 1 the approved prototype *is* — the wedge and what it needs to be
usable — and nothing else:

| Slice | Backend | Client |
|---|---|---|
| Phase 0 as specified | exists | sign-in, workspace and channel list, create channel, message list, composer, optimistic send, scroll anchoring |
| Threads and resolution | replies (`parentId`, I-1), thread counters, `GET …/thread`, `POST`/`DELETE …/resolve`, `GET …/unresolved` | the thread (inline; in a panel since D-122), Resolve/Reopen, the open-questions view |
| Read state and mentions | `@username` parsing (D-12, D-29), unread counters, `PUT …/read` (I-3, I-6) | bold channels, mention badge, the *New* marker |
| Reactions | `PUT`/`DELETE …/reactions/:emoji` | React, counts |
| DMs | `POST …/dms` (I-5) | People section |
| Navigation | none — the palette reads what the client already holds | `Cmd+K` palette, shortcut reference |

**Not pulled forward, and not built:** editing and deletion (O-1), attachments, search, the
notification inbox, Deep Work, invitations and roles, presence and typing (ephemeral, D-7), GitHub
cards and every Phase 2 item. The prototype's deploy, CI and diff cards were illustrations of what a
developer's channel contains; they need the GitHub integration, are Phase 2, and are not in the
client. An empty slot in the interface for any of them would be a control that does nothing.

**Every slice ships in one order:** the shape in `@purlay/types` first (`CONTRIBUTING.md`), then the
module and its integration tests, then the HTTP door and the socket frame (two doors into one
service, `API.md` §5), then `API.md`, then the client against it, then the browser test against both.

**What this decision adds to the client.** It builds on D-18, D-41, D-50 and D-52: React + Vite SPA
with a prerendered shell, TanStack Query for server state, Zustand for the realtime buffer, Radix
for dialog, menu, tooltip and popover, typed catalogues over `Intl`. Covers #138, #23–#27, #101,
#109, #139, #140 and #141.

**1 · Two themes, now.** `UX.md` §9 said light arrives in Phase 2, and D-53 said snapshots are taken
"in every theme that exists". Both are amended: dark and light ship together, because the tokens were
written with both (contrast is computed in each) and a theme added after the screens is a theme
retrofitted onto them. The theme is the OS preference until the person chooses; the choice is per
device (`localStorage`), applied before first paint by a same-origin script so there is no flash and
no inline script for the content security policy (#112) to refuse. A development-only **gallery**
renders every component and state in both themes side by side; it is also what the visual snapshots
photograph, so a theme can not be added to the product and missed by the tests.

**2 · A router of our own, about a hundred lines.** The client has a handful of routes. A router
library costs 15–25 KB of the budget to match a path and call `history.pushState`; the alternative is
a typed route table, a `Link` and a hook. Rejected: `react-router` and `@tanstack/react-router`
(size, and loaders and search-param machinery for routes this small); `wouter` (small, but untyped
paths). Reversible: call sites use `Link` and `useRoute`, so replacing the module changes one
directory.

**3 · The ports are interfaces, the adapters are the browser's.** The data layer takes `fetch`, the
socket opener, the clock, the id generator and `localStorage` as arguments (D-46 does the same for
the realtime code). A test drives a failed send, a dropped connection or a slow page by hand; a
Playwright test drives the same code in a real browser against the real API.

**4 · The message body is text, with exactly three exceptions.** The markdown pipeline is Phase 1
and its renderer and the server's sanitiser are chosen together (O-6), so this decision does not
choose a markdown package. The renderer recognises fenced code, inline code and bare `http(s)` links,
emits React nodes (never `dangerouslySetInnerHTML`, so there is no HTML to sanitise), and shows
everything else literally with its line breaks. It is one function, `renderContent`, which O-6's
renderer replaces without touching a caller. *(Amended 2026-10-11: O-6 is closed by D-101 — one
engine on both sides, so there is no separate server sanitiser to choose. #43 replaced the renderer:
`renderContent` now draws D-101's narrowed tree, and the three exceptions are gone.)* Fenced code is highlighted by Shiki with grammars
loaded on first use (D-36), coloured by the `--syntax-*` tokens, so the initial chunk holds none.

**5 · Read position is the server's.** The unread marker is placed at `last_read_message_id`,
written by `PUT /api/channels/:id/read` when the bottom is reached or the channel is left, never on
mere render (`UX.md` §6). It follows the person across devices, which a client-side value would not.

**6 · Performance is a feature with numbers.** Typing paints the person's own message in the same
frame (state, not network); history is rendered as a bounded window of 50 (`UX.md` §6, O-5) with
`content-visibility: auto` on rows outside the viewport; code, the highlighter, the dialogs and the
gallery are separate chunks; a row is memoised on `(id, editedAt, delivery state)`. The browser test
measures keystroke-to-paint and channel switch against the budgets, and `bun run budget:web` fails
the build, naming what grew, when the initial chunk passes 250 KB gzipped.

**7 · What the palette is built on (closes O-7 for this decision).** Radix publishes no combobox. The
palette is a Radix `Dialog` holding a hand-written listbox that follows the WAI-ARIA combobox
pattern, with `axe` and a keyboard-path test in CI — the argument for primitives (focus and ARIA fail
silently when hand-written) is met by testing exactly that, and `cmdk` is not adopted: it is a
dependency on top of Radix for the part of the pattern that is thirty lines.

**Rejected — wiring the prototype's thread screens to a fixture backend.** It would demo well and
cost more than it shows: a second implementation of an API, a contract guessed in the client, and a
rewrite when the real one differs. The owner's instruction is the opposite, and this records why it is
right.

**Rejected — one large pull request.** The work lands as one commit series per slice so it can be
reviewed and, if needed, split along the issues; `large-change` applies where a single slice exceeds
the budget.

**Reversibility:** the router, the content renderer and the highlighter each sit behind a single
module on purpose. The theme mechanism and the ports are expensive to retrofit and cheap to write
first, which is why they are first. Pulling a Phase 1 slice forward is not reversible once data
exists, which is why each ships with its integration tests and its documentation in the same change.

### D-99. The wedge's backend: what a write touches, and what "needs you" means

D-98 pulls threads, resolution, read state, mentions, reactions and DMs forward and orders the work
contract-first. The schema has the columns; four rules were not written down anywhere, and each is a
correctness question rather than a style one, so they are decided here before two people implement them
in parallel.

**1 · "Needs you" is one number.** `unread_mention_count` is what is waiting for *this person*: an
`@username` naming them, any message in a direct message, and a reply in a thread they started or have
already answered (D-29, which has its own words for why the third counts). `unread_count` is every
message by someone else past their read position, replies included. The first never exceeds the second
(I-6), and it becomes a `CHECK` now that the service that defines it exists (`SCHEMA.md` §11 said it
would). A resolution *notifies* the root author (a `thread_resolved` row) and moves no counter: it is not
a message, so counting it would put the two numbers in disagreement the first time they are recomputed.

**2 · The send is one transaction (D-35, completed).** In order: insert the message (a reply first
checks that its parent exists, is in the same channel, is a root and is not deleted — I-1); bump the
parent's `thread_reply_count` and `thread_last_reply_at`; set `channels.last_message_at`; parse
`@username` and write `mentions`; write `notifications` (one row per person per message, the strongest
class wins: mention, then direct message, then thread reply; never the sender; none for a membership at
`notification_level = 'none'`); and increment the counters in **one** `UPDATE … RETURNING` over the
channel's other members. Commit. *Then* publish `MESSAGE_CREATED` on the channel, `THREAD_UPDATED` for a
reply, and `CHANNEL_STATE` on each recipient's `user:` topic from the rows the `UPDATE` returned. The
server's numbers travel; no client increments its own (D-13), so two devices cannot drift.

**3 · Mentions are parsed, and `@here` is refused.** `@name` is a mention when it is not inside inline
or fenced code, is not preceded by a word character, `@` or a backtick, and names a person who can see
the channel (every workspace member for a public channel, the members for a private one or a DM);
matching is case-insensitive on `username`. An unknown name stays text. `@here`, `@channel` and
`@everyone` fail the send with `VALIDATION_FAILED` on `content` — the parser's rejection D-12 promised —
and the composer says so before the request, the server being the authority. Mentioning yourself is
text, not a notification.

**4 · The read position moves forward only, and the counters are recomputed, not patched.** `PUT
…/read` is refused for a message not in the channel (I-3, as `MESSAGE_NOT_FOUND`), is a no-op for a
position at or behind the current one, and otherwise sets `last_read_message_id`, sets `unread_count` to
the count of messages by others past it and `unread_mention_count` to the lesser of that and the unread
notifications of the mention classes past it, marks the notifications at or behind it read, and
publishes `CHANNEL_STATE` to the person's other devices. A decrement could underflow under a race; a
recompute from rows cannot. The recount is bounded by what is unread and uses an index that leads with
`(channel_id, id)` — the migration adds it if the measurement says the existing one is not enough.

**5 · Resolution.** Any member who can see the channel may resolve or reopen (`ARCHITECTURE.md` §7.4),
on a root with at least one reply; anything else is `THREAD_NOT_RESOLVABLE` (I-8, and "only roots
resolve"). Resolving a resolved thread, or reopening an open one, answers the message and publishes
nothing: it changed nothing. `GET …/unresolved` lists roots with replies and no resolution from the
channels the caller can see (D-34), newest first.

**6 · Reactions.** `PUT` and `DELETE` are idempotent, answer the message's whole set, and publish
`REACTIONS_UPDATED` only when the set changed. The emoji is one Unicode emoji (the contract's `emoji`
format); a message holds at most twenty distinct ones, which bounds a frame an attacker could otherwise
inflate.

**7 · Direct messages.** `POST …/dms` takes a person who is a member of the workspace (`USER_NOT_FOUND`
otherwise), gets or creates the channel for the sorted pair (I-5), makes both members, and publishes
`CHANNEL_ADDED` to the other person only when it created one. A note to self is a DM with one member.

**8 · One reader of messages.** History, thread, open questions, replay and the send's answer all build a
`Message` through one function that fetches reactions and mentions for the whole page in two queries —
never one per row (the rule D-13 states for counters applies to every page). Replay still carries roots
only; a client reconnecting refetches the threads it has open, because a reply missed during the gap is
not a root and has no cursor in the feed.

**9 · Doors.** Replies are sent over the socket (`MESSAGE_SEND` gains `parentId`) or HTTP; resolution,
reactions and read state are HTTP only and are heard on the socket. They are infrequent, they have no
optimistic row that must paint inside a frame, and a second implementation of each over the socket is a
second place for them to differ.

**Amended 2026-10-10 (review of the first implementation).** None of this reverses a rule above; each
closes a case the first implementation answered wrongly or left to chance.

- *Rule 1 and 4 — a message behind the reader is not unread.* A client may send an id up to a minute in
  the past (D-33), so a message can sort *below* a position someone has already read past. It is
  counted for a member only when their position is before it; otherwise it is stored, its notification
  is already read, and the recount (`id > position`) agrees with what was stored. Before, the stored
  number sat above the recount and the badge could not be cleared by reading. The recount also skips
  deleted messages and the notifications of deleted messages.
- *Rule 2 — who is told of a reply.* The root's author and the most recent **50** earlier repliers
  (`THREAD_PARTICIPANTS_MAX`), and only those who can still see the channel now — a member of the
  workspace, not deleted, and for a private channel or DM still in it (D-34). A resolution notifies
  the root's author on the same condition. The bound is on what one reply can write; older
  participants still have the thread.
- *Rule 2 — publishing after the commit.* Published in stages (the room, then the thread, then each
  person's numbers), the publishes of a stage concurrently in chunks of 32; a publish that fails is
  logged and does not fail a write that committed, nor stop the ones behind it. A repeated send
  re-tells from the rows; a repeated `PUT /read` re-tells the caller's devices (rule 4 is otherwise
  unchanged: the position never moves back). D-88's "a retry announces again" is kept and extended.
- *Rule 2 — whole-state frames are ordered.* `THREAD_UPDATED`, `REACTIONS_UPDATED` and
  `CHANNEL_STATE` carry `version` from `state_version` on the row they are made from (migration
  `0015`); the client drops an older one (`API.md` §5). Reactions therefore now update the message row
  once, as the last write of their transaction, and contend with a reply to the same message for that
  instant; the advisory lock still serialises reactions with each other.
- *Rule 5 — the open-questions index.* `idx_messages_unresolved` holds only roots with a reply (migration
  `0014`): 6,975 buffers and 37 ms became 41 buffers and 0.07 ms where the caller sees every channel and
  the questions are rare, and no worse where they are common.
- *Rule 7 — a direct message with an erased account* keeps its channel and `peer.id` and shows a
  placeholder. *Idempotence is `200`, creation `201`* (`API.md` §4); it is not a conflict.
- *Ids have one spelling.* The wire form of every UUID is lower-case; an upper-case id is a validation
  error rather than a second spelling of the same id that string comparison, ordering and the read
  position would each treat differently.

**Rejected — counting unread on read.** D-35 rejected it; the recount in rule 4 is a different thing (it
runs when a person reads, bounded by what they had not).

**Rejected — a `thread_resolved` increment.** Rule 1.

**Rejected — letting the client keep its own counters and reconcile.** Two sources of one number.

### D-100. The interface has an identity: floating cards, avatars, and one typeface served from here

**Amended 2026-10-12 by D-110**, which replaced the typeface and the cards with a flat interface set in
Inter and JetBrains Mono. **Amended again 2026-10-12 by D-119**, which puts messages in bubbles with your
own on the right: the avatars stand; the absence of bubbles and the single edge do not.

The first client (D-98) was built to the approved prototype and passed every test, and the owner
looked at it and said it looked like a prototype. They were right, and the reason is worth keeping:
the tests judged that classes compiled and that values were tokens, and no test judged whether the
screen was *designed*. Three things made it read as unfinished, and each had been decided on
purpose, which is why they are decided again here and not patched.

1. **The system font.** `fonts` in `tokens.json` was empty by rule (D-39: no third party is asked
   for a file; D-97's schema made adding a face a decision). A product set in whatever the machine
   has looks like every other product on that machine.
2. **No avatars, a log with one edge.** UX §3 argued that a channel scans like a log. It does, and
   it also reads as a terminal printout: nothing names who is speaking before the words do, so every
   row has the same weight.
3. **No surface hierarchy.** Sidebar, feed and composer were one flat panel divided by hairlines,
   and "no shadow" was a rule (UX §9) that left nothing to show where one thing ends.

**Decided.**

- **A typeface, served from this origin.** IBM Plex Sans for prose, IBM Plex Mono for code, the
  time and channel names. Chosen because its mono is drawn as a sibling of its sans rather than as
  an afterthought, so the two sit on one line (`ECONNRESET` in a sentence) without a seam; it is
  licensed under the SIL Open Font License, which the repository ships beside the files
  (`public/fonts/OFL.txt`). The files are copied into `apps/web/public/fonts`, not fetched from a
  font service: D-39 stands, the CSP needs no new source, and no request leaves the origin.
  Two subsets (Latin; Latin Extended, which holds ğ ş İ — the owner writes Turkish) in the weights
  the type scale uses, so a page downloads only what its characters need (`unicode-range`).
  `font-display: swap` over a system stack: text is never invisible. `tokens.json`'s `fonts` array
  is now a list of `{ family, weight, file, range }` whose `file` must be a path under `fonts/`
  (a URL is refused by the schema, and a test fails if that changes).
- **Cards on a canvas.** A tinted `canvas` colour is the window's ground; the sidebar and the
  channel are `surface-100` cards with a `radius-lg` corner and one `shadow-card`. `radius-md`
  grows from 6px to 8px with it. Amends UX §9's "no depth": the *cards* float; a message, a code
  block and a control still have none.
- **Avatars, and still no bubbles.** An avatar (initials on one of six tints chosen from the
  username, so it is stable and needs no image fetch and no stored colour) sits in a fixed column.
  The text is not put in a bubble: a bubble turns a code block into a box inside a box and narrows
  every line, which is the wrong trade for a tool whose messages are half code. Own messages stay
  on the same edge. The gutter token is retired. This amends D-98 §no-avatars and UX §3.
- **A new UI primitive, `Avatar`, justified under D-52:** it replaces nothing and exists in six
  places (feed row, thread reply, sidebar person, the person's own footer, the DM header, the palette); six hand-written
  copies would be the "fifty reasonable additions" D-52 warns about. It has one job — initials on a tint —
  and no behaviour. There is no presence dot: there is no presence, and a dot that is always one
  colour would be a lie (`UX.md` §2).
- **The layout is mine to change, not the product's.** Where the sidebar sits, the header's
  segmented control for Feed / Open questions, the composer as a card with a send button on its
  right edge: all of that is presentation. Nothing here changes a contract, a route, a keyboard
  path or a state UX §8 specifies.

**Rejected.**

- *Bubbles, own messages on the right* (the reference the owner showed). Right: the genre's
  convention and what most people have seen. Wrong here for the code-block reason above, and
  because a developer channel is read by following a thread, not a speaker.
- *A variable font.* One file instead of six, but the Latin Extended subset of a variable Plex is
  larger than two static weights, and the type scale uses four weights at most.
- *Google Fonts or `fontsource` at runtime.* A third party in the critical path, against D-39.
- *Photographs from GitHub's `avatar_url`.* The column exists (`SCHEMA.md` §2) and is the right
  Phase 1 upgrade; today it would add an image request per person, an off-origin host the CSP must
  allow, and a layout shift. Initials cost nothing and cannot fail.

**Revisit when** a workspace asks for its members' photographs, which is the trigger for the
`avatar_url` proxy D-39 §4 already specifies.

---

### D-101. One markdown engine on both sides, narrowed to what the product renders, and bounded — closes O-6

O-6 left the two markdown packages D-36 named as categories, and #42 and #43 are the moment they
are needed. Decided by the owner on 2026-10-11, on the measurements in `docs/spikes/markdown.md`.
Each number below is measured there; the bounds themselves are constants in the code, named here.

**1 · One engine.** `mdast-util-from-markdown` (micromark) with four GFM extensions —
autolink literals, strikethrough, tables and task lists — on the server at write time and in the
browser to render. It is the engine `remark-parse` wraps; its trees and remark's were identical on
every probe, and with one engine there is no second parser to
keep aligned, so D-36's shared fixture suite becomes the package's own tests. Its browser cost is in
the spike. The reading lives in
`packages/markdown` (`@purlay/markdown`), which a lint rule keeps free of anything a browser cannot
run.

**2 · Narrowed: the narrowing is the sanitiser.** The engine is configured never to recognise raw
HTML, reference definitions, images, indented code, setext headings, character references or
footnotes; what it does recognise is copied into a tree of the kinds the product draws and nothing
else (`packages/markdown/src/tree.ts`). A link is a link only to an absolute `http:`, `https:` or
`mailto:` URL; anything else is its label's text. An image is a link to the image, labelled with its
alt text, until the proxy exists (#110). Stored content stays markdown (D-36 §2): the server cannot
make stored markdown safe for a renderer it does not run, so the narrowing is applied where a tree
is made — on the server for metadata, in the browser for rendering — and both run the same function.

**3 · Headings are emphasis.** `#` makes a heading, drawn at the body's size in bold: a heading in a
conversation is emphasis, not a title, and a full-size one breaks the feed's rhythm. Decided by the
owner, with *as typed* and *a real heading* rejected.

**4 · Code is a fence.** Four spaces are indentation; only a fence makes code, so an indented log or
the continuation of a list is not turned into a block without a language. Decided by the owner. The
same reasoning switches off the setext underline: only explicit syntax formats.

**5 · Bounded, and a body past a bound is shown as typed — never refused.** The engine is
superlinear on runs of inline delimiters and on unbroken address-like runs (its autolink pass
backtracks), and slow or out of stack on containers opened on one line, inconsistently
(`docs/spikes/markdown.md`). So a body is formatted only inside four bounds, each a constant in
`packages/markdown/src/scan.ts` or `parse.ts`: containers opened on one line
(`MARKDOWN_NESTING_MAX`, with a line ended by `\r\n`, `\r` or `\n`, as the engine ends one),
inline delimiters outside code (`MARKDOWN_DELIMITERS_MAX`), the longest address-like run outside
code (`MARKDOWN_RUN_MAX`), and the depth of the narrowed tree (`MARKDOWN_DEPTH_MAX`). Where code is,
is the engine's own block reading, never a pattern: the first version of this bound was one, and the
agreement test showed it could not follow a fence inside a list item.
A body past a bound is still sent, stored and searchable; it is not formatted. Refusing it was
rejected: it would make a pasted log a failure, a retry after the bounds tighten a different answer
from the first (D-8), and a new error the composer must explain.

**6 · GitHub links: a bounded few per message** (`GITHUB_LINKS_PER_MESSAGE_MAX`), unique and
canonical, in the order they appear. Each becomes a request to GitHub when it is unfurled (#66).
Decided by the owner (five, with ten and three rejected). `metadata` is not on the wire until
something reads it (#44, #66).

**7 · A mention is looked for where the reader sees prose.** The mention parser kept rules of its
own for code and missed a `~~~` fence, so a name quoted in what renders as code notified the person.
The body it reads now has every fenced block the engine reads blanked, so what is drawn as code and
what notifies cannot disagree.

> **Amended 2026-10-12 (#330).** Blanking fences was not enough: the server still stripped inline code
> with rules of its own, so a link labelled `@bob` and `https://medium.com/@bob` notified bob, and a backtick pair
> across a blank line was code to the server and prose to the engine. A mention is now a name **in the
> prose of the tree the client draws** (`proseNames`, `@purlay/markdown`): not in code, not in a link —
> its label or its address — and not glued to the end of either. The server resolves those names, the
> composer refuses a broadcast among them, and the client highlights exactly those occurrences; a test
> renders bodies at every edge and requires the highlight to be the server's names. A body the engine
> does not format (shown as typed, §8) is still read as typed, and is drawn with no highlight.

**8 · The engine failing inside the bounds is a defect, not a refusal.** It is caught around the two
engine calls only — a defect in this package's own code throws — and returned with its cause. The
message is stored and shown as typed, and the server logs an error with the cause and never the
content. Rejected: re-throwing, which would make a body the bounds should have caught a failed send;
and catching around the whole reading, which hid this package's own bugs as the engine's.

**9 · A link carries the address as the browser reads it** (`new URL(…).href`), so the string that
was checked is the string that is rendered. Making an unchecked link impossible to construct — a
brand on the tree, the way D-54 brands a context — belongs with the renderer that consumes it (#43).
*(Amended 2026-10-11, #43: the brand is on the address, not the tree.)* A link's `url` is a
`SafeHref` (`packages/markdown/src/href.ts`): a class whose constructor is private and whose one
factory, `SafeHref.of`, is the check, with a private field that makes the type nominal. An object
literal, a string, or a spread of a real one is not a `SafeHref`; the instance, its prototype and the
class are frozen. An assertion to one is a lint error with no exemption, as D-54's is for a context,
and inside `packages/markdown` any assertion is, because a cast to a node that holds an address
(`as unknown as Inline`) skips the check without naming it. A rule by name cannot see an alias or a
type guard, so the renderer checks `instanceof SafeHref` too, drawing the label as text when a link
fails it: types and lint stop the mistake, the check at the point of use holds against it. Rejected: *D-54's symbol key on the tree's
root*, because a spread copies a symbol key, so `{ ...tree, children: [any link] }` would type-check
as a checked tree — the brand guarded the container, and the danger is one field inside it; and *a
branded string*, which cannot be produced without the very assertion the lint rule forbids, so the
rule would need an exemption in the file that matters most. D-54 rejected a class for a context
because a context must survive serialisation; a tree is built where it is drawn and is never sent.
The shape of a mention (`mentionsIn`) lives in the same package for the same reason as §7: the
server resolves the names it matches, and the renderer highlights with the same pattern, which
retired the client's own copy — it disagreed on any letter outside ASCII.

**Rejected.**

- *Two engines (remark and `marked`).* D-36's original plan. `marked` is 13.3 KB and faster on the
  worst inputs (16 ms), but it is a second reading of the same characters, held to the first by a
  fixture suite that can only test the cases somebody thought of.
- *Extending the hand-written parser.* No dependency, and a grammar the size of GFM to own.
- *A sanitising serialiser to HTML, or `dangerouslySetInnerHTML` behind DOMPurify.* A second
  representation (D-36 §2) and a renderer that trusts markup; the narrowed tree is rendered as
  elements and has no markup in it to be wrong about.
- *Running the parse in a Worker with a timeout.* It bounds time but not the stack, costs a thread
  per process, and a body that times out on a slow machine formats on a fast one.

**Cost of reversing.** Low: no migration, and stored content is unchanged markdown. A different
engine means a different `packages/markdown`, and its tests say what the next one must do.

---

### D-102. The document carries its own security policy, with two measured exceptions — closes #112's baseline

D-39 item 5 fixed the baseline — `default-src 'self'`, no inline script, images from `'self'` and the
proxy — and D-61 put the built client on the API's origin. Until the API served that client (#224) the
question had no response to answer it on: every response carried the API's own policy,
`default-src 'none'`, which on a document would load nothing at all. The demo's front server never sent
a policy, which is why nothing had noticed.

**Decided: two policies, chosen per response, both in `apps/api/src/ingress/http/edge.ts`.** An API
response keeps `default-src 'none'; frame-ancestors 'none'` — it is data, and loads nothing. The client's
HTML document gets `DOCUMENT_SECURITY_POLICY`: `default-src 'self'`, `script-src 'self'` (no inline
script and no `eval`; `theme-init.js` is a file so it needs no hash), `connect-src 'self'` (a same-origin
`wss:` under CSP Level 3), `font-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
`form-action 'self'`, `frame-ancestors 'none'`. The browser suite runs every test under it, on the
production path — the demo's front server sends everything but its login to the API — and fails a
test on any refusal the page reports.

**Two exceptions, each observed rather than argued:**

- **`style-src 'self' 'unsafe-inline'`.** The dialog primitive (Radix, D-52) locks scrolling by writing a
  `<style>` element. With `style-src 'self'` Chromium reports `style-src-elem refused inline` when the
  command palette opens, and the lock silently does not apply. Inline **style** cannot run code; inline
  script stays refused.
- **`img-src` adds `https://avatars.githubusercontent.com`.** Avatars are GitHub's, and the image proxy
  that would serve them from `'self'` is #110. The exception is marked `TODO(#110)` beside the policy and
  is removed with it.

**Rejected: initials instead of avatars until #110.** A stricter policy bought by taking back D-100's
identity for a source that is GitHub's own avatar host. **Rejected: a nonce for the style element.** The
primitive reads one from a global the bundle would have to set per response, which turns a static shell
into a rendered one for a style that cannot execute. **Rejected: the proxy (Caddy) setting the policy.**
Two places would set headers, and a self-hoster running the image behind their own proxy would get none.

**Caching, decided with it.** A file under `/assets` has a content hash in its name and is
`public, max-age=31536000, immutable`; every other file — the shell, `theme-init.js`, the fonts — is
`no-cache` with a weak entity tag made of its size and modification time, answered `304` when it has
not changed. The runtime sends neither an entity tag nor a modification date for a file (measured: a
conditional request was a full `200`), so without the tag every load downloaded the fonts whole. A file
in an image keeps its time for the image's life, so the tag changes with a deployment and not with a
restart. Rejected: hashing each file's bytes per request, which costs a read for an answer the
metadata already gives; a long lifetime for the fonts, whose names carry no hash, so a changed font
would be stale for a year. The document also carries `Cross-Origin-Opener-Policy: same-origin`: sign-in
is a top-level navigation, never a pop-up, so nothing it opens needs a handle back to it.

**Reopened when** #110 lands (drop the avatar host), or when a primitive that needs inline style is
replaced or learns to take a stylesheet.

*Amended 2026-10-15 (#638): the document also carries a `Permissions-Policy`.* Camera, microphone,
geolocation, payment, USB, serial, HID, MIDI, display capture and the Topics API are off — the page uses
none, so anything that ever runs in it cannot either. Two stay the origin's own: `clipboard-write`
(Copy code writes it) and `fullscreen` (a video's own control). Notifications are not governed by the
header; they ask the person (D-126). The list is whole in `edge.ts` and in its test, so a feature
allowed later is a decision; a browser test fails if Chromium objects to an entry or the clipboard stops
working. Rejected: the same header on API responses, which load nothing for it to govern.

---

### D-103. Editing and deleting a message — closes O-1

O-1 asked for the edit window, history retention, and how an edited message in a resolved thread
behaves; #47 needs the answers, and the delete rules beside them. Decided by the owner on 2026-10-11.

**1 · Editing has no window.** The author may edit for as long as the message exists, and the message
says it was edited (`editedAt`). A team that trusts each other gains nothing from a lock on its own
words, and a typo found tomorrow is still a typo. **Rejected: 15 minutes, or a day.** A window makes
the record more trustworthy only where there is a reason to distrust it, and it is the edit history
(Phase 2, `PRD.md` §4) that answers that reason, not a clock.

**2 · No history in Phase 1.** An edit replaces the content; what it said before is not kept.
`editedAt` says that it changed, not what from. Edit history is Phase 2, so this is stated rather than
discovered. *Amended by D-135:* every edit now keeps what it replaced.

**3 · A resolved thread is edited by the same rules.** Resolution is metadata on the root (D-99): it
records that the question was answered, not that the words are frozen. **Rejected: freezing a resolved
thread** — a correction to the answer is exactly what someone reading it later wants to find, and
reopening a thread to fix a typo would announce a question that is not open.

**4 · Only the author edits; somebody else is told `403 FORBIDDEN`.** The 404 rule (D-21) protects the
existence of what a caller cannot see; a member who can read the message already knows it exists, so
refusing them with a 404 would hide nothing and tell their client the wrong thing. Anyone who cannot
see it — another workspace, a private channel they are not in, a deleted message — is told
`404 MESSAGE_NOT_FOUND`, as for every other message route.

**5 · An edit tells the people it names for the first time, and nobody twice.** A name the edit adds
is a mention like any other: a notification, and the mention count where the message is still unread
for them (the same rules as a send, D-99 §1 — a muted member and the author are told nothing). A name
already mentioned, or added before and taken out since, is not told again; a name taken out is no
longer a mention, and what it was told is not withdrawn. The unread count does not move: the message
was already counted. **Rejected: an edit never notifies** — `@alce` corrected to `@alice` would never
reach Alice. **Rejected: withdrawing a notification** — it would have to be unsaid on every device
that already showed it, for a person who has read it.

Somebody already told about the message — the other side of a direct message, the author of the
thread a reply answers — is not told again when an edit names them: one notification per person per
message (D-99 §1), and a second would count them twice and break I-6. They are in the mentions; they
were counted when it arrived. Somebody who joined the channel after the message was written is told
for the inbox, already read: it was never counted unread for them.

**6 · Content the same as stored is not an edit.** It writes nothing and does not mark the message
edited, so a retried request leaves it as the first left it.

**Accepted: the last writer wins.** Two edits are taken one after the other under the row's lock;
there is no precondition, so a late retry of an older edit replaces a newer one. A `baseVersion`
answered with `409` is additive and can come when two devices editing one message is seen to happen.
The message's `state_version` now counts a revision too, ready for the revision frame (#333).

**7 · Deleting** (#47's second slice): the author, or a workspace `owner` or `admin`. The content is
replaced by an empty tombstone (D-9) and the client draws the words; reactions are kept and not drawn.
A deleted **root with replies** stays in the feed as a tombstone with its thread; a deleted root with
none leaves the feed. A deleted **reply** stays in its thread as a tombstone (`Message.deletedAt`:
it occupies its place), so `thread_reply_count` does not drop — a resolved thread cannot lose its last
reply and break I-8. What the message added to unread and mention counts is taken back, never
below zero: a message older than the counters (0013) was never counted, and an author deleting it
must not be refused by a check; the next read recounts exactly. The note in `0014_open_questions_index.sql` that such a thread "drops out of the
index when the count does" is superseded here; the migration is applied and is not edited (D-45).

**Reopened when** Phase 2's edit history lands (§2), or dogfooding shows an edit used to rewrite what
was agreed.

---

### D-104. Private channels, and who brings people into a channel

#49 left creating a private channel undone, and nothing defined how anybody but its creator gets into
one: `join` is public only, and invitations and roles are #50 and #51. Decided by the owner on
2026-10-11: **any member of a channel may bring in somebody from the workspace.**

**1 · A channel is public unless created private.** `CreateChannelRequest.type` is `public` (the
default) or `private`; a direct message is never created this way. A private channel is seen by its
members only (D-34): its creator, and whoever a member brings in.

**2 · `POST /api/channels/:channelId/members { userId }`.** The caller must be *in* the channel —
seeing a public channel is not being in it (`403`; they can join it themselves first), and a private
channel is not seen at all from outside (`404`, the guard's). The person must be in the workspace with
an account that is not deleted (`404 USER_NOT_FOUND`, the same check a direct message makes). Somebody
already in it is `204` again and told nothing. The person brought in is told with `CHANNEL_ADDED` on
their own topic, after the commit, and their client subscribes.

**3 · A direct message stays between its two people** (`403`): its membership is its `dm_key` (I-5).

**Rejected: only the creator, or an admin, adds.** It makes the person who opened a channel its
gatekeeper for good and leans on roles that are #51's; any member is how a small team works, and #51
can narrow it with a role. **Rejected: deferring private channels to #50/#51.** The team needs a
channel a stranger to it cannot read before it moves in (S-1).

**Not yet:** leaving and removing (`POST …/leave`, Phase 1, with #51's roles), and the client's half
— the option when creating, and bringing people in — which is a `web` issue. *Leaving is D-123.*

**Amended 2026-10-13 (#520) — a private channel's name is not private.** Channel names are unique per
workspace across public and private channels (`idx_channels_unique_name`), so creating or renaming a
channel to a name a private channel holds answers `409 CHANNEL_NAME_TAKEN`, and a member outside it
learns that the name is taken. That is accepted: a name is how a channel is found and talked about,
not what is said in it; the members, the topic and every message stay the members' (`404` to anyone
else, D-34). **Rejected:** names unique per visibility — two `#design` channels in one sidebar, and a
migration, for a secret most teams do not keep; answering a free name with the same `409` — a lie
about a real collision.

### D-105. What a search finds, and what it is asked with

D-10 fixed the index and the scope; nothing fixed what a search *means*. Served by #63.

**1 · The words as typed, ignoring case, anywhere in a message.** `ILIKE '%words%'` on
`idx_messages_search`. `%`, `_` and `\` are what the person typed, escaped before they reach the
pattern: a search for `100%` is not a search for `100`. Nothing is stemmed, split or ranked (D-10).

*Amended 2026-10-15 (#700):* "ignoring case" now means by Unicode. Under the database's C ctype
`ILIKE` folded ASCII alone — "çağrı" did not find "ÇAĞRI", "istanbul" not "İstanbul". Both sides are
folded by `purlay_fold` — ICU's root lowering, then I ı İ i as one letter — and compared with `LIKE`
on `idx_messages_search_folded`, built on the same expression. Rejected: *a language's own lowering*
(Turkish lowers I to ı, every other language to i, and one workspace writes both); *a database
created with an ICU locale* (a fresh cluster for every deployment, and identifiers would stop comparing
byte-wise, D-40).

**2 · A trigram at least, and a bounded length, after trimming** (`SEARCH_QUERY_MIN`,
`SEARCH_QUERY_MAX` in `@purlay/types`). Below a trigram the index cannot narrow anything, so a
two-letter search is a scan of the workspace; the maximum bounds the pattern a request may hand to
the database. A query outside them is `400 VALIDATION_FAILED`, never an empty page.

**3 · Roots and replies, open threads and resolved ones; never a deleted message.** A resolved thread
is the answer somebody will come looking for (#38). A deleted message's words are not on any screen,
and search must not be the way back to them (D-103).

**4 · Only in the channels the caller can see** (D-34), asked of the guard once per request and
narrowed in the query, never filtered afterwards. `channelId` narrows to one of them; one the caller
cannot see — another workspace's, or a private channel they are not in — is `404 CHANNEL_NOT_FOUND`,
not an empty page that confirms it exists.

**5 · Newest first, `before` and `limit`, no `after`.** A result list is read from the top; there is
no live tail of a search to follow forwards.

**Rejected: a minimum of one or two characters.** The scan is the cost D-10 refused to pay on the
send path, moved to the read path. **Rejected: words matched separately, in any order.** It is a
query language, and D-10's argument against stemming applies: a person pasting an identifier wants
that identifier. **Rejected: `channelId` outside the visible set answered as an empty page.** It is
the 403-that-confirms-existence in another form.

### D-106. The inbox, and what reading it does to the badge

`API.md` listed the two endpoints and `SCHEMA.md` §7.4 the table; nothing said what the inbox shows or
what marking it read moves. Served by #58.

**1 · One workspace, the caller's own, newest first by when they were told.** A resolution of an old
question is told today, and belongs at the top though its message is old. At the same instant the
message orders them (UUIDv7), then the notification's id, so the order is total and the cursor exact.
`notifications.id` is not time-ordered, so the cursor is a notification of the caller's, compared as
`(created_at, message_id, id)` in the database: its timestamps are finer than a JavaScript date, and a
cursor that went through one sorts after its own row. A cursor that is not one of the caller's
notifications in that workspace is `400`, not an empty page that looks like the end.

**2 · Only from channels the caller can see now (D-34), never about a deleted message.** The rows are
kept (D-15, D-103); the inbox does not show what the person can no longer read. A notification of the
kinds that do not need anybody (`thread_resolved`) is listed like the rest: the inbox is what happened
to you, the badge is what needs you.

**3 · Reading here moves the badge, not the read position.** `unread_mention_count` is bounded by the
notifications still waiting in the channel (D-99 §4), so marking them read counts each channel's badge
again from the rows — one expression, shared with the read position — and tells the caller's devices
`CHANNEL_STATE`. The messages are still unread; they no longer need the person. A channel whose
notifications were already read is not told again. The membership rows are locked first, in one order,
as the read position locks its own, so a read here and a read of the channel at once take turns.

**4 · `{ workspaceId, before }` reads up to and including `before`.** "Mark all read" sends the newest
notification the person saw, so one that arrived after they looked is still waiting for them.

**5 · The query's workspace is asked of the guard first; a body is read against the contract first.**
`GET` names the workspace in its query, so a stranger, a workspace that never existed and a malformed
id are the same `404` before anything else is read, and a key given twice is `400` (the guard and
the schema would each read a different one). `PUT` names it in a body, and every body in this API is
validated before anything is looked up: a malformed id there is `400`, a well-formed one the caller
is not in is the stranger's `404`.

**Rejected: reading a notification moves the channel's read position to its message.** It would mark
everything before it read, which the person has not seen. **Rejected: deleting a notification once
read.** It is the history the inbox exists to keep (D-15). **Accepted:** the full list (not
`unreadOnly`) has no index of its own and is found through the `(user_id, message_id, type)` unique
index, sorted per request; a person's notifications are few enough that this is measured before it is
indexed (D-49). **Accepted:** `created_at` is the time the writing transaction *started*, so a send
that commits after a later one sorts behind it. A page already read past it, or a "mark all read" sent
with a `before` the person saw, can pass over a notification that arrived late by the length of one
send — it is then not on that page, or read without being shown. The window is milliseconds and the
message is still in its channel, unread; ordering by a commit-ordered key is the fix if dogfooding
shows it (#58).

**Amended 2026-10-12 (#350) — one lock order for messages, memberships and notifications.** A delete
updated the notifications before the memberships, the reverse of a read, and took the message row
`FOR UPDATE`, which a read position's foreign key check waits on: a person reading a channel while
its author deleted a message naming them deadlocked with the delete, and one failed as a `500`. Now
every writer takes, in order, the message row `FOR NO KEY UPDATE` — what its own `UPDATE` takes
anyway; edits, deletes and resolutions of one row still take turns, and a row that only points at it
is not made to wait — then the channel's memberships ordered by `user_id` (one person's, ordered by
`channel_id`), then the notifications. A send carrying attachments (D-109 §7) locks the uploads it
links, after the message row, and its workspace row last, beside the channel's: an upload holds the
workspace row and locks no existing upload, so the two cannot wait on each other.

**Amended 2026-10-13 (#491) — the tab's title says the same fact.** Phase 1 tells nobody anything
outside the page (D-12), so a tab in the background had no way to say something was waiting. The title
is `(N) <place> · <workspace> · Purlay` — `#channel`, the other person's display name in a direct
message, or the screen's own name — and N is the sum of the channels' `unreadMentionCount`: what the
badges and the inbox dot already say, read from the same cache entry the socket writes, so the three
cannot disagree. Absent at zero, and absent in Deep Work, where the badges are not drawn either.
**Rejected:** counting unread messages, which would light the tab for every message in a busy channel —
the noise D-12 exists to prevent; and counting only mentions and direct messages, a second definition
of "needs you" beside `NEEDS_YOU`, which D-29 and D-107 already settled.

### D-107. What each notification level is told

`notification_level` has been in the schema since the start (`'mentions'` by default), and delivery
honoured `none`; nothing said what `all` meant, and no endpoint set any of them. Served by #52; decided
in the owner's standing instruction to decide and proceed, and open to their reversal.

**1 · Three levels, per membership.** `mentions` (the default, because quiet is the product): what is
addressed to the person — named, a direct message, an answer in a thread they started or joined (D-29).
`none`: nothing at all, participation included; the messages are still unread, and the channel is
still bold, but the badge never moves. `all`: every message by somebody else, as a direct message is.

**2 · `all` is a notification of its own kind, the weakest.** `channel_message` (migration `0017`): the
inbox says why a person was told, and "somebody wrote in a channel you follow closely" is not a
mention. A stronger reason for the same message — a mention — is still the one row they get (D-99 §1),
and it is counted on the badge like the others: one list, `NEEDS_YOU`, read by the send that counts,
the read that recounts and the delete that takes back, so the three cannot disagree.

**3 · `PUT /api/channels/:channelId/notification-level { level }`, the member's own row.** A channel the
person can see and has not joined is the stranger's `404`, the read position's rule (D-99 §4): there is
no membership to set. Not retroactive: what was told stays told, and a badge comes down by reading, not
by muting. The channel carries the caller's level as `notificationLevel`, null for a non-member.

**Rejected: `all` as `direct_message` notifications.** The inbox would say "wrote to you" for a message
written to a channel. **Rejected: lowering the badge when a channel is muted.** It would make muting a
way to mark things read without reading them, and the two would disagree the next time a read recounts.
**Not yet:** telling the person's other devices that the level changed — they see it the next time
they read the channel list.

### D-108. What Deep Work does before there is anything to interrupt with

D-15 made Deep Work a server-side state that suppresses delivery and expires. There is no push and no
sound yet, so "delivery" needed saying. Served by #59; decided in the owner's standing instruction to
decide and proceed, and open to their reversal.

**1 · Started until an instant, never open-ended.** `{ active: true, until }` with `until` ahead of the
server's clock and at most `DEEP_WORK_MAX_HOURS`; `{ active: false }` ends it. The contract refuses an
`active` with no `until`; the window is the server's to check, being a question about its clock.

**2 · It ends by itself, by comparison.** Every reader — the membership in `/api/me`, the delivery that
writes a notification — asks whether `until` is still ahead of its clock. No job ends it, so no
scheduler can be missing (#72) and no node can disagree about the moment.

**3 · Nothing is lost.** While it lasts a notification is written and counted exactly as without it,
and written `suppressed_by_deep_work` — which is what an interrupting delivery (Web Push, a sound) will
honour when it exists, and what a digest can be built from. Resolutions of the person's questions are
written the same way. The client silences what it shows of them (the badges) and says, in the header,
until when (`UX.md` §8).

**Rejected: suppressing the badge counters on the server.** The counters are what a read recounts;
holding them back would make them disagree with the rows, and lose what came in during the quiet.
**Rejected: an open-ended Deep Work.** D-15 asks for expiry so it cannot be left on; a bound is the
expiry nobody has to remember to set.

**Amended 2026-10-13 (#526).** A change of Deep Work is published as `DEEP_WORK_UPDATED`, with the
workspace and until when, on the person's own `user:` topic: their other tabs and devices draw the
same bar at once instead of after a reload. Nobody else is told — it is the person's own quiet. A
tab whose socket was down reads the memberships again on reconnect.

### D-109. Attachments: what is stored, who may read it, and the edge that lets 25 MiB in

D-16 ships attachments in Phase 1; `ARCHITECTURE.md` §9 gives the flow; the spikes chose Garage and
Bun's `S3Client` (`docs/spikes/object-storage.md`) and `Bun.Image` (`docs/spikes/image-pipeline.md`),
nothing installed. An adversarial review of the first plan found the edge, memory and tenancy questions
below unanswered. Decided in the owner's standing instruction to decide and proceed, each on the
restrictive side, and open to their reversal. Served by #53, #54, #111, #369, #370.

**1 · An image is stored re-encoded, never as uploaded.** PNG, JPEG, GIF and WebP — recognised by their
bytes, the declared type never trusted — are decoded, turned upright, downscaled to at most 2560 pixels
on the longer side (never up), and stored as WebP; the thumbnail is the same, at 512. The re-encoding is
what strips EXIF (GPS position, camera serial — the spike), and it is the condition D-39 §3 sets for
serving an image inline. Anything else is a file: stored as sent, always served as
`application/octet-stream` with `Content-Disposition: attachment`. An SVG is such a file: downloaded,
never drawn — "never served as SVG" (D-39 §3) by the same rule as every other non-image.

**2 · Memory is bounded before a decode, not after.** A side of at most 16384 pixels and at most 40
million pixels, read from the header before decoding (`Bun.Image`'s own default is a backstop, not the
bound); at most two decodes at once per node. A 25 MiB PNG can decompress to gigabytes; the size limit
bounds the wire, these bound the process. The numbers are bound to the database's CHECKs by a test.
*Measured 2026-10-12 (Bun 1.4.2, macOS arm64), one 40-million-pixel PNG re-encoded at a time and
several at once: +118 MiB RSS for one decode, +258 MiB for two, +450 MiB for four, 136–158 ms each.*
Two keeps a node's peak near a quarter of a gigabyte above its idle; a freed slot is handed to the next
waiter, never given back, so a newcomer cannot make it three.

**3 · `POST /api/workspaces/:workspaceId/uploads?id=&name=`, raw bytes, `application/octet-stream`.**
The workspace is the quota's axis; there is no channel until the message. `id` is a UUIDv7 the client
chose, so a retry after a timeout finds the row it made (D-33's rule); `name` is the file's name, at
most 255 characters with no control or bidirectional-override characters. The body is the file's
bytes with exactly `application/octet-stream` — not `multipart/form-data`, which a cross-site form can
send: D-39 §2's defence is that a form cannot send the type, and this keeps it with a type a form cannot
send either. A missing type is still refused. The route reads no body (`parse: 'none'`) until the
session, the membership and `Content-Length` (required; at most `attachment_size_limit`) have passed, and
then reads it with a cap: 25 MiB is never buffered for somebody who is not let in.

**4 · Every other request keeps the 64 KiB edge.** The server's limit rises to what an upload needs; a
JSON route refuses a body over `JSON_BODY_MAX_BYTES` by its `Content-Length`, and a bodied request with
no length (chunked) with `411`, before it is parsed (D-80's promise, kept by a different mechanism).

**5 · Quota and orphans.** An upload is refused (`413 STORAGE_QUOTA_EXCEEDED`) when the workspace's
`storage_used_bytes`, plus what is uploaded and not yet attached, plus this file, would pass
`storage_quota_bytes` — checked and inserted under a lock on the workspace row, with the object written
*outside* the transaction so no pool connection waits on the store. A person holds at most 20
unattached uploads per workspace and may delete their own; the sweeper of the rest is #71's. *Amended
by D-141:* a discarded or swept upload's objects are queued with its row's delete and tried again until
the store lets them go.

**6 · Who may read one.** The uploader, while it is unattached; afterwards whoever can see the channel
of its message (D-34) — and nobody once that message is deleted (D-103 §7: the tombstone hides what was
said, and what was shown with it). One guarding query, one refusal (`404 ATTACHMENT_NOT_FOUND`), as
`requireMessageById` (#200). An attachment belongs to its message's workspace by a constraint, not by
care (D-90). Downloads carry `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, a sandboxing CSP,
an RFC 6266 file name, and `Cache-Control: private, max-age=31536000, immutable`: the bytes behind an id
never change, and the cache is the person's own.

**7 · A message may be its attachments alone.** A pasted screenshot needs no words; the words become
optional only when there is at least one attachment, at most 10 per message.

**Rejected: the original kept beside the re-encoding.** It is the copy that leaks GPS, and nothing in
the product shows it. **Rejected: `POST /api/uploads` with `multipart/form-data`** (the earlier
`API.md` row): the form type the CSRF defence exists to refuse. **Rejected: a channel-scoped upload
route.** `attachments` has no channel; the scope would mean nothing the schema can hold.

**Amended 2026-10-12 (#54, sending them) — the edges §7 left unsaid**, decided in the owner's standing
instruction to decide and proceed, and open to their reversal:
- **Linking.** A send names `attachmentIds`; each must be the sender's own, unattached, in this
  workspace. Any other — unknown, somebody else's, already sent, another workspace's — is one
  `404 ATTACHMENT_NOT_FOUND` that tells them apart for nobody, and the message is not written. Two
  sends racing for one upload: one has it, the other is that refusal.
- **No words, nothing attached** passes the contract and is refused by the service as `400` on
  `content`. *Rejected: a union of two shapes in the contract*, which says the same rule in the type
  but reports a refusal as the whole body, so a client cannot point at the field.
- **A retry with the same message id** answers the stored message, whatever ids it names (D-8): what
  it carried was decided by the send that wrote it.
- **An edit still needs words.** A message sent with no words can be given some; a message's words
  cannot be emptied by an edit, whatever it carries. Removing an attachment is not an edit.
- **The count.** Linking moves the bytes onto `storage_used_bytes` in the send's transaction
  (`SCHEMA.md` I-7). Deleting the message does not lower it: the bytes are still stored, as its words
  are (D-9), and the orphan sweep (#71) takes only uploads nobody ever sent.
**Accepted, stated:** the S3 adapter is exercised against Garage locally and in the deployment's smoke
test, not by CI, which runs PostgreSQL alone (`CONTRIBUTING.md` §2); the store is a port, and every
test of the rules runs against a double.


**Amended 2026-10-12 (#388): an upload says how far it has got.** `fetch` reports nothing of a request
body until the answer, and a streamed body would be chunked, which the edge refuses (`411`). So an
upload alone goes over `XMLHttpRequest` (`http.upload`), whose `upload.onprogress` reports the bytes
sent; its answer and its failures are read by the same two functions a request's are (`answerOf`,
`failureOf`), so the second transport cannot believe what the first would refuse. The chip says
*Uploading… 42%* as a `progressbar`. Not measured on a link, and not needed to be: at 2 Mbit/s up,
`ATTACHMENT_BYTES_MAX` is about a hundred seconds, which a word that never changes cannot fill.
---

### D-110. The interface is flat and quiet: one tone for getting around, one for the conversation

**Amended 2026-10-12 by D-118**: navigation is dark navy in both themes and the accent is blue.

D-100 gave the interface an identity, and the owner replaced it on 2026-10-12 with one of their own: a
written brief and a reference screen, applied to Purlay as a preview they approved. They chose its
visual language and its layout, both themes, and a rail that holds only what already exists. The brief
was written for a generic product called *Relay* and drew things Purlay refuses or has not reached;
those were not taken (below), and nothing here changes a contract, a route, a keyboard path or a
state `UX.md` §8 requires.

**Decided.**

1. **Inter for prose, JetBrains Mono for code**, served from this origin exactly as D-100 serves a
   face: the Latin and Latin Extended subsets (ğ ş İ are in the second) by `unicode-range`, the SIL
   Open Font License beside the files, `font-display: swap` over a system stack, and no request off
   the origin. Sans in 400/500/600, mono in 400/500. **Mono now marks what is machine text** — code,
   a time, a count, a key, a hash — and a channel's name moves to the sans: it is a place you go, not
   something you type into a shell. Amends D-100's typeface.
2. **Flat surfaces.** No canvas and no floating cards. Navigation — the rail and the sidebar — shares
   one tone, the conversation sits on the window's ground, and one hairline divides them. Regions are
   separated by tone, not by boxes. Elevation is kept for what actually sits *above* something: an
   overlay, a message's hover controls, the composer, and the cards inside a message (a code block, a
   GitHub card), which get a one-pixel border and a one-pixel shadow. Amends D-100's cards and UX §9.
3. **The rail returns, holding only existing destinations.** 56px, left of the sidebar: the workspace
   tile (the switcher menu that was in the sidebar header), then channels, the inbox (a dot while
   anything needs you — the mention badges' fact, D-106), open questions (a neutral count, since the
   badge is for what needs you) and search, and at the foot a settings menu —
   theme, language, shortcuts. Every entry is a route or a menu that exists today; the rail adds no
   destination. Its top 28px is left empty as a drag strip for the desktop shell (D-14). The sidebar
   narrows to 240px and keeps the workspace name, the jump field, channels, people and your own row.
   Reverses UX §2's switcher-instead-of-rail and D-97's note retiring `size-rail`.
4. **Colour.** Light is the brief's palette — neutral greys and one deep navy accent — and dark is
   derived from it in the same terms: zinc grounds, a light navy for accent *text*, and the filled
   accent kept dark navy under white. **Neither theme is designed first any more**; both are designed
   together and the OS preference still chooses (D-98 §1). Three of the brief's values fail WCAG AA
   and are used only where contrast is not owed: its tertiary grey on text (text takes the next grey
   down), its strong border on a control whose edge is its only affordance (that edge takes a grey that
   reaches 3:1), and its status greens and ambers as text (text takes the existing `*-text` shades).
   The pairs the generator checks are the arbiter; this sentence is not.
   **A fill cannot become a word.** The accent is dark navy in both themes, so a navy word on a dark page
   would be illegible; a colour token may say `"role": "fill"`, and the generator binds it to Tailwind's
   `--background-color-*` and `--border-color-*` namespaces only — `bg-accent` exists, `text-accent`
   does not, and `styles.test.ts` proves it. Its words are `accent-text`.
5. **Scale.** Type 12/16, 13/20, 14/22, 15/22, 16/24, and a message body of 14px at 1.6. Radius 4
   for a key, 6 for a control, 8 for a row and an avatar, 10 for a card, 12 for the composer and an
   overlay. Avatars are rounded squares — initials on a tint, as D-100 decided — at 36px in the feed,
   28px in a thread and for your own row, 20px in the sidebar's lists. The feed is at most 760px and **hangs from the left edge**,
   which settles the disagreement between UX §2 ("centred") and the token's note ("left-aligned").
   *Amended by D-119:* a channel's feed and composer are centred, since a conversation with two edges
   needs both of them on screen.
6. **Density is in what is shown, not in how tightly it is set.** A sidebar row is 32px and message
   groups are 16px apart; the product stays dense because it shows one column and no chrome, which is
   what UX §1.2 was for. Amends that principle's wording, not its intent.
7. **Motion.** Hover and focus ease in 120ms; the palette opens in 150ms, scaling from 0.98 with a
   fade. A message still never animates in. Every duration is 0ms under reduced motion, as D-97
   already enforces. Amends UX §9's "effectively none".
8. **The composer has three buttons**: bold, a code block and a mention. Each *inserts markdown* into
   the plain textarea and each has a key; none of them is a WYSIWYG control, which UX §5 still refuses.
   *Amended 2026-10-12 (#370):* a fourth, **Attach a file**, beside them. It inserts no markdown: it
   picks files to upload (D-109), as pasting and dropping one do. It is no formatting control, so the
   rule that the composer has no WYSIWYG stands.
   *Amended 2026-10-13 — the `@` list (`UX.md` §5).* The mention button and a typed `@` are now
   followed, at the first letter, by a list of people, after the Superdesign *new-message-picker*
   suggestions. Three choices in it were not obvious:
   - **Who is offered is who the server would tell** (`resolveMentions`, D-34). A public channel: the
     workspace, from `GET /api/workspaces/:workspaceId/members`, which the sidebar has already loaded.
     A direct message: its other person (`Channel.peer`). A private channel: **its members now**,
     from `GET /api/channels/:channelId/members` (D-123), and still in the workspace — read only for a
     private channel, and nobody is offered while it is being read. Never the writer, never a handle
     the broadcast refusal would catch (D-12). Someone who wrote there and has left is not offered: a
     mention of them would reach nobody.
   - **The text box stays a text box.** The WAI-ARIA combobox pattern puts `role="combobox"` and
     `aria-expanded` on the input, and HTML allows neither on a `textarea` — axe reports both
     (`aria-allowed-role`, `aria-allowed-attr`; run on the component before this was written). The
     `textarea` carries what a `textbox` may: `aria-autocomplete="list"`, `aria-haspopup="listbox"`,
     and while the list is open `aria-controls` and `aria-activedescendant` naming the current
     `option`; a polite status says how many match. Focus never leaves the box.
   - **While it is open the list owns ↑ ↓ Enter Tab and Esc.** Enter chooses and never sends; Esc
     closes that `@`'s list and nothing else. So that it does not take Enter for nothing, it opens
     only for a letter after the `@`, and closes once a handle is typed in full and matches nobody else.

   - **A handle typed out is first**, above every name that merely starts with it: `@ali` and Enter
     mention Ali, never Alice because her name sorts first. **The list opens only at the end of a
     name**: with the caret inside one already written, choosing would leave the rest of it behind.

   *Rejected:* who the client has seen in a private channel's loaded messages — first built that way,
   it offered people who had left (the server drops them) and missed quiet members; the member list
   of D-123 is exact. The whole workspace in a private channel — it
   offers names the server then drops without a word (`CONTRIBUTING.md` §6.4). `role="combobox"` on the
   `textarea` with the audit rule switched off for it — an exception to satisfy a pattern HTML forbids
   (D-48). Opening on a bare `@` — punctuation often enough that a list taking Enter would swallow a send.
9. **The day** is a label at the column's left with a rule after it, not a centred chip. Amends UX §3.

**Not taken from the brief, and why.**

- *A thread panel on the right.* PRD §4.2 is the product's wedge: threads open inline under their
  parent. The reference's panel is the one thing the product exists to refuse. *Reversed by D-122:*
  the owner chose the panel.
- *A call button, CI and deploy event rows, an incident banner, an Integrations section.* Audio and
  video are permanent non-goals (PRD §6); webhook feeds are Phase 2 (PRD §4, D-5). A diff block is the
  Phase 2 diff viewer.
- *Presence dots and photographs.* There is no presence to show yet (UX §2); photographs wait on the
  `avatar_url` proxy (D-100 §revisit).
- *The name.* The product is Purlay.
- *A light theme only.* D-98 §1 stands.

**Rejected.**

- *One change for the whole interface.* Every visual snapshot moves at once and a regression is
  invisible among sixty intended ones. It is delivered in four steps — tokens and type; the frame;
  the channel; the other screens — each green on its own.
- *Carrying it as a third theme until it is finished.* Two half-designed languages in the product,
  and D-97 makes a third theme a decision of its own.
- *Keeping the brief as a document.* Its values now live in `packages/tokens/tokens.json` and its
  layout in `UX.md`; a third copy that nothing checks is what `CONTRIBUTING.md` §6.1 forbids. It stays in
  the history, in the change that added it (#366).

**Cost of reversing:** the token file, the fonts and the shell's components. No contract, route,
schema or stored value depends on any of it.

**Revisit when** the desktop shell (D-14) is built: the drag strip's height is a guess until the
window draws its own controls.

---

### D-111. What managing members means: who may touch whom, and what a removal takes

`ARCHITECTURE.md` §7.4 gives owners and admins "manage members and roles" and owners alone "transfer
ownership", and I-2 keeps the last owner. It did not say where one ends and the other begins, nor
what a removed member keeps. Served by #51; decided in the owner's standing instruction to decide
and proceed, and open to their reversal.

**Decided.**

1. **Making somebody an owner is transferring ownership**, so only an owner does it; and an owner's
   row — their role or their membership — is an owner's to change. An admin manages members and
   admins, themself included. A member manages nobody: `403 FORBIDDEN`, for what the caller is.
2. **Ownership moves by adding before taking**: an owner makes another owner, then may step down.
   A change that would leave none is `409 LAST_OWNER`, and every change takes the workspace row's
   lock and reads the roles — the caller's as well — under it, so two owners stepping down at once
   leave one: the second finds it is no longer an owner.
3. **A removed member loses the workspace's channels**, their channel memberships deleted with
   the workspace one, and their sockets are sent `ACCESS_REVOKED` for every channel they could see
   (D-85). Their messages stay, by their name (D-9, D-22).

**Rejected: an admin who may change owners.** It would let the second-highest role demote the
highest, which is a transfer of control under another name. **Rejected: keeping a removed member's
private channel memberships** for if they come back: a person removed from a team is not quietly
still in its private rooms, and coming back is joining again.

### D-112. The unfurl cache is the workspace's, and a GitHub outage is held off for a minute

D-23 moved the unfurl cache into `link_previews`, keyed by the URL's hash, and `SCHEMA.md` §8.2 said
the endpoint would keep private repositories' cards to the workspace whose token fetched them.
Keyed by the URL alone, nothing in the table could: a card fetched with workspace A's token for a
private repository was a cache hit for workspace B pasting the same link — a private title, an
author and a state shown to people with no access. Served by #66; decided in the owner's standing
instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **The key is the workspace and the link** — the SHA-256 of the workspace id, a newline and the URL. A card is the
   workspace's, fetched with its token; a negative is too, since a link missing for A's token may be
   there for B's. The table stays unscoped by column; the scoping is in the key.
2. **What is fetched is built from parts.** The request names a `GitHubLink` — github.com, an owner,
   a repository, `pull` or `issues`, a number — and the API address is made of those, so no address a
   person wrote is ever fetched. A repository named `.` or `..` is refused: resolved, it would step out
   of `/repos/{owner}/{repo}` and send the workspace's token to another GitHub path (found in review).
3. **GitHub failing, or answering what is not a pull request or issue, is no card for a minute**, logged
   at `warn`: a five-minute card and an hour's negative (§8.3) are for answers; an outage is held off
   so every render does not ask again, and a GitHub that recovers is asked within a minute.
4. **A token that does not open** (`ENCRYPTION_KEY` changed) is logged at `error` and no card is
   drawn — never a token silently treated as absent, and never a 500 for a link.

**Rejected: sharing public cards across workspaces** by caching a card unscoped when its repository is
public. Whether a repository is public is itself something only a token can see, and a repository
made private after the card was cached would keep showing; the saving is a request per workspace.
**Rejected: CI status and review decision on the card** in this slice: each is another request per
unfurl against the same rate limit, and the card is useful without them.

---

### D-113. The browsers the client supports, and what holds the line

Nothing recorded which browsers the web client supports; the client already relied on
`URL.canParse` and regular-expression lookbehind, so a floor existed by accident (#331). Served by
#331; decided in the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided: the last two years of the evergreen engines** — Chrome and Edge 120, Firefox 121, Safari
and iOS Safari 17.2 — named once, as `browserslist` in `apps/web/package.json`.

**Held three ways, because the spike showed each sees only part** (`eslint-plugin-compat` 7.0.2,
run on 2026-10-12 against probes):
1. **`compat/compat` in lint**, reading that list: a constructor or global one of them lacks fails
   (`new URLPattern` was refused for Safari 17.2 and Firefox 121; `structuredClone` and
   `IntersectionObserver` passed). It does **not** see static methods — `URL.canParse` and
   `Promise.withResolvers` passed even against Safari 12 — and its data lacks some APIs
   (`CloseWatcher` passed though Safari has none).
2. **`lib: ES2023`** in the client's TypeScript project: an ES2024 built-in fails to compile
   (`Object.groupBy` did). Bun's own types, which the project includes for its tests, re-add some
   (`Promise.withResolvers` compiled) — the gap that is left.
3. **`build.target`**, derived from the same list in `vite.config.ts`: syntax the targets lack is
   lowered for them.

**Accepted, stated:** a static method on a web or ES object that Bun's types declare, and an API
missing from the compat data, still pass all three. Closing that needs the client's sources
typechecked without Bun's types — a separate project for the tests — which is its own change.
Nothing was loosened to make this work. The browser suite still runs Chromium alone (D-52).

**Rejected: a hand-kept list of APIs with their minimum versions.** It would be wrong the first
time a browser shipped one; the compat data is maintained by the people who measure it.

---

### D-114. Typing indicators: announced by the client, rationed by the server, forgotten by both

`PRD.md` §4.1 puts typing indicators in the MVP, ephemeral and in memory (D-7); nothing of them
existed (#411). Served by #411 and the typing half of #60; decided in the owner's standing
instruction to decide and proceed, and open to their reversal.

**Decided:**
1. **A `TYPING` client frame names a channel; the room hears a `TYPING` server frame** naming the
   channel, the person and `ttlMs` — how long the announcement holds from when it arrives
   (`TYPING_TTL_MS`, six seconds, in `@purlay/types`). The sender is answered with nothing unless
   it is refused: an announcement is not a request.
2. **Authorised on every frame**, with the guard the send uses: a channel the sender cannot see is
   `CHANNEL_NOT_FOUND`, and neither its room nor the registry hears of it. A subscription is not
   used as the proof — `SUBSCRIBE` subscribes before it authorises (D-83, D-85), so for a moment a
   subscription exists that was never allowed — and an announcement held for it in that moment is
   dropped with the refusal, as every frame about a channel is (#412).
3. **The server rations, whatever the client does.** `PresenceRegistry.startTyping` lets an
   announcement reach the room when the person was not typing there, or once the last one is half
   spent; anything in between reaches nobody. A listener's window is renewed before it runs out, and
   a client announcing on every key costs the room one frame per three seconds. A message sent over
   the socket ends the window (`stopTyping`), so the next keystroke is news at once.
4. **Nothing says "stopped".** A listener forgets a person when the announcement runs out or their
   message arrives — so a closed tab, a lost connection or a restart clears itself, and there is no
   frame to lose.
5. **The registry's interface grows with its features** (`ARCHITECTURE.md` §6.1), as the frame union
   does (§5.2): the typing half now; online presence when it is built.

**Rejected:**
- *`typingIn` replayed on `SUBSCRIBE`.* A late subscriber hears the next announcement within half a
  window; a read that exists for those three seconds is an interface and a frame nobody needs yet.
- *A "stopped typing" frame.* It is the frame most likely to be lost — sent as a tab closes — and a
  lost one leaves a person typing forever; expiry cannot be lost.
- *Rationing only in the client.* The room's cost would then be whatever the most talkative client
  chose.

**Accepted, stated:** a message sent over HTTP does not end the sender's window on the server, so
their next keystroke within three seconds is not announced; listeners have already cleared them on
`MESSAGE_CREATED`. On two nodes each lets one announcement through for a person typing on both — a
frame too many, never a wrong answer (D-25). `PRD.md` §4.1 lists presence in Phase 1 and `UX.md` §2
in Phase 2: this decides typing only, and the owner decides where presence belongs.
*Since decided: Phase 2 (D-120).*

---

### D-115. Invitations are links — closes O-2

Phase 0 let a second person in through one operator variable (D-37), and O-2 left open how a
workspace invites anybody else: an email, a shareable link, or GitHub-organisation membership. #50
needs the answer. Decided in the owner's standing instruction to decide and proceed, and open to
their reversal.

**Decided: a shareable link.**
1. **An owner or an admin makes one**; a member is `403`, judged on the role as it is in the writing
   transaction, read `FOR SHARE`, as member management reads it (D-111). It opens for
   `INVITATION_TTL_DAYS` (seven),
   to anyone signed in who holds it — signed in, not "with GitHub", so Phase 2's other sign-in (D-11)
   needs nothing new here — as many times as it is used, until it expires or is revoked.
2. **It is a bearer secret, kept as a session is** (`platform/tokens.ts`): 32 random bytes, hex, shown
   once in the answer that makes it; only its SHA-256 is stored. It travels in request bodies
   (`/api/invitations/preview`, `…/accept`) and in the client's address after `#` — **never in a path
   or a query**, because the request log writes every path and redaction is by field name.
3. **Joining makes a `member`, into no channel** — as open join and making a workspace do; the person
   joins channels as anybody does. **It never changes a membership**: an owner who opens their own
   link stays the owner (I-2).
4. **A person removed after a link was made is not let back by it.** A removal is a decision; a link
   handed out before it must not undo it. A link made after the removal lets them in. Read from the
   trail's `member.removed`, which the removal writes in its own transaction (D-26).
5. **One refusal**: unknown, expired (at the instant, as a session), revoked, its workspace deleted, or
   its holder removed since — `404 INVITATION_NOT_FOUND`, which says nothing about which.
6. **Revoking wins a race with joining.** A join reads the link `FOR SHARE`, so a revocation that
   committed first refuses it; revoking twice at once is recorded once (`UPDATE … RETURNING`).
7. **Making, revoking and joining are audited** in the transaction that does them
   (`invitation.created`, `invitation.revoked`, `member.joined` with `{ via: 'invitation',
   invitationId }`); nothing counts uses on the link, so a join locks no shared row.
8. **A person not signed in when they open a link** signs in first; the client keeps the token in the
   tab's `sessionStorage` across the round trip — the callback returns to the application's root, and
   a fragment does not survive it — and resumes the join. A return address carried through sign-in
   was rejected: it is an open redirect waiting for one bad check.

**Rejected:**
- *Email invitations.* They need a mail server the self-hosted product does not have (D-7), and the
  owner's team shares links in the chat it is leaving anyway. `SMTP_URL` stays the cloud's.
- *GitHub-organisation auto-join.* It needs the `read:org` scope on every sign-in, an organisation is
  not a team, and it would admit everyone in a large organisation by default.
- *Single-use links.* A team moving in invites ten people at once; one link per person is friction an
  expiry and a revocation already bound.

**Accepted, stated:** a link that leaks admits anyone signed in until it is revoked or expires — the
list shows what is still open, and each join is in the trail with the link it used. Links are rows
that stay: the list reads the open ones by the workspace index, and a workspace that made thousands
is a sweep job's to tidy (D-30), not built until it is measured. `WORKSPACE_OPEN_JOIN_SLUG` (D-37)
is retired with the screens: set, the API refuses to start, naming what replaced it.

---

### D-116. The trail names the session that acted, not a copy of where it came from — closes #397

D-26 gave `audit_log` an `ip_address` and a `user_agent` that nothing wrote, and listed sign-in,
sign-out and session revocation, which have no workspace for a `workspace_id NOT NULL` row. Decided in
the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided:**
1. **A row names the session it was made with** (`session_id`, `ON DELETE SET NULL`). The session holds
   the sign-in's address and agent (`sessions.ip_address`, `sessions.user_agent`, D-81), so "from
   where" is answerable for as long as the session is kept; when it is swept (D-87) the link becomes
   NULL. Personal data is not copied into the one table nothing may delete from — the storage
   limitation a data controller owes (D-27) holds by construction instead of by an erasure job.
2. **The session comes from the request**, noted where it is proved — `requireSession` for HTTP, the
   upgrade for a socket frame — in the request's scope, and read by `recordAudit`. No service's
   signature changes, and a write no request made (a job, a script) names none.
3. **`ip_address` and `user_agent` are dropped** (migration `0022`): columns that are always empty look
   like data and are not.
4. **Signing in, signing out and revoking a session are the `sessions` table's record** — when, from
   where, until when, revoked when — for as long as the session is kept. They are not workspace events,
   and a trail of them per workspace would copy one sign-in into every workspace a person belongs to.

**Rejected:**
- *Copying the address and agent onto each row.* An append-only table of addresses, kept forever, on a
  self-hosted product whose operators answer to GDPR and KVKK.
- *A nullable `workspace_id` for instance events.* A second kind of row that no workspace's admin can
  read, for a record the sessions table already keeps.
- *Passing the session through every service.* Nine signatures for one cross-cutting fact the request
  already carries.

**Accepted, stated:** after a session is swept, its rows say who acted and when, but no longer from
where. The sessions table keeps a session thirty days by default (`SESSION_TTL_DAYS`) plus the sweep's
grace — the window in which "from where" is a question worth asking.

---

### D-117. Development and the browser suite keep attachments in a directory — closes #387

The browser suite and `bun run demo` start the API with no bucket, so every upload there was a
`503 STORAGE_UNAVAILABLE` and the attachment path — pick, upload, send, see — had never run in a
browser. Decided in the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided: `STORAGE_DIRECTORY`, a store that is a directory, for anything but production.**
1. **Production refuses it**, as it refuses to start without the bucket; set with the `S3_*`
   variables it is refused too — one store or the other, never a quiet choice between them.
2. **A key is checked before it is a path** (segments of letters, digits, `_`, `-` and inner dots):
   nothing outside the directory is read or written, whatever a key holds.
3. **The demonstration uses it when no bucket is configured**, a directory per run thrown away with
   the run's database; with a bucket configured (`bun run db:up`) it uses the bucket.

**Rejected: Garage in the browser suite.** The S3 adapter is already tested against Garage as the
deployment runs it (`bun run test:storage`, D-109); what the browser suite asks is whether the path
through the client and the API works, which a directory answers without a second service in every
run and in CI. **Rejected: an in-memory store** — the demonstration's API and its seeding are separate
processes, and a demonstration restarted mid-session would lose what it showed a moment before.

**Accepted, stated:** the browser suite does not exercise S3 itself; `test:storage` does, by hand,
against the real one.

---

### D-118. Navigation is dark in both themes, the accent is blue, and the vocabulary check judges each class alone

**Amends D-110 §3 and §4.** The owner carried the brief further on Superdesign (project *Relay —
Developer Team Chat*, draft *Refined Modern Polish*, v10) and asked for the product to match it. That
draft is now the design the tokens are kept to; `tokens.json` remains the only copy in this repository
(D-97), and its `meta.source` names the draft.

**Decided.**

1. **Navigation has its own tone, dark in both themes.** The rail (`nav-rail`) and the sidebar
   (`nav-surface`) are deep navy whatever the theme, with their own hover, hairline and two inks
   (`nav-hover`, `nav-border`, `nav-ink`, `nav-ink-muted`). They are judged against their own grounds
   in `pairs.ts`, not against the conversation's. `surface-000` stays as the window's outer ground
   (sign-in, home). Amends D-110 §2's "navigation shares one tone with the window's greys".
2. **The accent is blue** (`#2563eb`, hovered `#1d4ed8`), a fill under white in both themes; its
   words are `accent-text`, blue in light and a light blue in dark. The current sidebar row is the
   filled accent. Navy is kept where the draft keeps it: the keyword colour in code. Amends D-110 §4's
   "one deep navy accent". `role: "fill"` stands: `text-accent` still does not exist.
3. **The focus ring is no longer `accent-text` in light**: it must be seen on white *and* on the navy
   navigation, and the blue of the text does not reach 3:1 on `nav-surface`. It takes the next blue up.
4. **The composer has its own elevation**, `shadow-raised`, between the one-pixel card and the overlay.
5. **Navigation is drawn in the dark theme** (`data-theme="dark"` on the rail and the sidebar), so every
   shared control inside it — a menu button, a key, a section's loading and failure — speaks the dark
   theme's inks on the navy without a second set of components. `pairs.ts` judges those inks on the
   navy grounds in the dark theme only, which is the only theme they are drawn in there.
6. **The channel, as the draft draws it:** a message is named by the person's display name, rows are
   16px apart with their avatar, the day is an uppercase label between two rules (amends D-110 §9), the
   unread marker is a rule and a word in the danger colour, a code block's header is plain mono, a
   reaction is a 4px chip, and the send button carries the key that sends.
7. **A focus ring on a card with its own edge is drawn inward**, over that edge: outside it, the 2px
   gap read as a second border.

**And the check that holds pages to this vocabulary did not work.** `checkVocabulary` gave one
Tailwind compiler every class in turn; Tailwind's `build` returns the CSS of every candidate it has
seen, so after the first accepted class nothing could "build to nothing" and a raw value was blamed on
the class after it. `bg-blue-500`, `p-7` and a typo passed; `CONTRIBUTING.md` §4 said they failed. Each
class is now judged by its own compiler (the whole application in well under a second), and a test
judges classes in a row, as the application is judged. Opening it found five classes that had built to
nothing since they were written — the retired `w-gutter`, `py-16`, and the send button's `size-control`
— now spoken in tokens. The extractor also stopped reading a compared value (`status === 'failed'`) or a
function's argument (`buttonStyle('primary')`) as a class.

**Not taken**, as in D-110 and for the same reasons: the thread panel (since taken, D-122), the call button, CI and deploy
rows, the Integrations section, presence dots and photographs, the GitHub card's Approve button,
the Starred section, collapsible sections, the typing line and the member stack in the header.

**Cost of reversing:** the token values and the shell's classes. No contract depends on them.

---

### D-119. A conversation has two edges: bubbles, and your own messages on the right

**Amends D-100 §avatars-and-no-bubbles, D-110 §5 and `UX.md` §3.** The owner looked at the channel
drawn to D-118 and asked for it "not like Slack, left and right". The reference is the Superdesign
draft *Purlay Chat — Left/Right Conversation* (project *Purlay — Chat Screen*), branched from a faithful
reproduction of the current screen so that only the feed changed. D-100 rejected exactly this, for a
reason that was a trade-off, not a fact; the owner has made the other trade, and the code block is
designed for it below rather than the objection being forgotten.

**Decided.**

1. **Two edges.** Everyone else's messages are on the left, in a bubble on `surface-200`, with the
   avatar in its fixed column and the display name over the first bubble of a group. Your own are on
   the right, in a bubble on `accent-subtle`, with no avatar and no name. The time stays in the mono
   face: beside the name on the left, alone on the right.
2. **The avatar and the name belong to a group's *first* message**, not its last as the draft draws
   them. A last-message avatar moves every time somebody adds to the group, which changes the row
   above the reader — what `UX.md` §1 forbids. A grouped message's time waits, invisible until hover,
   where its avatar would be (left) or beside its bubble (right), so nothing reflows on hover either.
3. **A bubble is at most five sixths of the column** (`max-w-5/6`, a fraction rather than a token
   because it is a proportion of the feed, not a length), and as wide as its content below that.
   A code block keeps its own card inside the bubble: the box-in-a-box D-100 warned of is accepted,
   and kept light by the bubble having no border and no shadow of its own.
4. **Your own bubble is `accent-subtle`, not the draft's filled accent.** On the filled blue, the
   words a message can contain — a mention and a link in `accent-text`, an "edited" note in
   `ink-subtle`, a muted resolved root — fall below AA, and they are drawn by the content renderer
   rather than by the row, so a second ink set for them would be a second renderer. The tint carries
   the side; the edge carries it too, so colour is not the only signal.
5. **A mention of you marks the bubble** with a 2px `accent-text` edge instead of tinting the row, and
   still says so to a screen reader; a failed send marks it with the danger edge, as before.
   *Amended 2026-10-13 by the owner:* the edge read as a quotation, and a quotation was drawn with an
   edge too. A mention of you now fills **your own name** in the text (`accent` with `on-accent`), the
   bubble carries no edge, and the screen-reader words stay; a quotation is a recessed block on
   `surface-050` with a quote glyph and no edge. Rejected: tinting the whole bubble, which is what
   your own messages already wear (`accent-subtle`), so a mention in a DM to yourself would vanish.
6. **No hover tint.** The bubble is the shape; the row under the pointer only fades in its actions,
   which sit on the bubble's inner top corner — except your own message, where they sit on its
   outer corner: a short bubble is narrower than they are, and from the inner corner they ran past
   the feed's edge and scrolled the conversation sideways — first on a narrow window, and on a wide
   one too once Pin joined them (D-130) (`UX.md` §2).
7. **The channel's feed and composer are centred** in the column (amends D-110 §5). The other screens,
   which have one edge, still hang from the left.
8. **Square tails are not drawn.** The draft squares the corner nearest the speaker; radius is a
   whole-corner utility here (`rounded-2xl`), and a per-corner vocabulary for one shape is not worth a
   token family.

**Rejected.**

- *The filled accent bubble, with a second ink set for what sits on it.* The draft's look, but every
  inline style the renderer draws would need an on-accent twin, judged in `pairs.ts`, for one surface.
- *Avatar and time under the last bubble*, as drawn: see 2.
- *Keeping one edge and only adding bubbles.* Not what was asked: the request was for sides.

**Cost of reversing:** `message-row.tsx` and its tests, two centring classes, and this paragraph. No
contract, route, keyboard path or required state depends on which side a message is drawn on.

---

### D-120. Online presence is Phase 2 — closes #416

`PRD.md` §4.1 listed "typing indicators and presence" in Phase 1; `UX.md` §2 drew no presence dot
because "there is no presence to show (Phase 2)"; D-114 built typing and left the phase of presence to
the owner. Two documents disagreeing is a defect in one of them. Decided by the owner.

**Decided: online presence is Phase 2.** `PRD.md` §4.1 drops it and Phase 2 lists it; `UX.md` §2
already said so and now names this decision; nothing in the code changes, because nothing in it
shows presence. `PresenceRegistry` keeps only its typing half until presence is built (#480,
`ARCHITECTURE.md` §6.1).
1. **Quiet by default (D-12) and the resolvable thread are the product's reasons to exist;** a green
   dot is neither. (Written as "the inline thread"; it opens in a panel since D-122.)
2. **On one node, "online" means "has a tab open".** A team learns to ignore that within days, and the
   inbox and mentions already reach people who are away.
3. **Typing (D-114) answers the question presence is most often asked for** — is anyone here right now —
   in the channel where it is asked.

**Rejected:**
- *Pulling presence into Phase 1, before the first production launch.* About two pull requests (the
  online half of the registry with a reconnect grace, a `PRESENCE` frame per workspace, the dot), built
  on a guess about what the team will miss, ahead of the launch that measures it.
- *Dropping presence altogether.* That is a claim about use nobody has observed yet; dogfooding is
  where it is observed.

**What watches it:** #480 on the `v0.3.0` milestone. If the team's first weeks on the server (#224)
show nobody misses it, the change is a decision dropping it, not the build.

**Cost of reversing:** this decision, two lines of `PRD.md`, and #480 moved to the current milestone.

---

### D-121. A sign-in that did not finish comes back to the sign-in screen, with a reason

**Amends `API.md` §1 for one route.** `GET /auth/github/callback` threw into the one error hook like
every other route, so a failed sign-in answered the API's JSON envelope — and the callback is reached
only by a browser GitHub redirected, so that JSON was the page the person was left on, with no way
back (#490). The sign-in screen already read `?error`; nothing ever sent it.

**Decided.**

1. **The callback always answers a redirect.** Success goes to `APP_URL`, as before; every failure goes
   to `APP_URL/sign-in?error=<reason>` with the state cookie spent. *Every* failure, the rate limit and
   the unanticipated `INTERNAL` included: the branch sits in the error hook, keyed on the path, so
   nothing thrown while serving the callback can reach the browser as JSON. Every other route,
   `/auth/github` and both logouts included, keeps `API.md` §1's answer — they are not navigations a
   person lands on.
2. **The reason is one of a closed set, `SignInFailure` in `@purlay/types`** — `cancelled`, `expired`,
   `email-required`, `email-taken`, `github-unavailable`, `busy`, `failed` — with the writer of the
   address and its reader beside it, so the API and the client cannot spell the parameter or the set
   differently. Codes collapse into a reason where the person's next step is the same
   (`RATE_LIMITED` and `DATABASE_UNAVAILABLE` are both *wait, then retry*). **Nothing else enters the
   address**: no code, no message, nothing GitHub said. A URL is kept in history, copied into chat and
   written to logs; the cause goes to the server's log instead — `error` for the unanticipated, as
   every `INTERNAL` is, `warn` for GitHub's own failures and for a GitHub `error` other than a cancel.
3. **`expired` stays one reason for every way the state check fails.** The refusal was made uniform
   so a prober learns nothing about which half failed (D-62); a different sentence per half would
   undo that on the screen.
4. **A cancel is read before the state is checked.** `error=access_denied` carries no code, so nothing
   would be exchanged or signed in either way; a forged one shows the person a sentence telling them
   they cancelled. Checking the state first would turn every real cancel in a second tab into
   `expired`, which is the wrong instruction.
5. **GitHub's failures have a type, `GitHubUnavailableError`,** thrown by the client for an unreachable
   host, a refusing status, an answer that is not JSON and one that is not a usable identity. Before
   this they were plain `Error`s, indistinguishable from this server's defects, and became `INTERNAL`.
6. **Unknown reasons read as `failed`.** `?error=1` — the shape the client already read — or a
   hand-edited value still says the sign-in did not finish, rather than showing nothing.

**Rejected.**

- *Content negotiation on `Accept`* — JSON for a script, a redirect for a browser. Nothing but a
  browser follows GitHub's redirect here, so the JSON branch would serve no caller and keep a way to
  leave a person on a JSON page.
- *Carrying the error code in the address.* It ties the client's sentences to the server's taxonomy
  (`OAUTH_STATE_INVALID` is not something a person did) and would put a new code into URLs the moment
  one is added.
- *A reason per GitHub `error` value.* The others (`redirect_uri_mismatch`, `application_suspended`)
  are the operator's misconfiguration; the person can only retry, and the operator reads the log.

**Cost of reversing:** the branch in `app.ts`'s error hook, `abandonSignIn` in `ingress/http/auth.ts`,
`packages/types/src/sign-in.ts`, seven catalogue lines per locale, and this paragraph. No stored data
depends on it.

---

### D-122. A thread opens in a panel beside the feed — closes #494

`PRD.md` §4.2 put threads **inline, underneath the parent, in the main feed**, with "no right-hand
drawer", and `UX.md` §1 and §4 built the interaction on it; D-110 and D-119 named the reference's
thread panel as the one thing not taken from it. On 2026-10-13 the owner decided otherwise, from the
Superdesign screen `frontend-feed.html`: **threads open in a side panel on the right.** This amends
`PRD.md` §4.2, `UX.md` §1, §4, §6 and §7, and the "not taken: the thread panel" of D-110 and D-119.
What the wedge *is* does not change: a thread is resolvable, resolved threads go quiet and stay
searchable, and the open questions are one screen away (D-98, D-99). Where it is read changes.

**Decided.**

1. **One thread at a time, in a panel on the right of the feed.** Its header says *Thread · #channel*
   with a close control; under it the root, its status and **Resolve / Reopen**, a rule labelled *N
   replies*, the replies as the feed draws them (two edges, D-119), and the reply box at the bottom.
   Opening another thread replaces it. Which thread is open belongs to the channel visit, as expansion
   did: a channel opened again opens with none, unless the address names one (`?thread=`).
2. **The root stays in the feed, marked.** Its line — *Open · 4 replies · last 12m ago* or *Resolved by
   alice* — is the way in; while its thread is in the panel the line is filled and says *Thread open*,
   and its `aria-expanded` and `aria-controls` point at the panel.
3. **Width.** On a wide window the panel is a fixed width, `size-thread` (380px, the design's) and the
   feed keeps the rest. Below the narrow line (`size-narrow`) it covers the conversation, header and
   composer included, and what it covers is hidden from a screen reader and from Tab — kept in place,
   so closing returns the reader to where they were. Nothing scrolls sideways at either width.
4. **Focus and keys.** The panel is a complementary region labelled by its heading. Opening it moves
   focus in — to the heading, or to the reply box when the person pressed Reply or `R` — and closing it,
   by `Esc` anywhere in it or the close control, puts focus back on the root's row in the feed. `T` on
   a focused root opens its thread in the panel; `R` and `⌘⇧R` work as before, on the row and inside
   the panel.
5. **Resolving from here closes the panel**, after the thread inside it folds with the product's one
   animation (UX §4.3); focus returns to the root. **Resolved by somebody else, it stays open** and only
   its status changes: nothing this person did asked for it, and a panel that vanishes under someone
   writing a reply moves content under the reader (UX §1). Inline, a remote resolution collapsed the
   thread; that rule is reversed.
6. **No "Also send to #channel".** The design draws the checkbox; the product has no such feature, so
   the panel has no such control. Adding one is a decision of its own.

**Rejected.**

- *Keeping threads inline.* It is what PRD §4.2 argued for — a drawer makes a discussion feel like a
  footnote — and what the code did until now. The owner's design is the reason it changes: in a feed of
  two-edged bubbles an expanded thread pushed the conversation down by its whole length, and the panel
  keeps both the channel and the thread on screen at once. The footnote risk is answered by keeping the
  root and its live status in the feed, and the open-questions view, rather than by where the replies
  are drawn.
- *Several threads open at once, or a panel per thread.* One panel is the design, and two would leave
  the feed a column too narrow to read.
- *A resizable panel.* `UX.md` §2 keeps resizable panes out of Phase 1: a saved layout is one more state
  to sync, for no benefit at this size.
- *Closing the panel when another device resolves the thread.* See 5.

**Cost of reversing:** the threads slice of the client (`features/threads`), the channel screen's
layout, `size-thread`, their tests and screenshots, and the documents named above. No contract, route,
schema or stored value depends on where a thread is drawn.

### D-123. Renaming, archiving and leaving a channel, and who may

`API.md` §4 listed renaming, archiving and leaving as Phase 1 and unbuilt (D-104 left leaving for later).
The documents disagreed on who archives — `ARCHITECTURE.md` §7.4 gave it to every member beside
creating, `API.md` to an admin — and nothing said what the last member of a private channel leaving
does, or what a direct message answers. Served by #499; decided in the owner's standing instruction
to decide and proceed, and open to their reversal.

**Decided.**

1. **A member of the channel renames it and sets its topic** (`PATCH`). In it, not merely able to see
   it: the rule for bringing people in (D-104), and `403` otherwise. The name is the one a new channel
   takes, unique among the workspace's live channels ignoring case — `409 CHANNEL_NAME_TAKEN`, with the
   index the authority when two race (D-78). Asking for what is already there changes nothing and
   tells nobody. **A rename is on the audit trail** (`channel.renamed`, from and to — amends D-26's
   list): a name is what the whole workspace finds a channel by, and a changed one confuses everyone
   at once. A topic is a line somebody wrote and stays off the trail, as a message's words do.
2. **An owner or an admin archives** (`DELETE`); amends `ARCHITECTURE.md` §7.4. Creating hides
   nothing from anybody; archiving hides a channel's whole history from everyone in it, which is a
   workspace act. It is D-9's soft delete: the messages and the memberships stay, the name is free
   again (`idx_channels_unique_name` holds live channels only), and nobody sees the channel. Nothing
   in the product restores one in Phase 1. An admin who cannot see a private channel cannot archive
   it — `404`, because a role is not a way round visibility (D-34). On the trail as
   `channel.archived`, with the name it had, since the channel is no longer listed to find it by.
3. **Anybody in a channel leaves it**; somebody not in it is `204` again, told nothing. **The last
   member of a private channel is refused**, `409 LAST_CHANNEL_MEMBER`: only a member brings people
   into one (D-104), so with nobody left it could never be reached again. They bring somebody in
   first, or ask an admin to archive it. A public channel may be left empty — anybody can join it.
4. **A direct message has none of these**: `404 CHANNEL_NOT_FOUND`, the answer `join` gives for a
   channel the endpoint does not serve. It has no name, and it *is* its two people (I-5).
5. **There is no default channel.** A workspace starts with none and an invitation joins none
   (D-115), so nothing needs protecting from being left or archived. A default channel, if one is
   ever made, decides that for itself.
6. **Every open screen is told** (D-85). A rename is `CHANNEL_UPDATED` on the channel's topic — the
   name and topic whole, at the channel row's own count of its changes (`channels.state_version`,
   migration `0023`), so a late frame cannot undo a newer rename, as `CHANNEL_STATE` cannot. An
   archive is `ACCESS_REVOKED` on the channel's topic and a leave on the person's own, each with a
   `reason` (`archived`, `left`) so a person looking at the channel is told what happened rather than
   that it is not found. The field is optional, so a client built before it reads the frame as before.
   **Who hears it:** the sockets watching the channel — every socket that subscribed to it, which a
   `SUBSCRIBE` allows to anybody who can see it (a member, or anyone in the workspace for a public
   channel; `router.ts` checks visibility, not membership). Somebody who can see a public channel and
   has not opened it sees the change when their list is next read; a workspace topic for this is what
   D-85 rejected.
7. **Who is in a channel** is `GET /api/channels/:channelId/members`, for anybody who can see it.
   Not paged, as the workspace's own list is not: a channel's members are some of the workspace's,
   whose size D-25 bounds.
8. **A name is typed as it is said, and the client puts it in the rule's form as it is typed**
   (`UX.md` §2): lowercase, a letter's accents taken off and the dotless ı spelled, anything else one
   hyphen. The server's rule is unchanged — it still accepts any `name` the contract does — so an
   older client or a script is not refused; the form is the interface's, which is where people type.

**Rejected: archiving a private channel when its last member leaves.** It makes archiving a member's
act by another door, against 2. **Rejected: letting the last member go.** A conversation nobody can
read, join or archive through the product. **Rejected: `409` for a direct message.** A new code for a
request no client sends, where the existing refusal says the same. **Rejected: every member archives**,
as §7.4 had it: one person could take a channel's history away from everyone in it. **Rejected:
refusing a name typed with spaces or capitals**, as New channel did: it answered a person for typing
the way they speak, and the fix it asked for was always the same one the field can make.

**Cost of reversing:** a role check and a count in `modules/channels/settings.ts`, two rows of the
permission table, and this paragraph; no data changes shape.

### D-124. What is the person's and what is the workspace's — #495, #496, #497

Deep Work started only from `Cmd/Ctrl+Shift+D`, for a fixed hour, though the API takes any instant
within `DEEP_WORK_MAX_HOURS` (D-108). The sidebar's foot showed who was signed in and did nothing;
signing out was an item of the workspace menu, though it is not the workspace's; and *sign out
everywhere* (`POST /auth/logout-all`, the capability D-11 chose database-backed sessions for) had no
door at all. The design (`frontend-feed.html`) puts an account control at the sidebar's foot. Decided
in the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **Deep Work is started for a chosen while** — 30 minutes, an hour, two hours, or until tomorrow —
   and the instant is what `PUT …/deep-work` is sent, so it is the server's delivery that stops (D-15,
   D-108); the client paints it first and puts it back on a refusal, as before. *Until tomorrow* is nine
   the next morning in the person's own time — the coming morning when it is chosen before five, as
   the night is not over then — and never later than the server's bound less five minutes, so a clock
   here a little ahead of the server's cannot turn it into a refusal.
   `Cmd/Ctrl+Shift+D` still starts it for an hour; the command palette and the account menu offer
   every while, and while it is on, its end — the menu with until when and the minutes left.
2. **The browser tests that end a person's sessions, or change their Deep Work, act as outsiders.** The
   demo seed makes two people in no workspace, each signed in twice (`demo-seed.ts`); a test makes a
   workspace of its own for one of them. Done as one of the four seeded people, Deep Work would quiet
   the badges other tests photograph, and signing out everywhere would revoke the session every other
   test of the run signs in with.
3. **The sidebar's foot is the account menu.** The whole row — avatar, name, `@handle`, and a
   preferences glyph — is one button, and what it opens is everything that is the person's rather than
   the workspace's: Deep Work, the theme, the language, the shortcut reference, *Sign out* and *Sign out
   everywhere*.
4. **Theme, language and the shortcut reference move there; the rail's gear goes.** One home each
   (`CONTRIBUTING.md` §6.1): mirrored on the rail they would be two doors kept in step by nobody, and a
   gear left with nothing in it is a door to a door. The command palette keeps offering them, as it
   offers everything — it is the product's search over its actions, not a second menu. The gallery,
   which has no account, wraps the *same* items (`PreferenceItems`) in a menu of its own.
5. **Signing out everywhere asks first.** It ends sessions on devices that are not in front of the
   person, so it is a dialog with the choice named on its button, and a refusal is a toast with the
   person still signed in — as signing out here already was.
6. **A workspace is renamed, and its slug stays** (`PATCH /api/workspaces/:workspaceId`, an owner's
   or an admin's, `ARCHITECTURE.md` §7.4). The slug is the address in every link already pasted into
   a chat or a bookmark; moving it with the name would break them all for a cosmetic change. The same
   name again changes nothing and records nothing. The trail (D-26: *workspace settings change*)
   keeps the name before and after — a setting an admin typed, not anything a person said.
7. **Every member's tabs hear it as `WORKSPACE_UPDATED`, on each member's own `user:` topic, carrying
   no state**: the client reads its memberships again. The members are read as the rename commits, so
   somebody removed a moment before is not told. `DELETE` of a workspace stays unbuilt (①).
8. **The workspace menu opens from the workspace's name at the top of the sidebar**, with a chevron,
   as the design draws it; the rail's tile stays a second door to the same menu — one component, one
   list of items, as the jump field and `Cmd/Ctrl+K` are two doors to one palette. It gains **Create
   workspace…**, anybody's (the API lets anybody make one), which is the first-run form of `/` in a
   dialog: `/` sends a person with a workspace straight to it, so until now a second could not be made.

**Rejected.**

- *Publishing on `workspace:`.* No socket listens on it, and one that did would have to be told when
  its person leaves; a removed member's tab would keep hearing the workspace until it reconnected.
- *The new name in the frame.* Two renames can be heard in the opposite order to their commits, and
  ordering them needs a version column on `workspaces` (`0015_state_versions`) for a row that changes
  a few times in its life. Reading the memberships again is one request and cannot be out of order.
- *The slug following the name.* See 6.
- *A submenu for the durations, or a picker for any time.* Each is a new primitive (D-52) for four
  choices; the server's bound already makes "any time" mean "any time today or tomorrow".
- *Keeping Sign out in the workspace menu as well.* Two homes for one act.
- *A Settings page.* Five choices fit in a menu; a page is a route, a layout and a back button for them.

**Cost of reversing:** the choices in `deep-work.tsx`, `account-menu.tsx`, the footer and the rail's
foot, the palette's Deep Work items, the seed's outsiders, and this decision; for the rename, the
endpoint, its audit action and `WORKSPACE_UPDATED` — a frame a client older than it ignores as unknown
(D-82), so removing it breaks nobody.

---

### D-125. Phase 2 starts before Phase 1's exit is demonstrated, by the owner's decision

D-4 binds a phase's work to its phase, and `CONTRIBUTING.md` §1.1 does not start the next one early.
On 2026-10-13 every Phase 1 issue that code can close was closed; what keeps `v0.2.0` open is the
deployment (#224, the server goes up the next day) and the measurements only use can give (#61,
#75). The owner decided to go on building **Phase 2** in that gap rather than wait on it.

**Decided.**

1. Work on `v0.3.0` begins now, in this order: **(1)** Web Push (#78), group conversations (#486),
   saved items (#484), pins and files (#485), profiles (#488), starred channels (#489); **(2)** the
   diff viewer (#80), GitHub feeds (#79), edit history (#82), presence (#480), incident channels
   (#487); **(3)** magic-link sign-in (#81), retention and erasure (#83), workspace export (#84).
2. **The screens' features join Phase 2.** #484–#489 came from the Superdesign screens and each asked
   which phase it belongs to: Phase 2, and `PRD.md` §4 lists them.
3. **Phase 1 is still the floor.** A defect found in a Phase 1 feature is fixed before Phase 2 work
   goes on, and `v0.2.0` closes when its exit is demonstrated (S-1), not when its issue list is empty.
4. Each feature still answers its own open questions as decisions of its own; this decision moves
   the schedule, not any rule of how the work is done.

**Rejected.** *Waiting for the deployment to start Phase 2* — a day, and then a week of dogfooding,
with nothing to build that the team asked for; the risk it guards against (Phase 2 work on top of a
Phase 1 the team has not used) is held by item 3. *Re-labelling the features Phase 1* — it would
make `v0.2.0` never finish, and S-1 is a measurement of the product as specified.

**Cost of reversing:** this paragraph and the PRD's Phase 2 line; nothing built depends on the order.

---

### D-126. Web Push: who is told, what they are told, and where it may be sent — #78

Phase 1 is silent with the tab closed (D-12, `PRD.md` §4.5). Web Push closes that, and every choice
below is about not undoing what D-12 made quiet, and not turning the server into something other
people can aim.

**Decided.**

1. **Who is pushed: the people a write told for the first time.** The notification rows a send
   inserts — none on a retried send, which writes nothing new; only the newly named on an edit
   (D-103) — of a reason in `NEEDS_YOU`, not `suppressed_by_deep_work` (D-108), not already read,
   for a message not deleted, to a person not deleted. `channel_message` included: a member who
   chose "every message" (D-107) asked to be told. Never the author.
2. **Who and where, never what.** The title is the place: `#api`, the person in a direct message, or
   a group's other people (D-127); the body is the inbox's own words for the reason, naming who did
   it (`alice mentioned you`, and in a group `alice wrote to the conversation`). The push service relays
   the payload encrypted for the device (RFC 8291), but a lock screen is not private.
3. **In the person's language (D-41 kept):** `users.locale`, set by the client when the person
   subscribes and whenever they change language (`PUT /api/me/locale`).
4. **A device belongs to a session.** A subscription carries the session it was made in: signing out
   deletes it, in the same transaction, and a subscription is written only while its session is
   live — a shared computer stops showing the last person's notices. An endpoint is unique across
   people: a browser signed into another account sends the same endpoint and the same keys, and
   moves to it; the endpoint alone does not move it, so knowing somebody's address cannot silence
   their device. At most twenty devices a person, the least recently subscribed dropped. The two
   VAPID keys are checked to be one pair before the server starts.
5. **Always shown.** Browsers penalise a push that shows nothing (Chrome's generic notice, Safari's
   revocation), so the worker always shows one, folded by channel. *Amended by D-143:* a push is
   held, on the server, while its person is in front of that workspace's page.
6. **Where a push may be sent:** the image proxy's address rule (`https:` on the default port, no
   credentials, no address literal, no `localhost` or dotless host) and its checked public-address
   lookup, no redirect, a short timeout. A browser chose the endpoint; anybody signed in could choose
   any other, so the server must never reach inside.
7. **Off without keys.** `VAPID_*` all three or none; none is push off — the key is `null`, an
   answer every signed-in page can ask for without an error, a subscription is `PUSH_UNAVAILABLE`, and
   production still starts, since the inbox is the record. Changing the pair
   leaves old subscriptions inert (each remembers the key it was made with); devices subscribe again.
8. **Sent by the node that committed the write,** not through the `EventBus`: a second node does not
   double it (D-7).
9. **No dependency.** RFC 8291 and RFC 8292 with `crypto.subtle` (`docs/spikes/web-push.md`).

**Rejected.**

- *Pushing every unread notification of a message, on every send* — a retried send and an edit would
  ring the phone again for what it already said.
- *Message text in the push* — what a person wrote ends up on a lock screen; Phase 2 stops at who and
  where.
- *A language per device* — D-41 put the column on the person, the first text the server writes for
  them; a device subscribed in English and a person reading Turkish would disagree.
- *An allowlist of push-service hosts* — it breaks a browser we have not met; the address rule, the
  lookup and the per-person bound hold the abuse a stored endpoint allows.
- *Showing nothing while a Purlay window is open* — penalised by the browsers, as above.
- *The `web-push` package* — what it does, `crypto.subtle` does in Bun, measured against RFC 8291's own
  example (CONTRIBUTING §1.12).

**Not the credential cipher.** A push's body is encrypted to one browser's key in the one format a
push service carries (RFC 8291), on the wire and never stored; the credential cipher seals what
Purlay keeps (D-39 §6, #113). The test that holds "one cipher" names `modules/push/encrypt.ts` as
the second place, and why.

**Cost of reversing:** migration 0024's table and column, `modules/push`, four routes, the worker, the
account menu's item, and this decision; push is off with the keys unset, without a code change.

### D-127. Group conversations: a direct message of up to ten people, whose people are its identity — #486

**Context.** The Superdesign screens add a conversation with several people that is not a channel
(D-125 put it in Phase 2). D-6 made a direct message a sorted pair, D-104 §3 kept it between its
two people, and D-123 §4 gave it no rename, archive or leave.

**Decision.**
1. **A group is a direct message**, not a new channel type: `type = 'direct_message'`, no name, and
   `dm_key` the sorted ids of its people — two to ten (I-5, migration 0025). The same set of people,
   in any order, opens the same conversation; two people is the direct message D-6 described, and a
   note to self stays one id twice. `POST /api/workspaces/:id/conversations` takes the people
   besides the caller; `/dms` stays.
2. **At most ten people, the caller counted** (`CONVERSATION_PEOPLE_MAX`). Past that it is a
   channel, which has a name, a topic and settings a conversation does not.
3. **Its people never change.** No adding, no leaving (D-104 §3 and D-123 §4 kept for every direct
   message): more people is another conversation, started from this one's people, and the history
   stays where it was written. *Why not leave:* the set is the identity, so anybody in it reopening
   the set would bring a leaver back — silently, and able to read what was said after they left.
   Closing a conversation from one's own sidebar is a later choice, if the team asks for it. For
   the same reason a group is never filled in again: somebody removed from the workspace and let
   back in (D-111) is not returned to it by anybody reopening the set — only a conversation of two
   restores a missing membership, as before — and opening a group one is not in is `404`.
4. **Every message tells every other person in it**, as `direct_message`, push included (D-126):
   what is written in a conversation is written to its people. Weighed against D-12's quiet: a
   person mutes one conversation with notification level `none`, as for any channel.
5. **The contract is additive:** `Channel.peers` is the people besides the caller, in key order (the
   caller alone for a note to self, empty for a channel); `peer` stays for a conversation of two and
   is null for a group, so nothing reading `peer` can show a group as one person.

**Rejected.** *A `group` channel type* — an enum value cannot be used in the transaction that adds
it, and every direct-message rule would fork for no difference in behaviour. *A private channel
without a name* — a channel has settings, a topic and archive; a conversation has none of them.
*Adding people to a conversation in place* — the set would stop being the identity, and the unique
index with it.

**Cost of reversing:** migration 0025's check and function (groups already made would then fail the
two-id check, and would be deleted or turned into private channels first); the route and `peers`.


### D-128. Saved items: a person's own list of messages to come back to, with no reminder — #484

**Context.** The Superdesign screens add a Saved view with In progress, Archived and Completed, and an
optional reminder time. D-125 put saved items in Phase 2. `PRD.md` §6 lists reminders among the
permanent non-goals (D-4).

**Decision.**
1. **A save is a person's, of a message they can read**: one `saved_messages` row per person and
   message, in a state — `in_progress`, `archived` or `completed`. Saved and let go by the message's
   id, found through the caller's visible channels in one query; a deleted message cannot be saved,
   and a deleted message's save can still be let go.
2. **Shown through visibility now**: the lists show saves in channels the person can see, of messages
   not deleted, as the inbox does (D-106). A save in a channel they left is kept and hidden, and comes
   back if they do.
3. **At most `SAVED_MAX` (1000) shown in a workspace**, counted under the person's membership row
   locked, so two saves at the bound cannot both be the last; saving again is never refused. Past it,
   `409 SAVED_LIMIT`. The ids list is bounded by it and not paged.
4. **Saving again keeps what was there**: its id, its time, and its state unless a state is given.
5. **The person's own devices are told** `SAVED_UPDATED` on their `user:` topic, with nothing in it but
   the workspace; nobody else learns anything.
6. **No reminder.** Reminders are a permanent non-goal (`PRD.md` §6); lifting that is the owner's, by
   a decision of its own.

**Rejected.** *A message to one's own note-to-self conversation* (D-5's answer to a scratchpad) — it
copies the words out of their thread and their channel, and has no state. *Keyset on (saved_at,
message_id)* — a cursor naming a save since let go would find nothing; the save's own UUIDv7 does not
need to exist to compare. *Refetching on focus* — the client keeps that off on purpose; a frame says
when.

**Cost of reversing:** migration 0026's table and type, four routes, the frame, and the client's Save.

### D-129. A channel's files: every attachment of its messages, found by the channel — #485

**Context.** The Superdesign screens give a channel a Files list beside its conversation. An
attachment knew its message and its workspace (D-109), not its channel: listing a channel's files
meant walking every message of the channel to find the few that carry one.

**Decision.**
1. **An attachment carries its message's channel** (`attachments.channel_id`, migration 0027): NULL
   while unattached, set by the same statement that links it to its message, and held there by the
   database — linked and channelled together or neither, and the channel is the message's by a key to
   `messages (id, channel_id)`, as `mentions` is (I-1). Rows linked before it are backfilled.
2. **The list is the channel's, read through its context**: `GET /api/channels/:channelId/files`,
   refused as the channel's messages are (`404 CHANNEL_NOT_FOUND` for one the caller cannot see).
3. **What the channel shows, no more**: files of messages not deleted — a tombstone hides its files
   as it hides its words (D-109 §6), while a reply's file stays when its root is deleted, as the
   thread does (D-103 §7) — and never an unattached upload, which is its uploader's alone.
4. **Newest message first, then its files newest first**, keyset on the pair. The cursor is a file's
   id; one that is not a file of this channel's messages is `400`, never an empty page that looks
   like the end. A file whose message was deleted after the page was read is still a cursor, so
   paging on past a deletion goes on where it was.
5. **Each file says who shared it, when, and where**: its message's id, its thread's root, its sender
   and the message's time, so the list opens the file where it was said.
6. **A panel beside the conversation, not a screen of its own**: the header's Files control opens it
   in the thread's place, one panel at a time, and which is open belongs to the channel visit as a
   thread does (D-122). It is read when it opens and again when a frame says it changed — a message
   with files arriving, one deleted, or a resubscription — with no frame of its own. A read on its
   way is never cancelled for it: the list is read again once that read is in. Read again, it is read
   whole — each page loaded so far, one request a page — which a panel of a few pages can afford.

**Rejected.** *Joining through `messages` on every read* — correct, but an index cannot serve a
channel's attachments ordered by message without the channel on the attachment, and the list is read
each time the panel opens. *Keyset on the attachment's id alone* — an upload's id is the time it was
uploaded, not the time it was said, so the list would not be in the conversation's order. *A cursor
that does not exist reading as an empty page* — a list that ends early says nothing is wrong.
*A `FILES_UPDATED` frame* — every frame that changes the list already reaches the channel's sockets;
a second would say the same thing twice.

**Cost of reversing:** migration 0027's column, its two constraints and index, one route.

### D-130. A channel's pins: a member's to change, everyone's to see — #485

**Context.** The Superdesign screens give a channel a Pins list beside its Files (D-129): the few
messages a team keeps at hand — the runbook, the decision, the link everyone asks for.

**Decision.**
1. **A pin is the channel's**, one per message (`pinned_messages`, migration 0028): pinned by
   whoever, it is the same pin, and pinning again leaves it as it was. Its message is in its channel
   and its channel in its workspace by the composite keys `mentions` has (I-1, I-4). Who pinned it
   outlives their account as nobody.
2. **A member's to change** — `PUT`/`DELETE /api/messages/:messageId/pin` find the message through
   the caller's visible channels in one query; seeing a public channel is not being in it, so a
   visible non-member is `403`, as renaming it is (D-123 §1). **Everyone's to see**:
   `GET /api/channels/:channelId/pins` through the channel's context.
3. **At most `PINS_MAX` (50) a channel**, counted over pins of messages not deleted, under the
   channel's row locked (`NO KEY UPDATE`, the lock a send's own write takes): two pins at the bound
   cannot both be the last. Past it, `409 PINS_LIMIT`; pinning what is pinned is never refused. The
   list is bounded by the same number and not paged.
4. **A deleted message takes its pin with it**, in the same transaction as its mentions (D-103): a
   tombstone kept at hand is nothing to keep, and kept, the rows would grow with every deletion. One
   deleted as it was being pinned leaves a pin that neither the list nor the bound counts, and an
   unpin still lets it go.
5. **Heard as `PINS_UPDATED`** on the channel's topic, with nothing but the channel in it, only when
   something changed; a client reads the pins again, so two changes heard in either order leave the
   same list. A resubscription and a deletion read them again too.
6. **Not audited**: a pin is a member's everyday act, not an administrative one (D-26).
7. **A conversation has pins, and a reply can be one**: the list carries the reply's thread root, so
   it opens where it was said. A pin's message is always whole in the list, and a client changes its
   copy there as it changes the feed's — an edit, a reaction, a thread.
8. **The feed marks a pinned message from the same list the panel shows**, read once when the
   channel opens; Pin is a member's control beside Save, painted at once and put back when refused.
   What the person has asked and the server has not yet answered is held beside that list for the
   channel visit, never written into it (D-18): a refusal drops its own request only, whatever
   anyone else changed meanwhile, and an answer read while a request is on its way cannot take the
   painted change back. One request a message at a time; Retry only where trying again could help.

**Rejected.** *A `pinned` field on every message* — every frame that carries a message would have to
say it, and every page; the pins are read once for a channel. *Anyone who can see the channel pins* —
a public channel would be decorated by people who are not in it. *The pin's state in the frame* — a
second pin's frame overtaking the first's would leave the wrong list; read again, the order does not
matter. *Counting deleted messages' pins* — the bound would be taken by what nobody sees.

**Cost of reversing:** migration 0028's table, three routes, the frame, and the client's pins.

### D-131. A profile: a title, a time zone and a status line, the person's own — #488

**Context.** The Superdesign screens show, in a conversation and where people are picked, what a
person does, the time it is where they are, and a line about what they are on. GitHub gives a name
and an avatar, which stay GitHub's (D-11). D-125 put profiles in Phase 2.

**Decision.**
1. **Three fields on the person** (`users.title`, `users.time_zone`, `users.status_text`, migration
   0029), each null until set and never blank: a title of up to 80 characters, an IANA time zone,
   a status line of up to 100. Global, as the person is (D-3): the same in every workspace.
2. **The person's own to change** — `PATCH /api/me/profile`; a field left out is kept, `null` clears
   it, words are trimmed, and a field of nothing but spaces is refused as no name may be. A time zone
   is a named zone the server's runtime can format in, stored as the runtime spells it
   (`europe/istanbul` is `Europe/Istanbul`); an offset (`+05`) or a zone it does not know is `400`
   on `timeZone`.
3. **Read where the person is read**: `GET /api/me` carries the caller's, and each workspace member
   carries theirs, so a conversation, the members and every picker have it with no second request,
   and nobody outside a shared workspace reads it.
4. **A change is heard as `WORKSPACE_UPDATED`** by everyone in each workspace the person is in — the
   frame a rename sends, which carries nothing — and a client reads the members again. Nothing
   changed, nobody is told.
5. **No expiry and no emoji on the status**: a line of words, kept until it is changed. A presence
   ("away") is presence's (#480), not the profile's.
6. **Shown where people are met**: a conversation with one other person is headed by their local
   time and status and opens their profile beside it; the picker shows each person's title and local
   time; your own is set from the account menu. A zone a browser cannot format in shows no time, and
   the profile still names it. A note to yourself shows none of yours beside your name.
7. **Personal data**: erasing an account clears the three (D-27 §2), and the status line, free words
   as a message's are, is never logged (`ARCHITECTURE.md` §10). A client back from a gap reads the
   members again, since no frame will say what changed meanwhile.

**Rejected.** *Profile fields on `User`* — every message carries its sender, and every message
would carry a status line. *A `PROFILE_UPDATED` frame* — `WORKSPACE_UPDATED` already reaches exactly
the people who can see the profile and says "read the workspace again". *A status that clears
itself* — a timer per person, for a feature nobody has asked to expire yet.

**Cost of reversing:** migration 0029's columns, one route, the `profile` fields of two responses.

### D-132. Starred channels: a member's own, kept above the rest — #489

**Context.** The Superdesign screens keep a few channels in a Starred section above Channels, and
offer a pick of channels to join on accepting an invitation. D-125 put both in Phase 2.

**Decision.**
1. **A star is a member's own**, on their membership row (`channel_members.starred_at`, migration
   0030), as their read position and notification level are: on the channel as `starred` for them,
   false for anybody not in it.
2. **Set and let go** with `PUT`/`DELETE /api/channels/:channelId/star`, idempotent; a channel the
   caller is not in is `404`, the notification level's rule (D-107). Not a direct message's: a person
   is found under People, a group under Conversations — and one is refused as not found, on purpose,
   as a channel that is not one to star. One conditional statement decides and writes, so two stars
   at once change the row once and tell once.
3. **The other tabs are told** with `CHANNELS_UPDATED` on the person's own topic, carrying the
   workspace only, and read their channels again — only on a change.
4. **The Starred section** is above Channels and takes its channels out of it; by name, since a
   place you keep should stay where you put it; absent while nothing is starred. Star is in the
   channel's header (in the Channel menu on a narrow window), its name constant and `aria-pressed`
   saying whether it is; painted at once and put back when refused, only while it is still as that
   asked. A channel's requests go one after another, so the last click is what stays, and once
   answered the channels are read again. `Alt+↑/↓` and the palette walk the sidebar's own order.

5. **Channels to join on arriving**: accepting an invitation leads to `/w/:slug/welcome`, the
   workspace's public channels not yet joined, by name; the three with the latest messages are marked
   Active and picked, a silent channel is never recommended. Joined together with the existing join,
   or skipped; a join that fails part way says which channels by name, and why, and keeps those
   picked unless they are gone. They are joined four at a time — each is a write on the budget the
   person's first message spends — and the marks are set once, so a list read again does not move
   them. A person who leaves while the joins are on their way is not moved, and a failure is said
   where they are.

**Rejected.** *The star in `ChannelState`* — every frame that carries a read position would have to
read the star too, and a star changes nothing a read position says. *A frame carrying the star* —
two tabs' changes heard out of order would leave the wrong one; read again, order does not matter.
*Starred by activity* — the section would reorder itself under the pointer.
*Recommendations by members or by an admin's choice* — the first needs a count on every channel
row, the second a setting nobody has asked for; the latest message says where the team is talking.

**Cost of reversing:** migration 0030's column, two routes, the frame, the section, and the welcome
step.

### D-133. A pasted diff is drawn as a diff, for reading — #80

**Context.** People paste `git diff` output into a conversation to say "this is what changed". As a
code block it is a wall of `+` and `-`. D-125 put the diff viewer in Phase 2; review itself stays where
the code is (`PRD.md` §6).

**Decision.**
1. **A fenced block whose language is `diff` or `patch`** is drawn as a diff; every other language
   stays a code block. Nothing is guessed from the content: the fence says what it is.
2. **Read by a pure parser** into files (from `diff --git` and `---`/`+++`), hunks (from `@@`, with
   the numbers each line has on each side) and lines. A hunk ends where its `@@ -a,b +c,d @@` says,
   so a removed `-- comment` is a line and the next file's `---`/`+++` is a header; outside a hunk
   those two are headers only after `diff --git` or as a pair before a hunk. **Nothing pasted is
   lost**: git's notes (a rename, a binary file, `\ No newline at end of file`) and prose are rows of
   their own, a block of `+`/`-` lines with no headers is one hunk with no numbers, and a fence with
   nothing in it is a code block.
3. **Unified or split**, the reader's choice for that block, unified to begin with; split pairs each
   run of removals with the additions after it, context on both sides, a note across both. A narrow window has room for
   one column and is unified whatever was chosen.
4. **Never colour alone**: a line keeps its `+` or `-`, and a screen reader hears "added" or
   "removed" — words that are not selectable, so lines copied by hand are the lines. Each file is a
   table with named columns, its rows the lines.
5. **As a code block is**: the counts of what was added and removed, Copy for the raw text as sent,
   the clamp above twelve lines. No syntax highlighting inside it — the colour is the change.

**Rejected.** *Detecting a diff from its content* — a message about `--flags` or a list of `-` items
would be drawn as one. *Highlighting each line in its file's language* — a second colour on top of the
change, and a grammar per file for a paste. *Word-level changes inside a line* — worth it for review,
which this is not. *A remembered preference for split* — a setting for one block's view.

**Cost of reversing:** two files and a branch in the renderer.

---

### D-134. A repository's feed: GitHub's events as messages with no author — #79

**Context.** D-5 put webhook repo feeds in Phase 2 — "signature verification, delivery dedup, retry and
replay" — and `SCHEMA.md` §8.3 settled a table for them. Nothing said who a feed's messages are by,
where its secret lives, who sets one up, or what a duplicate, a flood or a lost channel does.

**Decision.**
1. **A feed connects one repository to one channel**, for `push`, `pull_request`, `issues` and
   `release`; one channel may have feeds from several repositories and one repository may feed several
   channels, never one channel twice (`UNIQUE (channel_id, repository_full_name)`, the name kept in
   lower case as GitHub compares it). Not CI, check or deploy events — D-110 and D-118 left those
   rows out, and this does not bring them back — and not an Integrations section: a feed is set up
   from its channel. What each posts: a push to a branch or a tag; a pull request opened (not as a
   draft — its being ready for review is the announcement), closed, merged, reopened; an issue opened,
   closed, reopened — not deleted or moved, which leave the earlier message pointing at GitHub's own
   answer; a release released or pre-released, said as which, once — GitHub's `published` beside
   them is not posted, and a pre-release promoted is. Every other action is received and not posted.
2. **Set up and removed by an owner or an admin** (§7.4's "configure GitHub integration"), from a
   channel they can see — a role is not a way round visibility (D-123 §2): a channel they cannot see
   has no feeds for them, and its feed is `404`. Each is one row of the audit trail
   (`integration.feed_created`, `integration.feed_removed`) with the repository's name — accepted: an
   admin reading the trail learns that a repository was connected somewhere, not where, as an
   archived private channel's name is on it already (D-123). A direct message has none.
3. **Each feed has its own secret**: 32 random bytes the server makes, sealed by the one cipher
   (D-39 §6) with the feed's id bound in, answered once with the payload address — the screen that
   shows them says the content type GitHub must send, `application/json` — and never again. A lost
   secret is a feed removed and made again, which is what connecting it again is told. The address carries the feed, `/api/webhooks/github/:feedId`: a secret per feed must be
   found before the signature is checked, and a repository's name, unverified, names a feed in every
   workspace that has one.
4. **A delivery is checked before it is read**: a feed that is not there is `404`; a body without a
   length, or longer than `WEBHOOK_BODY_MAX_BYTES` (1 MiB), is refused before it is read; the
   `X-Hub-Signature-256` HMAC over the bytes as sent, compared in constant time, is the only
   credential — wrong, missing or malformed is `401`. Each client address has a bucket before anything
   is looked up, a node reads a few bodies at once, each within a deadline, and each feed has its own
   bucket after the signature — so nobody who knows an address can spend a feed's, or hold every read
   open; all provisional (O-4). A delivery from another repository than the feed's is refused: by its
   number once a delivery has named it, by its name until then; a renamed repository keeps its feed,
   and its new name unless another feed of the channel holds it.
5. **Each delivery is posted once.** Its `X-GitHub-Delivery` id is recorded in the transaction that
   posts it; the same id again is `200` and posts nothing. GitHub does not retry on its own: *retry and
   replay* (D-5) are an admin's Redeliver in GitHub, made safe by this, and a delivery that failed
   answers `5xx` so GitHub shows it failed. GitHub redelivers only what it received in the last three
   days; the ids are kept thirty, a margin rather than a mirror, by a daily job (`sweep:github-deliveries`,
   D-30). A delivery that failed and was not redelivered in those days is lost — said on the feed (§8).
   Accepted: the two headers are not signed, so a signed body sent again with a new id posts again —
   TLS is what stands between them.
6. **A feed's message has no author.** Its `sender` is null — `message_type = 'system_event'`, held by
   a `CHECK` that a person's message has a sender and an event has none — and it carries the event
   (`githubEvent`) as parts: repository, actor's login, and what happened, every field bounded, each
   link built from its parts as `GitHubLink`'s are (D-101), never taken from the payload. Nobody can
   edit one; an admin may remove it, as any message (D-34). It is no thread's author, so a reply or a
   resolution under it tells nobody for it; its text, an English summary, is what search finds —
   accepted: a reader searching in Turkish finds an event by its repository, its title or a login,
   not by the sentence drawn in their language. Its kind is held by the table
   (`messages_event_known`) and its shape by its one writer; a row the reader still cannot say is
   refused loudly rather than drawn as somebody's message or as nothing, so `GitHubEvent` changes
   only by adding.
7. **Quiet**: an event counts as unread like any message and never notifies, at any level and by no
   push — an amendment of D-107's `all`, which is about what people write. Nothing in it is parsed
   for `@`: a pull request titled `@alice` names nobody (D-12).
8. **A feed that cannot post says so** where it was set up: the last delivery and the last failure,
   with its reason — the channel archived, another repository, a body that is not the event, one too
   many for its bucket (0033) — are on the feed, and every delivery is one log line — feed, delivery,
   event, outcome, never the body. An archived channel's feeds, and a deleted workspace's, refuse
   their deliveries. A refusal before the signature is said in the log alone: anybody can cause one.

**Rejected.** *The creator as the author* — every place that asks "is this mine?" would answer yes
for an admin's every push: their bubble side, their edit shortcut, their unread count, a thread's
replies notifying them. *A GitHub user row* — a `users` row needs an email and a username that a real
GitHub account may hold, and it would be a member, a mention and a search result. *One webhook per
workspace, routed by repository name* — the name is not verified until the secret is known, and a
repository is in more than one workspace. *Our own retry queue* — GitHub keeps each delivery three
days and redelivers it on request; a queue of our own would be infrastructure no measurement has asked
for (CONTRIBUTING §1.11).

**Cost of reversing:** migrations 0031, 0032 and 0033, the event union on `Message`, three channel routes,
the webhook route and its job.

### D-135. A message's earlier versions — #82

**Context.** D-103 §2 kept no history in Phase 1 and said so; Phase 2 lists edit history (`PRD.md` §4).
The record is trusted because an edit can be seen for what it changed — D-103 §1 gave the author no
window on that promise.

**Decision.**
1. **Every edit keeps the words it replaced** as a version of the message (`message_versions`, 0034),
   written in the edit's transaction under the row lock the edit already takes, at the edit's one
   instant — the message's `edited_at` and the version's `replaced_at` are the same. The same words
   again are not an edit (D-103 §6) and keep nothing; A → B → A keeps both changes.
2. **Read by anybody who can read the message** — the history is the channel's as the message is —
   newest first, a page at a time (`Page`, `PAGE_LIMIT`), keyset on each version's UUIDv7 id. The
   message itself is the current version. **The author may remove one version**: the remedy for words
   edited out that should never be read — a token pasted and taken back — which would otherwise stay
   in the history for the whole channel. The edit box says so, in both languages. Accepted: an author
   who can no longer see the message — they left the private channel, or the workspace — cannot remove
   a version of it; an admin can delete the whole message, which removes them all.
3. **Bounded:** the latest `MESSAGE_VERSIONS_KEPT` (100) of a message are kept; an edit past it lets
   the oldest go. Accepted: a message edited more than a hundred times does not show its first words.
4. **Deleting a message removes its versions**, with its words, mentions and pin
   (`messages/delete.ts`): a tombstone hides what was said, and its history must not show it. D-9 is
   about the row and its thread surviving, which they do. Erasure (#83) tombstones bodies rather than
   deleting rows, so it removes versions too, and the cascade alone would not.
5. **Words only**: a version is never searched and never parsed for mentions (D-103 §5 told whom an
   edit named). A client's open history is read again when `MESSAGE_REVISED` arrives — an edit adds a
   version, a delete takes them all — and when `MESSAGE_VERSIONS_UPDATED` does: a version removed, on
   the channel's topic, so words taken out leave every screen that shows them.
6. **Messages edited before this** have no versions, nor has a message whose author removed every
   one: its history says there are none — not kept, or removed. A message deleted while its history is
   open says so there, rather than the dialog vanishing under the person.

**Rejected.** *A version per message state (`state_version`)* — it also counts reactions, threads and
deletes, so its numbers have gaps and say nothing about words. *Refusing edits past the bound* — a
lock on one's own words, which D-103 §1 rejected. *Only an admin removes a version* — the person who
pasted the secret is the one who knows it is there, and should not have to ask.

**Cost of reversing:** migration 0034, two routes, the history dialog.

### D-136. Who is online, for the people one shares a workspace with — #480

**Context.** D-120 moved online presence out of Phase 1 and asked dogfooding whether anyone misses
it; D-125 put it in Phase 2's second group, and the owner ordered it built before dogfooding has
started. Typing (D-114) answers "is anyone in this channel now"; this answers "is this person here".

**Decision.**
1. **Online is having Purlay open**: at least one socket on this node, any tab. Not "active" — no
   idle guess, no "away" (D-131 §5 left "away" to this; it is not built: a guess at attention reads as
   a fact about a person). Deep Work does not hide it. **Told to the people who share a workspace with
   the person**, and only them: a stranger never hears it, nor somebody removed a moment ago (membership
   is read as it is told). Accepted, and the owner's to change: a person in two workspaces who has one
   open is online to the other's members too — a socket is no workspace's, and telling which
   workspace would cost a frame from every client on every switch (O-4); it never says which.
2. **A grace before offline**: the person's last socket closing makes them offline only after
   `PRESENCE_GRACE_MS` (30 s); a socket back inside it tells nobody anything — a reload, a reconnect,
   a laptop's lid is not somebody leaving. A second socket says nothing new. The hub's own count of
   each person's sockets (the per-person cap's) is what says first and last, so nothing counts twice.
3. **Every change has a version** that only grows on the node, even across a clock stepped back; a
   client keeps the largest it has heard per person, so an "online" heard after the "offline" that
   followed it, or a snapshot read before a change, cannot undo it. `PRESENCE` is a list, so changes
   can be told together one day without a new frame.
4. **A workspace's presence** (`GET /api/workspaces/:workspaceId/presence`) is its members online,
   for a member: read when the workspace opens, and again a grace after the client reconnects — a node
   that restarted knows nobody until their sockets return, so the client keeps what it knew through the
   grace rather than showing the team offline. What the client cannot know it does not draw: a gap in
   its own connection longer than the grace, a read that failed, or a person who left the workspace
   forgets what was heard of them — no dot, never a stale one. Online is a dot on the avatar where a
   person is shown (People, a conversation's heading, their profile), and the word beside it for a
   screen reader; offline and unknown draw the same: nothing.
5. **One node** (D-25): each node knows only its sockets, so on two a person online on one is offline
   to the other — wrong, which `ARCHITECTURE.md` §6.1 allows only until the shared adapter over the bus;
   the reads are async so that adapter needs no caller to change. A stopping node tells nobody its
   sockets left: they are coming back elsewhere.
6. **Push while present** (D-126 §5) is not built here: it needs presence and a decision of its own.
   *Decided in D-143:* it reads attention, not presence — an open tab is not a person looking at it.
7. **A change that could not be told is tried again**, three times with a doubling wait, and only
   while it is still the newest change for that person: a co-member would otherwise be wrong about
   them until their next change, which may be hours away. Each failure is logged; a stopping node
   cancels the retries waiting.

**Rejected.** *Presence per workspace* — the client would say which workspace is open on every
switch, a frame per person per switch for a distinction a team of thirty rarely has. *Away after idle*
— a guess presented as a fact. *Offline at once* — every reload would blink a person off and on for
the whole team. *No snapshot, frames only* — somebody who opened Purlay before you would never be seen.

**Cost of reversing:** the frame, one route, the registry's online half; no migration.

### D-137. Incident channels: an incident is a state of a channel — #487

**Context.** D-125 §2 put incident channels in Phase 2, from the Superdesign screen `incident-channel.html`:
a channel flagged as an incident shows severity, status (investigating → mitigating → resolved),
responders, a timeline of its changes, a runbook link and a postmortem draft. Nothing said what an
incident is, who may declare one, what a retry or a race does, or who is told. The owner delegated these
choices; they are recorded here.

**Decision.**
1. **An incident is a state of a channel, not a kind of channel.** A public or private channel may
   have one; a direct message or a group has none (`404`, as starring one). At most one is open in a
   channel at a time (`idx_incidents_one_open`); a resolved one stays, and declaring again opens
   another, which is the one shown. The channel keeps its name — the usual way is a channel made for
   it (`#inc-…`), then declared.
2. **Anyone in the channel declares, moves and resolves it.** In an incident speed is worth more than
   ceremony, and every change is on the incident's own timeline with who and when, so it is not an
   administrative action of the audit trail (D-26). Somebody who can see a public channel without being
   in it reads its incident and is refused a change (`403`, as renaming it, D-123 §1). An archived
   channel is gone for everyone (D-123 §2), its incident with it.
3. **What it holds:** a severity, 1 to 4, SEV1 the worst; a status, `investigating` or `mitigating`
   either way round, then `resolved` once and for good, with its instant (`INCIDENT_RESOLVED` after);
   responders, members of the channel, at most fifty, brought in and taken off by anyone in it —
   kept, and still changed, after it is resolved, since who worked on it is part of what is written up;
   nobody outside the channel can be brought in (`404 USER_NOT_FOUND`, one answer for every kind of
   outsider), and somebody who leaves it afterwards stays on the list — a record of who responded, as a
   message stays its author's, never a change made silently under everybody else; a runbook link,
   `https:` only, with a host, at most 2048 characters, changed and cleared while open and after; a
   postmortem draft, markdown, as long as a message may be, written while open and after. The
   postmortem has no author — several people write it — so erasing a person's content (D-27 §2) does
   not reach it, as it does not reach a channel's topic.
4. **Its timeline** is append-only: declared, status, severity — and, as they ship, responders and the
   runbook and postmortem saved — each with who and when, newest first, keyset on a UUIDv7 that is after
   the newest whatever the clock says. The postmortem's words are not copied into it; that it changed is.
5. **A retry and a race have one answer each.** A declaration carries the client's UUIDv7 (D-33): the
   same id, in this channel, at the severity it was declared at, answers the incident it made, `200`,
   and tells nobody — however late it comes, after the incident moved or was resolved and another
   declared; the id used in any other way — another channel's, perhaps another workspace's, or this
   one's at another severity — is `409 INCIDENT_ID_CONFLICT`, naming nothing. A retry racing its first
   attempt waits for it and is answered the same. Two declarations racing with
   different ids: the index lets one in, the other is `409 INCIDENT_OPEN`. Status, severity and
   responders change without a version, the last change winning, each on the timeline; asking for what
   is already there changes nothing and tells nobody. Only the postmortem — prose two people may be
   writing — is saved against the version it was edited from.
6. **Quiet** (D-12): declaring, adding a responder, resolving — none notifies anybody, in the app or by
   push. People in an incident are told by writing in its channel, by `@username`.
7. **Told as a reason to read again:** `INCIDENT_UPDATED` on the channel's topic, after the commit,
   with nothing but the channel in it; a client reads the incident again, and every list of channels
   holding that one, whose mark it is. The channel list carries the open incident's severity and status
   (`Channel.incident`), one join on the open index.
8. **Shown** as a banner under the channel's header — severity, status, since when, the responders,
   and what opens its panel — and in that panel: status and severity, responders, the runbook, the
   postmortem with its preview, the timeline. A channel's details declare one; the sidebar marks a
   channel whose incident is open with its severity. Built in steps, each working end to end: the
   incident and its timeline; the web; responders; the runbook and postmortem.

**Rejected.** *An incident channel type* — a type cannot be undone, and a channel outlives its incident.
*Each change posted in the feed as an event* — a second kind of authorless message (D-134 §6), its
migration and its contract, to say what the banner and the timeline already say. *Declaring for owners
and admins only* — the person who sees the fire first is rarely an admin. *A version on every change* —
somebody's status change refused because somebody else was writing the postmortem is the refusal an
incident cannot afford. *Notifying responders* — D-12. *A workspace's list of incidents* — not asked for;
the table holds what one would need.

**Cost of reversing:** the incident tables (`0035`, and those after it), the routes and the frame; no
other table changes, and no message carries an incident.

### D-138. Signing in by email: a link that proves an address, and no account linked silently — #81

**Context.** D-11 kept magic links for Phase 2 and D-38 fixed the anchor they resolve against:
`users.email`, the GitHub account's primary verified address, `NOT NULL UNIQUE`. D-5 named the risk —
"same email via two providers, therefore the same person" is a classic account takeover — and the issue
asks for the account-linking rules before any code. This is them, and the shape of everything around
them.

**Decision.**
1. **A link proves control of an address at the moment it is used, and nothing else.** Asking for one
   (`POST /auth/email`) answers `202` whatever the address: it never says whether an account exists.
2. **Email sign-in is for accounts made by email.** The first link used for an address no account has
   makes one, with no `github_id`; later links sign into it. An address that belongs to an account made
   with GitHub is sent a message saying it signs in with GitHub, and no link — the answer to the asker is
   the same `202`. *Rejected, and why it matters:* signing a GitHub account in by link would let whoever
   holds a mailbox the account no longer uses (the address is refreshed from GitHub only as D-38 says)
   into it; and nothing in this product refreshes the address on each sign-in yet.
3. **Nothing is linked silently — D-38 stands.** A GitHub sign-in whose verified address is an email
   account's is refused with `ACCOUNT_EMAIL_CONFLICT`, as two GitHub accounts on one address are. The
   pre-hijack this closes: somebody who once held the address — a shared mailbox, a former colleague, a
   recycled domain — makes the email account first and keeps its session, and the victim's GitHub
   sign-in would otherwise walk into it. Connecting the two deliberately, from a signed-in session, is
   not built here; it is its own decision when somebody needs it.
4. **The link carries its token in the fragment**: `APP_URL/sign-in/email#<token>`. A path is logged on
   every request (ARCHITECTURE §10), and mail scanners that open links do not send the fragment. The page
   shows the address the link was sent to — somebody who forwarded their own link cannot sign a victim
   into the sender's account unnoticed — and **Sign in** posts the token as JSON, under D-39's origin
   rule; only that use consumes it. The token is the platform's (32 random bytes, hex), kept only as its
   SHA-256, valid fifteen minutes, once. Asking again sends another; an earlier one stays valid until it
   expires, so nobody who knows the address can cancel its owner's link. An invitation the asking tab
   holds (D-115) rides after the token, `#<token>.<invitation>`, because the mail opens in a tab that has
   none; the page keeps it for that tab once the person is in, and joining is still their click. The
   field is a token's shape and nothing else, so no words of the asker's reach the mail. *Accepted:* an
   address typed wrong sends the invitation to a stranger, who could make an account and join — as
   pasting the invitation into the wrong chat would; and somebody can attach their own workspace's
   invitation to a link for another's address, which the invite screen names before any join.
5. **The account a link makes** has a username made from the address's local part, lower-cased, cut to
   what a mention can name, never one of the broadcast names (`here`, `channel`, `everyone`), and made
   unique as D-38's collision is; its display name is the same. An address with nothing to make a name
   of — a broadcast name, or punctuation — gets `user-` and six random hex digits, not `user-1` …
   `user-99`, which a hundred such addresses would use up for good. Two new addresses wanting one name
   at the same instant: one is made, the other fails loudly and its link is not spent, so pressing
   **Sign in** again makes it under the next name. It is a member of nothing until invited.
6. **Delivery is SMTP**, the one transport every self-hoster has: `SMTP_URL` and `MAIL_FROM`, both or
   neither. Neither is email sign-in off — the server starts, `GET /api/auth/methods` says so, and asking
   is `503 EMAIL_SIGN_IN_UNAVAILABLE`, as push is off without its keys (D-126 §7). Every message carries a
   sign-in link, a bearer token, so mail to a relay past this machine goes only over TLS — `smtps://`, or
   STARTTLS required on `smtp://`, the usual submission on port 587 — unless `SMTP_ALLOW_PLAINTEXT` says
   the link is private, as the database's does (`docs/spikes/nodemailer.md`: the library refuses a
   server without STARTTLS when told to). The
   message is sent after the answer, so how long it takes says nothing about the address; the envelope
   names the one recipient. Whether the relay answers is said in the log as the server starts — not a
   refusal to start, since a relay down for a minute should not take the chat with it — and the shutdown
   waits two seconds for mail on its way, then says how many it left.
7. **Limits** (provisional, O-4): five links an hour for an address, twenty requests an hour from a
   client address, and the `auth` budget at the edge; past them the answer is still `202` and nothing is
   sent, said in the log without the address. The count holds under requests at once — one per address
   at a time, behind a lock in the transaction — and an address is one mailbox written one way: ASCII
   atoms, `@`, dotted labels. A looser check let `x<a@example.com>` through, which a mail library
   delivers to `a@example.com` while it counts as an address of its own and matches no account.
8. **Never logged:** the address, the token, its hash, or the link — the list of ARCHITECTURE §10.
9. **Erasure** (D-27, #83) deletes the person's pending links as it rewrites their address.

**Rejected.** *A one-time code typed in* — phishable, and the link is what every mail client opens.
*Linking by address* — §2 and §3. *A provider's HTTP API* — locks a self-hoster in. *A hand-written SMTP
client* — STARTTLS, AUTH and dot-stuffing are where hand-written clients fail; the library is a spike
(CONTRIBUTING §6.7) before it is a dependency. *A page rendered by the server for the link* — D-50's one
client, and a token in a path.

**Cost of reversing:** the email sign-in table and routes; no account's identity changes shape, and
GitHub sign-in is untouched but for the refusal of §3, which it already makes between GitHub accounts.

### D-139. Retention, account erasure and content erasure, as built — #83

**Context.** D-27 decided the three pieces; building them met edges it is silent on — a thread whose root
is older than the window and whose replies are not, what of a person is theirs beyond `users`, who may
erase, and a process that cannot reach the sockets. D-125 §4 makes them this feature's to decide. A
critique of the first plan found four of its answers wrong; what follows is what survived.

**Decision.**
1. **Retention purges messages, as D-27 says, one by one.** A reply older than the window is
   hard-deleted, and its thread's summary — the reply count and the last reply's time — is recomputed
   from what remains. A top-level message older than the window with no replies left is hard-deleted; one
   that still has younger replies becomes a tombstone (D-9's row change: its words, mentions, pin,
   versions and files go, the row stays to hold the thread) and is deleted the night its last reply goes. I-10's
   "never a message newer than the window" holds, and nothing older survives but an empty row. Age is
   `created_at`, never the id (`MESSAGE_ID_SKEW` lets an id run behind its time). *Rejected:* the thread
   as the unit — one reply a month would keep a whole thread's personal data forever, against D-27 §1's
   wording.
2. **What a purged message added is taken back before it goes**: the unread and mention counters of the
   members it was counted for — the same rule as a delete, set-based and shared with it — and its
   waiting notifications marked read, before the foreign key sets a read position on it to `NULL`.
   Attachments' bytes come off `storage_used_bytes` from the rows the delete returned (I-7 stays exact
   under two runs at once), and their blobs are queued in the same transaction and removed after commit
   — one the store refuses waits for `sweep:deletions` (D-141). `channels.last_message_at` is not
   touched: it only moves forward (SCHEMA §5.1), and if its message went every message went. The
   memberships of a batch's channels are locked first, as every other writer takes them, then the
   messages and a reply's root `SKIP LOCKED` — the purge never waits on a message row, so no reader or
   sender can close a cycle with it — and a reply arriving at that moment either lands first and keeps
   its root, or finds the root gone and is told `404`, on HTTP and on the socket alike.
3. **One audit row per workspace with retention set, per run**, `retention.purged`, actor none, counts as
   strings — written when nothing was purged too. A run with no workspace on retention writes none (the
   trail is a workspace's). No frame: a job has no bus, and an open screen keeps a purged message until it
   reloads.
4. **Retention is set by an owner**, `PUT /api/workspaces/:id/retention`, whole days from 30 to 36500 or
   `null` for forever, audit `retention.changed` with from and to. It is read by an owner only, on its own
   route: the `Workspace` shape is shown to people not yet in it (an invitation's preview).
5. **Account erasure is the person's own act, over HTTP** (`POST /api/me/erase`): the request must come
   from a session signed in within the last fifteen minutes and carry the account's username, typed — the
   one irreversible thing a stolen or forgotten session could otherwise do. In one transaction: the
   `users` columns of D-27 §2 and D-131 (email to `erased-<id>@erased.invalid`, username and display name
   to the reserved `deleted-user-…` made unique as D-38's collision is, `github_id` and the profile
   cleared), every session revoked with its address and agent cleared (D-81), push subscriptions,
   pending sign-in links for the old address (under the address's lock, D-138 §7), saved messages and
   notifications deleted. Messages, reactions, memberships, responders and audit rows stay, under the
   anonymised row; every surface shows the person as one localised "deleted user". After commit their
   sockets are ended. The locks are taken in the order every other writer takes them — the address's
   links, the sessions, the workspaces in id order, then the person — so a send, a sign-in or a role
   change at that moment takes turns with it; and a GitHub sign-in that read the account before it was
   erased writes nothing back onto the tombstone. *Rejected:* an operator's command — the process has no bus, so the person's open
   sockets would keep receiving every message until their session's natural end; erasing for somebody who
   cannot sign in is a separate issue.
6. **A workspace keeps a live owner.** An erased owner does not count as one — neither for the last-owner
   rule (I-2) nor anywhere else — and the last live owner of a workspace that has another live member
   cannot erase themselves: `409 LAST_OWNER`, naming the workspaces to hand over. Each workspace row is
   locked in id order first, so two owners erasing at once cannot each count the other. A workspace
   left with nobody live in it has its open invitation links revoked, or a newcomer holding one would
   join a workspace nobody could ever own again.
7. **Content erasure is an operator's command, per workspace** (`bun run erase:content <user>
   --workspace <slug>`; `--all` for a self-hoster who is the controller of every workspace, D-28): every
   message the person wrote there becomes a tombstone through the same set-based rule as a delete, and
   their attachments go with their blobs and bytes. Events, incidents' postmortems and runbooks (D-137 §3)
   are untouched. One `content.erased` audit row per workspace. No frame, as §3.

**Cost of reversing:** none for the data model — no column was added for any of it; what is purged or
erased is gone, which is the point.

### D-140. A workspace export: what it holds, how it is read, and who may ask — #84

**Context.** D-27 §3 decided an export: workspace-scoped, admin-triggered, NDJSON per table plus the
attachment blobs, produced by a CLI command and downloadable once; PRD §2.5 makes leaving the cloud a
supported operation, not a support ticket. Building it met what D-27 is silent on: which rows are the
workspace's, whose personal data goes with them, and how a large workspace is read without breaking the
database's own limits. A critique of the first plan found it put the download out of reach of an owner
and read the rows in a way the database could not serve; this is what replaced it.

**Decision.**
1. **Two doors, one export.** An operator runs `bun run export:workspace <slug> <directory>` — every
   channel; and an owner asks from the workspace and downloads it once (built in the same issue, after
   the files) — the channels that owner can see (D-34), so an export never shows an owner a
   conversation the product would not. Not a scheduled job (D-30, amended): it runs when asked. The
   owner's is made by the API process that took the request, after answering it — not a timer (D-30's
   concern), a piece of work somebody asked for — archived as one `.tar` (written here: a header and
   padding per file, no dependency), put in the store under the workspace's prefix, and downloadable
   once: the download claims it in the statement that checks it is ready, and the archive leaves the
   store when it has been served, whole or cut off. It is the asker's alone: another owner neither lists
   nor downloads it, since it holds what the asker can see; and an asker demoted or erased before it is
   made is not exported for. One at a time a workspace and a process; kept `EXPORT_KEPT_HOURS`. A run
   says it is alive every minute, and one silent for ten — the process stopped or restarted — is marked
   failed by `sweep:exports`, and the owner asks again; the scratch directory a crash leaves in the
   system's temporary directory is accepted, the operating system's to clear. The sweep claims an
   expired archive before it removes it, and retries an archive the store refused, failing loudly
   while one is left.
2. **What goes** is decided column by column over the generated schema (`modules/export/tables.ts`),
   so a table or column a migration adds fails to compile until it is classified, and a test binds the
   classification to the catalogue. The workspace's record goes; each person's own state — saved items,
   notifications, read positions, stars, notification levels, Deep Work — stays, as D-139 §5 treats it;
   credentials and secrets never go (sessions, sign-in links, devices, the sealed GitHub token, a feed's
   webhook secret, an invitation's digest, storage keys); caches and job records are nobody's.
3. **People** are everyone the exported rows name, by the public projection; the profile only for
   current members — a former member's was set after they left, in another context — and the address
   only in the operator's export, the controller's own records: in the product an address reaches only
   its owner (`models.ts`), so an owner's export carries none. Every bound goes through the scope's
   channels as the database knows them, so an id of another workspace's channel selects nothing.
4. **Read as one snapshot**, `REPEATABLE READ READ ONLY`, through a server-side cursor per table, each
   line written by the database (`row_to_json`) so times keep their microseconds and numbers stay exact,
   one page held at a time. The objects the export names are copied after the snapshot commits: the
   pool ends a transaction idle for fifteen seconds, and a slow store must not.
5. **Written owner-only** (0700 / 0600) into `<directory>.partial`, the manifest last, then renamed; it
   never writes over anything, and refuses a parent others may write into. One `workspace.exported`
   line on the trail, by nobody for the operator — written before the rename, so no finished export
   exists without its line.

**Rejected.** *Pages by id* — no index serves a workspace's messages by id, and reactions have no
workspace column: each page would walk the instance. *One transaction for rows and objects* — the idle
limit ends it. *Every column, filtered by a list of secrets* — a secret added later would leave unseen.
*The download for the cloud only* — PRD §2.5 makes it every owner's.

**Cost of reversing:** none for the data model; the format is versioned by its manifest.

### D-141. An object whose row is gone is queued until the store lets it go — #592

**Context.** Retention, erasure, the orphan sweep and a discarded upload delete attachment rows first
and their objects after the commit (D-109 §5, D-139 §2). An object the store refused was logged and
counted, and then forgotten; a process stopped between the commit and the delete lost the key without a
line. For retention and erasure that is personal data kept past the point the operator chose (D-27).

**Decision.**
1. **A table of keys waiting to be deleted** (`object_deletions`, SCHEMA §9.4), written in the
   transaction that deletes the rows naming them. Retention and erasure write it in `dropFiles`, the one
   place both delete files; the orphan sweep and a discarded upload write it beside their own delete. A
   delete that fails takes its queue rows with it.
2. **Drained after the commit**: each key the store accepts leaves the queue in one statement, each it
   refuses is logged by key and stays with its attempt counted. The callers' counts of what was left —
   retention's `filesLeft`, its failed run — are as they were.
3. **`sweep:deletions`, hourly at :50**, tries every waiting key again in key order from where it got to,
   so keys the store keeps refusing never hold back the ones after them, and fails its run while any is
   left, which `jobs:status` reports. A key whose object the store had already deleted, when the database
   then failed before the queue row went, is deleted again — harmless: a store's delete is idempotent.
4. **Not queued:** an export's archive, which its own row names until it is gone (`sweep:exports`,
   D-140); and the objects of an upload whose row never committed — nothing names them, and a stop
   between the store's write and the row's insert leaves them. Closing that window means writing the
   key before the object, on every upload; it is not done here. *Amended (#607):* it is done. An
   upload writes its keys to the queue before its objects, due an hour later so an upload still on its
   way is never deleted under it, and the transaction that inserts its row takes them out again; an
   upload refused or raced lets them go at once. The cost is two small writes per upload, beside a
   file of up to 25 MiB. Nor would a hard delete of a workspace or
   a message reach the queue through the cascade from `attachments` — no such delete exists, and one
   added must queue its files as `dropFiles` does.

**Rejected.** *Retrying inline* — a store down for an hour would hold a purge's batch, and a stop still
loses the key. *A store lifecycle rule* — the object store is the operator's and of their choosing
(D-109); the application cannot rely on one being set, and it would not say which keys are owed.
*Oldest first by `enqueued_at`* — a batch the store keeps refusing is read again on every pass; key
order with a cursor goes past it.

**Cost of reversing:** drop the table and call the store directly again; nothing else reads it.

### D-142. Forms are plain controlled fields, validated by the contract — #582

**Context.** `CONTRIBUTING.md` §4 said forms use `react-hook-form` and `zod`. Neither was ever a
dependency, and no form used them. Every form in the client — profile, invitations, new channel,
GitHub, incidents — is plain controlled fields, and what a field may hold is the contract's TypeBox
schema, checked by the server, with a refusal said on the field it names. A rule that nothing follows
and nothing checks is a wish (§6.2).

**Decision.** Forms are plain controlled fields. The server's contract is the one validation, and a
`VALIDATION_FAILED` refusal is shown on the fields its `fields` names. A client may check what helps the
person as they type — a required field left empty, a length it shows counting down — from the
contract's own constants, never from a second schema.

**Rejected.** *Keeping the rule* — two dependencies and a rewrite of every form, to add a client-side
copy of each TypeBox schema: a second copy of each shape (§1.4), which would drift from the server's.

**Cost of reversing:** adding the two packages, under §1.12, and moving the forms over.

### D-143. A push is held while its person is in front of that workspace's page — #545

**Context.** Web Push (D-126) told a person's devices what needs them even while they had Purlay open
and in front of them, so the phone in their pocket buzzed for what they were looking at. D-126 §5
makes the worker always show a push, so the place to hold one back is the server, before it sends.
Presence (D-136) is no help: online is having Purlay open in any tab, and a tab left open on a desk
while its person is away must not swallow the mention their phone should have told them of.

**Decision.**
1. **Active is a page that is visible and focused, used recently, in that workspace.** While its
   document is visible and focused, a page says so with an `ACTIVE` frame naming its workspace, on the
   person's own input — a key, a pointer, a touch — no more often than `ACTIVE_EVERY_MS` (60 s), and
   once as it comes to the front. The server holds the last word per person and workspace
   (`platform/attention.ts`) for two of those intervals, so one word lost on a slow socket does not end
   it. It is a guess, and it stays the server's: nothing shows it to anybody (D-136 rejected "away" as a
   fact about a person; this is only whether to buzz a pocket).
2. **Held for every device of the person, for that workspace only.** The page in front of them already
   says it — the inbox, the badges, the title. Active in one workspace holds nothing of another's.
3. **Held means dropped, never sent later** (D-12): a person who comes back to their phone after an
   hour at their desk is not handed a burst of what they already read.
4. **Authorised before it is held**: an `ACTIVE` for a workspace the sender is not in is the
   stranger's `404` and takes no place in memory. The frame is answered with nothing.
5. **In memory, per node** (D-7, D-25): a restart forgets it, costing at most a push that was not
   needed; on a second node a word heard by the other is not known here, and the push goes — the
   quiet side of wrong. Memory is bounded by the people active now: a word past its window is let go.

**Rejected.** *Presence* (an open socket) — a background tab on a desk would silence the phone in the
person's pocket. *Holding only other devices than the active one* — the active one is a page, which
does not get pushes while it is in front. *Deferring held pushes* — a burst later, against D-12. *A
frame on every input* — a frame budget spent on keystrokes (O-4); one a minute is enough for a
two-minute window.

**Cost of reversing:** the frame, `platform/attention.ts` and one filter in the push sender; no
migration.

### D-144. The production stack prepares its own object store on `up` — #76

**Context.** S-2 asks that a stranger self-host Purlay from the README. After `docker compose up` one
step remained, `scripts/production-init.sh`, which gives the Garage node its place in the layout and
makes the bucket and the application's key through Garage's CLI. Compose cannot run it: the Garage
image has no shell, and one service cannot exec into another (D-94, `docs/spikes/object-storage.md`).

**Decision.** A one-shot service, `storage-init`, runs `apps/api/src/cli/storage-init.ts` from the API
image on every `up`, after Garage is healthy, and the API and the scheduler wait for it to have
completed successfully. It drives Garage's admin API (`docs/spikes/garage-admin.md`), which listens on
the stack's network only and is authorised by a new secret, `GARAGE_ADMIN_TOKEN`. Each step reads
first and does only what is missing — the layout, the bucket, the key, its rights — so a later `up`
does nothing; then it checks that an anonymous read of the bucket is refused with `403`, and anything
else fails the run and holds the API back. The database already migrates as the API starts (D-93), and
the first person to sign in makes the first workspace (D-124): together, one command.

**Rejected.** *Running Garage's CLI from a second Garage container* — the CLI needs the node's id
before it can assign it, and without a shell nothing can pass one command's answer to the next.
*Baking the bucket and key into Garage's configuration* — Garage has no such setting; its state is
made by API or CLI. *Keeping the manual step and documenting it* — what S-2 counts is whether a
stranger succeeds, and a second command after `up` is the one people miss.

**Cost of reversing:** the service, the CLI, the admin listener and the variable; the stack works with
`production-init.sh` as before.

### D-145. The contributor licence agreement: a licence grant, signed in the repository — #122

**Context.** D-24 requires a CLA on every outside contribution before contributions open, so the
copyright holder can keep offering a commercial licence beside the AGPL. It left open which
agreement, how it is signed, and how an unsigned pull request is stopped.

**Decision.**
1. **A licence grant, not an assignment.** `CLA.md` is the Apache Software Foundation's Individual
   CLA v2.2, the most widely used and read agreement of its kind, changed only where the Foundation
   is not a party: the Maintainer is the copyright holder `NOTICE` names, the nonprofit clause goes,
   and section 2 says outright that the sublicence extends to other terms — the right D-24 needs.
   The contributor keeps their copyright.
2. **Signed in the repository.** The contributor adds their GitHub login, name, the agreement's
   version and the date to `.github/cla-signatures.json`, in their own pull request; the entry, made
   under their own account, is the signature, and the history is the record. A new version of the
   agreement is signed again.
3. **Held by the pipeline.** `bun run check:cla` runs in the `verify` job, which merges require: the
   author is a maintainer (the owners `CODEOWNERS` gives the whole repository), Dependabot, or has
   signed this version; and a pull request adds no signature but its author's own, and removes none.

**Rejected.** *Copyright assignment* — it asks more than D-24 needs and keeps contributors away.
*The Developer Certificate of Origin* — it certifies where the code came from but grants no right to
relicense, which is the point. *A hosted CLA service* (CLA Assistant and its kind) — a third party
holding the signatures and a GitHub app with write access, for what a file and a check already do.
*Writing an agreement of our own* — a legal text nobody has tested is worth less than one that a
generation of contributors and lawyers has read.

**Cost of reversing:** the file, the check and the pipeline step; signatures already given stand.

### D-149. A link to a message: its own address, and the feed read around it

**Context.** Nothing in Purlay could be pointed at. The only deep link was a thread's (`?thread=`);
search, saved items and pins opened a channel at its bottom, so a message older than the first page
was a scroll and a guess away. Every chat tool a team compares this with has *Copy link*, and opening
one lands on the message.

**Decision.**
1. **The address is `?message=<id>` on the channel's own** (`router/routes.ts`, beside `?thread=`,
   read only when it is an id). One address for a root and a reply: a reply's link opens its root's
   thread, and the reply is the one marked there. *Copy link* writes it whole, with the page's
   origin. Search, saved items and **Go to message** in the pins panel go to it.
2. **The feed is read around the message, by one route built from the feed's own pages.**
   `GET /api/messages/:messageId/around` answers `MessageWindow`: the message, the root it lives
   under with `MESSAGE_WINDOW_SIDE` (25) roots either side, and two cursors that are the ones a feed
   already reads with — `olderCursor` as `before`, `newerCursor` as `after` (D-8). The server reads
   it as two keyset pages; nothing new orders a channel and nothing is offset. Who may read it is
   `requireMessageById`'s answer, so a message deleted, never sent or not the caller's to see is one
   `404 MESSAGE_NOT_FOUND`, and the endpoint is crossed on both axes like every other.
3. **On the client the window is a query of its own under the channel's key**
   (`['messages', channel, 'around', id]`), paged both ways. Everything that edits a channel's
   messages edits it too, because it is found by the channel's key. A message arriving is put in it
   **only once it reaches the present**: one put after the newest message of a window that stops
   short would sit above messages it has not read. Until then **Jump to recent** takes the reader to
   the channel without the link, as sending does, and nothing is marked read.
4. **Landing:** the message is brought into the middle of the view, focused through the feed's
   roving focus, and marked in the highlight tone (`warning-subtle`) for two seconds, fading by the
   hover token — which is zero under reduced motion, so no new motion token was needed. Newer pages
   read in below keep the reader where they are, without the pill: it is history, not news.
5. **A link nobody can follow says so in one sentence** over the channel, which opens as it is — a
   link pasted from a channel left, or a message deleted since, is ordinary and must not look like a
   failure of the product.

**Rejected.** *Reading back page by page from the newest until the message is in* — what `?thread=`
does: a link to a message from last year is dozens of requests and a wait, and the more a link is
worth (older), the worse it would work. *A cursor computed on the client one tick below the id, to
reuse `after`* — it leans on the id's byte layout and still needs a second request to learn a reply's
root. *An `around` parameter on the history route* — it would answer a different shape from the same
route, and a page carries one cursor. *Putting the window into the newest-first feed's cache* — a
feed with a hole in it is a feed every frame handler and the read position would have to understand.
*Highlighting with a new animation token* — the hover fade already says it, and costs nothing.

**Cost of reversing:** one route and its contract, the window query and the address; links already
pasted would open the channel at its bottom.

## Part D — Open, deliberately

Recorded so they are not silently assumed. None block Phase 0.

- ~~**O-1 · Message editing.**~~ **Closed by D-103:** no window, shown as edited; no history until
  Phase 2 — kept since D-135; a resolved thread is edited by the same rules.
- ~~**O-2 · Invitations.**~~ **Closed by D-115:** shareable links, made and revoked by an owner or
  an admin, opening for seven days to anyone signed in who holds one, as a member.
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
  which must be zero for legitimate use. Both are recorded: each socket's closing line carries
  `frames`, `peakPerSecond` and `refused` (#61, `realtime/frame-meter.ts`), so the week is a query
  over the log — `bun run report:frames <log>` is that query, and says whether the week closes it.
- **O-7 · What the command palette is built on.** D-52 named a Radix combobox; Radix does not
  publish one (`docs/spikes/frontend-budget.md`). `cmdk` is built on Radix and is what the budget
  measurement used; a listbox hand-built on `@radix-ui/react-popover` is the alternative, and the
  argument for primitives — that focus and ARIA fail *silently* when hand-written — applies hardest
  to exactly this component. *Decide with #138, and measure it.*
- ~~**O-6 · The two markdown packages D-36 named as categories.**~~ **Closed by D-101:** one
  engine, `mdast-util-from-markdown` with four GFM extensions, on both sides, narrowed to what the
  product renders and bounded so a body past the bounds is shown as typed.
- **O-5 · Scroll virtualization.** Variable-height rows — code blocks, cards, pictures, and until
  D-122 inline expandable threads — are the hardest UI problem in the product. `UX.md` §6 fixes the Phase 1 stance —
  ship **unvirtualized** with a 50-message window — and the scroll-anchoring rules that hold
  either way. What remains open is whether to adopt virtualization at all, decided against the
  `< 100ms` channel-switch budget. *Measure first.* **How it is measured in use:** every switch is a
  `purlay:channel-switch` entry in the browser's own performance timeline, from the change of address to
  the frame that draws the new channel's rows (`apps/web/src/app/switch-timing.ts`); nothing leaves the
  device (D-44). After a week of the team's use, each person reads theirs in the console with
  `performance.getEntriesByName('purlay:channel-switch')` before closing the tab.
