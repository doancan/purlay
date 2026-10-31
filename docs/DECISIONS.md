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
Phase 0 proves the pipe works end to end, Phase 1 gates on every listed capability built and verified end to end (S-1, amended by D-197),
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

*Amended 2026-10-21 by D-179:* Better Auth owns sign-in and sessions from here; the opaque cookie
validated against `sessions`, and the hash in place of the token, stay — held by a plugin of ours — and
GitHub is no longer the only way in.

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
"mobile client" this phase list originally implied. **Amended 2026-10-26 by D-186:** the desktop client is a
native Swift application for macOS, and the Tauri shell is not built.

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

> **Amended 2026-10-19 by D-161.** A person can follow a thread they have not written in, and let go
> of one they have; a choice stands until they make another, and replying again does not undo it.

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

*Amended 2026-10-21 by D-179:* `better-auth` is the library now, for the reasons of sign-in, sessions and
setup, not for OIDC. OIDC is still built only when an operator asks.

*Amended 2026-10-27 by D-200:* the condition is gone and OIDC is built — a third way in beside GitHub and email, with
the linking rule and the checks that make a provider's word believable. SAML stays refused.

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
*Amended 2026-10-22 by D-179:* the library decides it (`unable_to_get_user_info`, `email_not_found`, `email_not_verified`), and the person is sent to the sign-in screen with `email-required`; the code `EMAIL_REQUIRED` is no longer in the contract, for nothing sent it.

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

*Amended 2026-10-31 by D-221:* the API serves a Prometheus page for the operator's own scraper, off until
`METRICS_TOKEN` is set; nothing is sent anywhere, so the paragraph above on self-hosters still holds.

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

*Amended 2026-10-23 (the environment a run starts in): Bun loads `.env` from the working directory into
every process it starts, so a machine with a development `.env` ran the suite — and each `bun` a test
started in turn — against the developer's key, bucket and database, and three differences between that
machine and CI were found by hand in one afternoon (the demo's sessions signed with another key than the
server they were for; the browser suite's server writing to a real bucket; "without a database" finding
one). A test run, the demo, the browser suite and the budgets are therefore started `bun --no-env-file
--env-file=.env.test`: they read **one** file, the address of the database server they may create scratch
databases on, and a clone with no such file is not an error. Every `bun` they start says `--no-env-file`,
which `scripts/hermetic.test.ts` checks — a rule held by remembering is a wish (D-47). And the database
`withRollback` uses *directly* — the one place a test does not run on a clone of the migrated template —
is brought to the latest migration by the preload as the template is (`migrateIntegrationDatabase`): one
last migrated before a migration was added answered "relation does not exist" to every test that used it.
Considered and rejected: scrubbing the keys `.env` defines from the process in a preload — it cannot tell
a value the developer exported on purpose from the same value in the file.*

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
*Since 2026-10-21 the other three are `bun run budget:browser` (#727), per browser project, by the same
rule, on each run's median — five cold loads, twenty keystrokes, twenty switches: judged on a p95, a
documents-only change failed on one stall. Until then the browser tests held them to the line on the runner too, where the channel switch
measured 120–170 ms against a laptop's 33; there they are now judged on a jump, and the tests keep the
line on a developer's machine.*

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

*Amended 2026-10-26 (browser budgets):* "a regression against main's last run" meant one run, and one run is not what is
normal: the channel switch measured 58 ms in one run of main and 107 in the next, identical, so a lucky run kept as the
baseline failed the browser job of every change after it — a change to the API included — until somebody re-ran it, which is
the gate D-49 says people learn to ignore. The kept file is now the last five runs that passed, and a regression is a
jump past 1.5 times the *slowest* of them: the same code measured 58, 72 and 124 ms on one kind of runner, so the spread
is the envelope (a first version judged against the middle and still failed at 109 ms against 72). While there are
fewer than three runs to see a spread in, the factor is 2. A regression is still never
adopted, and the line itself is still held where it means something, by the tests on a developer's machine.

*Amended 2026-10-28 (API latency trials):* [main run 40662081925](https://github.com/doancan/purlay/actions/runs/40662081925)
reported ACK and fan-out p95 of 57.3 ms against a 14.8 ms baseline, after a CI-only change with no
API or database runtime diff. Three unchanged local runs measured ACK p95 of 24.01, 23.56 and
23.98 ms; they did **not** reproduce the hosted slowdown or prove its cause. The old log held only
one p95 per metric, so it could not distinguish a single disturbed run from sustained slowness.
[The next main run, 40666696134](https://github.com/doancan/purlay/actions/runs/40666696134), passed
at 14.4 ms ACK and 14.0 ms fan-out against the same 14.8 ms baseline, with no message-path change.
That supports run-to-run variability rather than a persistent code regression; it does not identify
the hosted disturbance's cause.

The command now always measures **three independent API processes sequentially**, each with sixty
messages at the same pace, and compares the **median of their p95s per metric**. This is not a pooled
percentile of 180 messages. Every trial is printed and saved alongside the summary. One isolated
slow trial does not decide the verdict; a sustained slowdown in two or three trials still fails
against the unchanged **1.5× factor and 20 ms floor**. Trials are neither retried until green nor
discarded on failure: an interrupted or incomplete measurement fails the command. Existing flat
baseline files remain readable and are compared, rather than reset. Only a passing summary replaces
`--keep`; CI separately records the current summary and trials, even on regression, in a seven-day
artifact. The cost is roughly sixteen more seconds per budget invocation, including the invocation
inside the integration tests. The first comparison may still be against a legacy single-run baseline.

**Rejected:** raising the factor/floor, deleting the baseline, using the minimum trial, retrying until
a pass, or dropping cold messages: each would hide evidence or change the performance being measured.
The repeated-trial design follows [pyperf's guidance on independent processes and multiple values](https://pyperf.readthedocs.io/en/latest/run_benchmark.html);
the trial count and all raw p95s remain visible. A runner consistently slower than the baseline will
still fail; investigating its environment remains necessary if that occurs.

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

**Amended 2026-10-26 by D-186:** macOS now gets a native Swift client in its own repository, and the Tauri shell
is dropped. Mobile as an installable web application, and the web client for Windows and Linux, stand as written
below; "native Swift clients are not planned" no longer does for macOS.

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
newer version. There is no third-party client, so the tolerance would buy nothing and cost a silent failure
mode. (D-51 once added: one client ships with the server. D-186 ends that for macOS: the app is updated on its
own schedule, which is why *responses* are additive and the app ignores fields it does not know — this rule
is about what the server accepts, and is unchanged.)

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

**Amended by D-197:** dogfooding is a practice, not the thirty-day gate this entry describes.

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

*Amended 2026-10-21 by D-179:* the property holds — two first sign-ins of one GitHub account at once
are two sessions and one user — and its mechanism is the sign-in library's now: the tab whose insert
lost is sent round `/auth/github` once more, and finds the account the other made (D-179 §3, Ruling
R28). The `ON CONFLICT` statement above is gone with the code it was in.

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

**Not covered, said out loud:** point-in-time recovery (WAL archiving, the cloud's requirement in D-44; since
built, D-202), off-host copies, a production schedule, and the `ENCRYPTION_KEY`, which a backup must never carry.

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

> **Amended 2026-10-19 by D-147.** §4: the read position reads the feed — the notifications of the roots
> at or behind it — and never a reply's, which is read in its thread or the inbox; a reply waiting
> behind the position counts as unread until then. §1's two numbers and I-6 are unchanged in meaning.

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
owner, with *as typed* and *a real heading* rejected. *Amended 2026-10-26 by D-189:* a heading has a size by its level (still not a heading element).

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
— the option when creating, and bringing people in — which is a `web` issue. *Leaving is D-123.* *Removing is D-172.*

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

**Amended 2026-10-28 (#787).** A client can ask for one or more stored notification reasons before
pagination, independently of All/Unread; `API.md` §6 owns the wire details. One bounded CSV string
keeps the existing single-value query convention and fits the contract generator's current JSON
Schema vocabulary. Repeated query keys, an implicit array serializer and a new custom string format
were rejected because each would make the wire contract depend on a second rule a client does not
currently receive. The filter changes neither generation/preferences nor workspace-wide mark-read
semantics; category counts remain separate. Omission includes every supported reason.

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
*(Amended 2026-10-19 by D-147: a reply the feed was read past is unread only because its notification
waits, so reading it here takes it out of the unread count too.)*

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

**Amended 2026-10-19 — an open inbox hears every notification, not only those that move a counter.** The
client asked an open inbox again when a channel's `unreadMentionCount` rose. A notification that moves
no counter — a `thread_resolved` (§2: told, not counted), or a mention in a public channel the person is
not in, where they have no counter — never reached it before a reload. Each write that creates a
notification now tells its person `NOTIFICATIONS_UPDATED` on their `user:` topic after the commit, with
nothing but the workspace in it — a send, an edit naming somebody new, a resolution — and the client
reads that workspace's inbox again, as `SAVED_UPDATED` does for saves (D-128); a reconnect reads it again
too. The counters no longer ask: one frame per notification, not two. **Rejected:** reading the inbox
again on `THREAD_UPDATED`, which the whole room hears for every reply — the client cannot tell from it
whose question was closed without holding the root, and would ask on every reply in every channel;
and carrying the notification in the frame, which would be a second shape of it beside the page's,
for a list the client reads whole anyway.

**Amended 2026-10-31 — `created_at` is the server's clock, as the message's time is.** It was the
database's `now()`, while the message, its resolution and every other stamp of a send come from the
server's injected clock. Live the two agree to the millisecond; under a clock that is not the wall's —
the demo seed plays two days of history (D-33) — every notification read as the moment of seeding, so
the inbox gave all its rows one time beside a feed of many. Now the send, the edit that names somebody
new and the resolution write the instant they already hold. §1's order and the accepted late-commit
window are unchanged: the instant is still taken before the transaction commits.

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
waiter, never given back, so a newcomer cannot make it three. *Amended by D-170:* at most eight wait,
and the image proxy holds at most one of the two.

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
never change, and the cache is the person's own. *Amended 2026-10-31 by D-231 §3:* `private, no-cache` with
a tag — a copy is used only after the server has said again that the reader may have it.

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

*Amended 2026-10-21 by D-179:* an invitation is accepted only by an account whose address is verified, and
may be sent by email where the server has mail, saying so when the send fails and keeping the link to copy.
The link, its token, its seven days and the rest stand.

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

   *Amended 2026-10-21 by D-179:* ending a session deletes its row, as the sign-in library does, so
   "revoked when" is no longer kept, and a row's `session_id` becomes `NULL` the moment its session
   ends — in the same transaction, for an erasure's own trail rows too — not when it is swept.

**Rejected:**
- *Copying the address and agent onto each row.* An append-only table of addresses, kept forever, on a
  self-hosted product whose operators answer to GDPR and KVKK.
- *A nullable `workspace_id` for instance events.* A second kind of row that no workspace's admin can
  read, for a record the sessions table already keeps.
- *Passing the session through every service.* Nine signatures for one cross-cutting fact the request
  already carries.

**Accepted, stated:** after a session is swept, its rows say who acted and when, but no longer from
where. The sessions table keeps a session thirty days by default (`SESSION_TTL_DAYS`) plus the sweep's
grace — the window in which "from where" is a question worth asking. *Amended 2026-10-21 by D-179:*
a session's row now goes when the session ends, not when it is swept, so the link to it becomes `NULL`
at that moment (§4's amendment).

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

### D-119. A conversation has two edges: bubbles, and your own messages on the right — reversed by D-187

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
   one too once Pin joined them (D-130) (`UX.md` §2). *Amended by D-150:* the actions are a bar on
   the row's own top edge, in the corner the message is not in, and only one row shows its bar.
7. **The channel's feed and composer are centred** in the column (amends D-110 §5). The other screens,
   which have one edge, still hang from the left. *Amended by D-177:* nothing is centred; the feed, the
   composer and every other screen fill the main area from its left edge.
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

*Amended 2026-10-26:* a callback that carries a state another callback is still being answered for waits for it
(`oneAtATime`, `ingress/http/auth.ts`). The library reads a state and spends it in two steps, so two callbacks arriving
together (a double click, a retrying browser) could both read it and both go to GitHub with one code; the second was
refused as a spent code and told *GitHub is unavailable* when the first had just signed the person in. Queued, it reads a
state that is gone and is `expired`, as §3 says. Found as a failure of one run in about a hundred and fifty of the test
for it, on main's own pipeline.

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
   *Taking somebody else out, and naming yourself, is D-172.*
4. **A direct message has none of these**: `404 CHANNEL_NOT_FOUND`, the answer `join` gives for a
   channel the endpoint does not serve. It has no name, and it *is* its two people (I-5).
5. **There is no default channel.** A workspace starts with none and an invitation joins none
   (D-115), so nothing needs protecting from being left or archived. A default channel, if one is
   ever made, decides that for itself. *Amended by D-174:* a workspace starts with `general`, and
   nothing marks or protects it — it is left and archived by these rules.
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

**Amended 2026-10-19 by D-146**: Settings are a page; the account menu, the workspace menu and the
rail's foot are as D-146 §4 says.

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
   *Amended by D-155:* not anybody's — the operator's `WORKSPACE_CREATORS` says whose, and the item
   is offered only to them.

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
   *Amended by D-148:* the switch itself is still offered without keys, for the notices an open tab
   in the background shows; push joins it where the keys are.
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
   visible non-member is `403` (`NOT_A_CHANNEL_MEMBER` since D-156), as renaming it is (D-123 §1). **Everyone's to see**:
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
   TLS is what stands between them. *Amended 2026-10-31 by D-231 §1:* no longer accepted — the body's
   digest is recorded beside the id, and a body a feed has posted is a duplicate under any id.
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

*Amended 2026-10-21 by D-179:* the link is Better Auth's magic link — its token still in the fragment, the
limit still five an hour, now counted in the database. §2 and §3 are replaced: one verified address is one
account, and a GitHub sign-in is no longer refused because an email account has the address.

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
   not built here; it is its own decision when somebody needs it. *Amended 2026-10-20 by D-176:* it is
   built — from a session signed in as the email account, bound to that session; the refusal here stands
   for every unlinked sign-in, and now names that way through.
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
   **Sign in** again makes it under the next name. *Amended 2026-10-21 by D-179:* the second is undone
   and tried once more by the server, so both are made, under the name and the next (D-179 §3). It is
   a member of nothing until invited.
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
   client address, and the `auth` budget at the edge (*amended 2026-10-31 by D-231 §2:* five for an
   address from one client, twenty for it from every client); past them the answer is still `202` and nothing is
   sent, said in the log without the address. The count holds under requests at once — one per address
   at a time, behind a lock in the transaction (*amended 2026-10-21 by D-179:* each count is one
   statement on a counter in `rate_limits`, which takes its row, D-179 §3) — and an address is one
   mailbox written one way: ASCII
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

### D-146. Settings are a place: a page with its own navigation, not a menu of dialogs

**Context.** D-124 rejected *a Settings page* ("five choices fit in a menu"). By 2026-10-19 the
workspace menu held nine items, each a 480px dialog — members, invitations, the GitHub token, the
audit log, the workspace's name, retention, export — and the account menu sixteen: profile, four
Deep Work durations, three themes, two languages, shortcuts, notifications on this device and three
ways out. The owner looked at the running product and called the menus cramped and the screens
undesigned, and their own Superdesign screens (*Profile & Preferences*, *Members & Roles*,
*Notification Settings*, *Security & Audit Log*) draw a settings page with a navigation of its own.
D-124 was decided under the standing instruction to decide and proceed and said it was open to the
owner's reversal; this is that reversal. The owner delegated the design: "modern, enterprise SaaS,
clear, professional".

**Decided.**

1. **Settings are a route, `/w/:slug/settings/:section`**, inside the shell: the rail stays, and the
   sidebar's place holds the settings' navigation — *Back to <workspace>*, then **Account** (Profile,
   Preferences, Notifications, Keyboard shortcuts, Sessions & account) and, for an owner or an admin,
   **Workspace** (General, Members, Invitations, Integrations, Audit log, Data & retention). A member
   sees no Workspace group: a section they could only be refused is not drawn. `/w/:slug/settings`
   opens Profile. An unknown or forbidden section is *not found*, as any address is.
2. **One page shape.** A title and one sentence of what the page is for; then sections, each a card
   with a heading; each setting a row with its label and a sentence on the left and its control on the
   right, stacked below the narrow breakpoint. The column is `size-settings` (720px), centred in the
   main column on a ground a step below the cards (`surface-000`), as the screens draw it; a control
   in a row is `size-field` (320px) wide. Lists that are tables — members, the
   audit log, invitations — use the full card width with a toolbar above them.
3. **A choice takes effect when it is made; words are saved with a button.** The theme, the language,
   a role and a toggle apply at once, as they did in the menus. A form of words (profile, the
   workspace's name) has **Save** in its card, enabled only once something changed, with the outcome
   said beside it. No page-wide *unsaved changes* bar: each card saves what it holds, so leaving a page
   loses at most what was typed and not saved, and the browser's own warning is not borrowed for it.
4. **The menus shrink to what is done often.** The account menu: who you are, Deep Work, **Settings**
   (`Cmd/Ctrl+,`), the shortcut reference, **Sign out**. Theme and language move to Preferences; *Sign out
   everywhere* and *Erase my account* to Sessions & account. The workspace menu: the workspaces,
   **Create workspace…**, **Invite people…** (an owner's or an admin's, the one thing done from inside
   a conversation) and **Workspace settings**. The rail gains a gear at its foot that opens Settings —
   D-124 §4's objection, a gear "left with nothing in it", no longer holds. The palette offers every
   page by name.
5. **The settings are a chunk of their own.** Loaded when first opened, so the initial JavaScript does
   not pay for screens a person opens a few times a month (D-49, #687).
6. **Not drawn: what Purlay does not have.** The screens also draw SSO, SCIM, two-factor, an IP
   allowlist, seats, guests, billing and an email digest. Each is outside Phase 1 or refused
   (`PRD.md` §4, §7); a navigation entry for it would promise what is not there.

**Rejected.**

- *Keeping the dialogs and widening them.* The problem was never the width alone: nine doors in one
  menu, each to a room of its own, with no place that says what the workspace's settings are.
- *A modal settings window* (Slack's preferences). It hides the conversation for longer than a dialog
  should (`UX.md` §1), cannot be linked to, and a member list or an audit log needs a page's room.
- *A page-wide unsaved-changes bar* (the Superdesign screens). It makes every toggle wait for a second
  press, and it needs a guard on every way out of the page for what a per-card Save does without one.

**Amends D-124** §3 and §4 (what the account menu holds, the rail's gear) and its rejection of a
Settings page. **Cost of reversing:** the route, the navigation, the pages (which reuse the dialogs'
logic), and the menu items moved back.

### D-147. A reply is read in its thread, not by scrolling the feed past it — amends D-99 §4

**Context.** An audit reproduced it twice. Bob asked in #incidents; Carol answered **in the thread**;
Alice then wrote something unrelated in the channel. Bob opened the channel and scrolled to the bottom
without opening the thread — and Carol's `thread_reply` went from unread to read, its badge, the tab
title's count and the inbox's unread state with it. Bob never saw the answer. D-99 §4 marked read every
notification at or behind the read position, and a reply's id sorts in the channel's order with the
roots, so any reply older than the newest feed message counted as read. Written when a thread opened
inline under its root, it never considered replies; since D-122 a thread is a panel the feed does not
show, and the rule re-created exactly the failure D-29 exists to prevent — an answer to your question
that you are never told about.

**Decided.**

1. **The read position reads the feed.** `PUT …/read` marks read the caller's notifications for the
   **roots** at or behind it — a mention, a direct message, a followed channel's message, a resolution.
   A notification for a **reply** — `thread_reply`, a mention inside a thread, a reply in a direct
   message — is read by reading its thread, or in the inbox (D-106), and by nothing else.
2. **Reading a thread is a request.** `PUT /api/messages/:messageId/thread/read` with
   `{ lastReadMessageId }` (`ReadThreadRequest`) reads the caller's notifications for that root's
   replies up to and including the reply named, recounts the channels touched by the inbox's own path,
   and tells the caller's devices `CHANNEL_STATE`. Anybody who can see the root may; a reply has no
   thread, `404` as `GET …/thread` answers. Nothing is stored but the notifications: a thread has no
   read position of its own (see *Rejected*). The client sends it while the thread is in the panel, the
   page is in front of the person and the channel has something waiting, for the newest reply it has
   from the server — so a reply that arrives after it looked is still waiting.
3. **What is unread follows.** `unread_count` is every message by somebody else past the read position
   **and every reply at or behind it whose notification still waits** — the feed was read past it, the
   thread was not. That keeps `unread_mention_count` within it (I-6, unchanged) without capping the badge
   to zero the moment the feed is read: the badge, the tab title (`UX.md` §2) and the inbox dot (D-110)
   keep saying it needs you. Every writer agrees, so the stored numbers stay what a recount finds: the
   read position recounts both terms; reading the inbox or a thread takes back one unread for each reply
   behind the position it read; a reply that arrives behind the position (an id up to a minute old,
   D-33) is not pre-read and is counted for the people it needs; an edit that adds a mention to such a
   reply counts it too; deleting it takes back from both numbers.

**Rejected.**

- *A read position per thread* — a `thread_members`-style row per person per thread. It would answer
  "where did I stop in this thread", which nobody has asked of a panel that shows the whole thread, at
  the cost of a table, a migration and a second recount. The notification rows already say what is
  waiting; reading a thread only has to read them.
- *Leaving the notification unread and the counters as they were.* The inbox would have kept the
  answer, but the badge is the lesser of the unread messages and the waiting notifications (I-6): with
  the feed read to the bottom the unread count is zero and the badge would still have vanished — the
  half of the defect that interrupts nobody, which is the half that matters.
- *Dropping I-6.* It is a `CHECK` the badge's meaning rests on; the fix is to count what is unread
  correctly, not to let the two numbers disagree.
- *Opening the thread reads everything in it, without a bound.* A reply arriving between the panel
  drawing and the request reaching the server would be read for somebody who never saw it.

**Cost of reversing:** the root-only condition in `read-state.ts`, the second term of its recount, the
reply cases in `delivery.ts`, `edit.ts` and `tombstone.ts`, the endpoint, `ReadThreadRequest`, the
thread panel's `use-read-thread.ts`, and their tests. No schema or stored value depends on it.

### D-148. An open tab in the background tells its person: a notice, a dot on its icon

**Context.** With Purlay open in a tab that is not in front — another tab, another window — the only
sign that something needed the person was `(N)` in the title (D-106, #491), which a pinned tab does not
show and anybody can miss. Web Push (D-126) reaches a closed tab, but D-143 holds a push while the
person's page is open, and it needs the operator's keys: an open tab in the background was told nothing.
Slack's loop is a banner, a badge and a sound.

**Decision.**
1. **What interrupts is what the badge already counts — nothing is classified twice.** A conversation's
   `unreadMentionCount` going up while the page is open is a new thing that needs the person (`NEEDS_YOU`:
   a mention, a direct message, an answer in a thread they are part of, a channel at `all`). A
   resolution is told in the inbox and not counted (D-106 §2), so it does not interrupt either; the
   person's own messages never move their badge. `NEEDS_YOU` moved to `@purlay/types`, one list for the
   server's send, read and delete and for the client.
2. **A notice from the page itself**, through the browser's `Notification` — no worker, no server key —
   only while the page is hidden or not focused, never in Deep Work, never on the first look at a list
   (what was waiting when the page opened is not news). **Who and where, never what** (D-126 §2): the
   title is the place (`#api`, the person, a group's people), the body the inbox's own words for why,
   read from the inbox's newest page; a click focuses the window and opens what the inbox row would —
   the thread for a reply. Unread, it says only where.
3. **Coalesced, not a storm.** One tag per conversation, so its next notice replaces its last; several
   conversations rising at once (a reconnect, a busy minute) are one notice, "3 conversations need you",
   opening the inbox. A conversation read elsewhere takes its notice back.
4. **One switch.** "Notifications on this device" (D-126) now covers both: offered wherever the browser
   has notifications, it asks the browser once, and where the browser has push and the server has keys
   it also subscribes. It is on while the person who turned it on is signed in here and the browser still
   allows it; a permission taken back turns it off on the next load. The page never asks on load.
   **Amended 2026-10-28 (#796):** while on, a device test requests a browser notice, reporting only
   that the browser accepted it, with permission/device-settings guidance on refusal. The test checks
   permission again; a revocation turns the switch off before any request. It creates no message,
   requires no new endpoint, and changes no channel preference. Both the feed and an open thread
   count as read only while the page is visible **and its window is focused**; blur/focus are observed
   alongside visibility, so an unread notice is not cleared while the person is in another window.
5. **A dot on the favicon, and the app's badge.** While the title counts, the tab's icon is
   `favicon-waiting.svg`: the favicon with a dot in `danger`, ringed in `on-accent`, bound to the
   tokens by `favicon.test.ts` as the favicon is; and an installed app's icon carries the count
   (`navigator.setAppBadge`, optional by its type where Firefox lacks it). Zero, or Deep Work, puts
   both back.
6. **No sound.** The operating system already sounds a notice by the person's own settings; a second,
   product-made one would double it, and quiet is the product (D-12).
7. **Small and late.** What tells is loaded the first time there is something to tell; the
   always-loaded part is the comparison of two lists of numbers and the swap of an icon.

**Rejected.**
- *Reading each `MESSAGE_CREATED` for mentions, direct messages and thread membership* — a second
  definition of "needs you" beside `NEEDS_YOU`, which D-106's amendment already refused for the title.
- *Pushing to the open tab* (lifting D-143's hold for a hidden page) — it needs the operator's keys and
  a worker, and costs a round trip through a push service for what the page already heard on its socket.
- *A second switch for the open tab* — one browser permission, two controls that can disagree.
- *Drawing the dot on a canvas from the linked favicon* — tried first: the picture is a `data:`
  address, which the page's `img-src` refuses (D-39), as the browser suite showed. Loosening the
  policy for a dot is the wrong trade; a second same-origin file costs four hundred bytes.
- *A dot in the accent* — the favicon is filled with it, and the dot would vanish.
- *A count drawn on the favicon* — illegible at sixteen pixels; the title says the number.
- *A sound, on or off by default* — above; and off by default it is a setting nobody finds.

**Accepted.** Chrome on Android refuses a page's `Notification` (only a worker may); there the page in
the background is not running anyway, and push is what tells a phone. A tab tells only of its own
workspace: the socket watches that workspace's channels.

**Cost of reversing:** `features/alerts`, `features/push/notifier.ts`, the shared switch in `push.tsx`,
two catalogue lines; no migration, no endpoint.

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

### D-150. A message's actions: one bar, in the empty corner of its own row

**Amends D-119 §6 and `UX.md` §3.** The owner's audit of the message row (2026-10-19): the bar hung
above the bubble (`-top-8`, #653) and covered the author's name and the last line or reaction of the
row above; a focused row and a hovered row each drew a bar; React and Reply had no tooltip, Save and
Pin only a slow native one; only one's own message had More; nothing said who reacted; the quick
reactions were a seven-line text menu that opened over the composer; "edited" and "Pinned" ran
together; on a phone Reply stood taller than the rest.

**Decided.**

1. **The bar sits on its own row's top edge, in the corner the message is not in** — the right for
   everyone else's, the left for your own — the way Slack and Linear put it top-right, mirrored for
   the second edge D-119 drew. *Amended 2026-10-26 by D-187:* there is one edge now, so it is the right for every message. It starts at the row's top and never reaches above it, so nothing of
   another message is ever under it, on any window; a message under a name has a band above its
   bubble and the bar stays inside it. A *grouped* message has no band: there a wide bubble's first
   line may lose its corner to its own bar while that row is the one. Accepted: the alternatives
   cover another message (a bar hung into the row above) or move the row (a band opened on hover).
2. **One bar on the page.** Which row shows it is one fact for the document
   (`features/messages/active-row.ts`), read by every row in the feed and the thread panel: the row
   under the pointer, or the focused row while the keyboard is the last thing used; a row whose menu
   is open keeps it; on a phone, the row tapped. A row reads only whether it is the one, so a move
   re-renders two rows.
3. **Its controls are one square, on every window** (`IconButton` size `bar`, `h-control`): React ·
   Reply · Save · Pin · More, each with the product's tooltip and its key where it has one (Reply `R`;
   Edit `E` in More). A finger-tall (`size-touch`) control made the bar taller than the band and it
   covered the name on a phone; 28px is above the 24px WCAG 2.5.8 minimum, and the menus a control
   opens keep their finger-tall items. The bar is the float surface: `surface-100`, a hairline,
   `shadow-float`.
4. **More is on every message.** Copy text (the words as written, through the content ports' clipboard),
   Save and Pin again for whoever looks there, then Edit and Delete on one's own. An owner or an admin
   gets Delete on anybody's — the API already allows it and puts it on the audit trail (D-103 §7,
   D-26) — and the question before it says so. **Copy link** is first in More, the message's own address (D-149): the two were built side by side and met at that one item.
5. **A reaction chip says who** in its tooltip: "You, Alice and Bob reacted with 👍", the person first
   as You, past three two names and "N others" — names from the workspace's members as the screen
   already read them, joined by `Intl.ListFormat` in the interface's language.
6. **The quick reactions are one row of tiles** (`MenuTiles`, `MenuTile`: checkbox items, so one
   already yours says so in `aria-checked` and not only by its tint; ←/→ move along the row), the
   name of the tile reached written under it. Still the seven: `UX.md` §10 allows a recent/frequent
   row, which needs a record of use the client does not keep, and seven is what fits one row on a
   phone. The picker and More open upward and are held inside the message list
   (`data-message-list`, Radix's collision boundary), so neither covers the composer.
7. **Edited and Pinned are one line under the words**, `gap-3` apart, not drawn when neither applies.

**Rejected.**

- *The bar hung above the row*, as #653 had it and Slack does: it covers the row above whenever that
  row's content reaches the corner — always true of your own messages, which sit on the right.
- *Top-right for every row*, your own included: your own bubble *is* the top-right corner, so the bar
  covered its time or its words; the left corner of your own row is the one that is always empty.
- *Each row deciding for itself* with `:hover` and `:focus-within`: that is how two bars were drawn.
- *A full emoji picker*: `UX.md` §10.

**Cost of reversing:** `message-actions.tsx`, `active-row.ts`, the tiles in `ui/menu.tsx`, the `bar`
size, and the chip's tooltip; no contract, route or stored fact depends on any of it.

### D-151. Controls are 32px tall

**Context.** `size-control` was 28px — every button, tab, select and text field — under UX §1's
density rule ("controls at this height, no larger"). D-118 §6 had already moved density from how
tightly things are set to what is shown. Looking at the running product on 2026-10-19 the owner called
the menus and screens cramped; a 28px field beside a two-line label in a settings row reads as an
afterthought, and a 28px button is a small pointer target for the actions people take most.

**Decided.** `size-control` is **32px** — Linear's height for buttons and fields. Below the narrow
breakpoint `size-touch` (44px) still applies. Sidebar rows stay `size-row` (32px), so a control and a
row are now one height, and the header (48px) keeps its 8px of air above and below a control.

**Rejected.** *36px or more* (Slack's fields): the composer's toolbar and the header would grow for
little gain, and density in a chat product is still worth something. *Bigger only in Settings*: two
heights for one kind of control is the drift a token exists to stop.

**Amends** UX §1's density rule and D-118 §6's wording. **Cost of reversing:** one token.

### D-152. Anybody may leave a workspace

**Context.** A member could be removed by an owner or an admin, but could not leave: no endpoint, no
door. Somebody invited into the wrong workspace, or done with a team, had to ask an admin to take them
out — and the last owner, who must not leave a workspace with nobody to run it (I-2), had no rule
written for leaving at all. Found by the settings audit (2026-10-19).

**Decided.**

1. `DELETE /api/workspaces/:workspaceId/membership` — the caller leaves the workspace and every channel
   in it, by the same going as a removal (`takeOut` in `members.ts`), and their own sockets are told
   `ACCESS_REVOKED` for every channel they could see.
2. **Anybody's.** A member, an admin or an owner — except the **last** owner, who is `409 LAST_OWNER`
   and told to make somebody else an owner first. The role is read under the workspace's lock, as every
   change to members is, so two owners leaving at once cannot leave none.
3. **Recorded as `member.left`**, the person as both actor and target — the trail says who went of
   their own accord, apart from who was removed.
4. **Leaving is not being removed.** A link that was open before they left still lets them back in: the
   check that keeps a *removed* person out reads `member.removed` only (`invitations.ts`), because a
   removal is somebody else's decision and leaving was theirs.

**Rejected.** *`DELETE …/members/:userId` with one's own id* — that endpoint is an admin's and refuses
one's own row on purpose (nobody changes their own role there); one path with two sets of rules is the
confusion `members.ts` avoids. *Letting the last owner leave and deleting the workspace* — deleting a
workspace is unbuilt (D-124 ①) and is not something to do as a side effect of a person leaving.

**Cost of reversing:** one endpoint, its case in the cross-tenant table, an audit action, and a row
on Sessions & account.

### D-153. The inbox is for triage: an unread view, days, and reading without going

**Context.** The inbox was one flat list, hung from the left at 760px with half the window empty, with
"Mark all read" and "Load more" and nothing else: no way to see only what waits, nothing to tell this
morning from last week, and a row could only be read by opening it. The notifications audit
(2026-10-19) compared it with Slack's Activity and Linear's inbox.

**Decided.**

1. **All and Unread.** Unread is `GET /api/notifications?unreadOnly=true` (D-106 already serves it),
   kept under the same cache prefix as All (`['notifications', workspaceId, 'unread']`), so every
   refresh the inbox already hears refreshes both.
2. **A row read stays where it is.** Marked read in the Unread view, it turns muted and stays until the
   person looks again; dropping it at once would move the next row under the pointer that was aiming at
   it.
3. **Today and Earlier**, by the person's own day, each a card — the column centred like the feed's
   (D-119), not hung from the left.
4. **Mark read on the row**, beside its button rather than inside it, so each is its own control for a
   keyboard and a screen reader.

**Rejected.** *Filtering the loaded pages in the client* — an unread row older than what is loaded would
not be found, and "Load more" could add pages that show nothing. *Grouping by thread* — the row carries
the reply, not its root, so a group could not name what it groups without another read per row; left
for when the contract carries the root's first line. *(Lifted 2026-10-19 by D-162: it now does.)* *Archive and snooze* — PRD §6 refuses reminders,
and an archive is a second "read".

**Cost of reversing:** the filter control, the sections and the per-row button in `inbox-screen.tsx`.

### D-154. A channel's details are a wide dialog with tabs, not one long column

**Context.** D-123's details were one 480px dialog holding everything: the name and topic, the
members with Add people, the notification level drawn only as a bell that did not say the level, an
owner's whole GitHub connect form (D-134), and Leave and Archive at the foot. At 900px it was 886px
tall and 1063px on a phone, the form most people never use dominated it, and the two acts that cost
something were below the fold.

**Decided.**

1. **The dialog stays, wider, with tabs** — **About**, **Members**, **Integrations** — as Slack's and
   Linear's channel settings are. A new width, `size-dialog-lg` (640px), is the `Dialog`'s `wide`
   size; below the narrow width (900px) a wide dialog is a sheet that fills the screen, since a
   phone has no room for a card's margins around a whole surface. The 480px dialog is unchanged.
2. **About** holds the name and topic, the **notification level as three radios that say the current
   level in words** (the same choosing as the header's menu, `useChooseLevel`, painted first and put
   back on a refusal), and at its foot a **Danger zone** — a box in the danger tone, one row per act
   saying what it costs, each asking in place as before. **Members** has its count in the tab, Add
   people beside the heading, and a field to find a member by name once there are more than eight —
   folded as everywhere else names are matched (case, accents, the dotless ı). **Integrations** is
   the repositories (D-134), and is **absent** for anybody who is not an owner or an admin, rather
   than an empty or refused tab.
3. **Tabs are WAI-ARIA's, hand-built**: Radix Tabs is not a dependency and one surface does not earn
   one (CONTRIBUTING §1.12). One tab is in the Tab order, ← → move and choose (wrapping), Home and
   End go to the ends. Every panel stays mounted and only the chosen one is shown, so a half-typed
   name survives a look at Members. The dialog still opens on itself, never on the name (D-123).

**Rejected.** *The right-hand side panel* (where the thread, files and pins open): it is for what is
read beside the conversation, one at a time, and opening details there would close an open thread;
renaming, leaving and connecting a repository are acts done and finished, which is a dialog's job.
*Sections in one scrolling column, only wider*: the GitHub form still dominates and Leave and Archive
still sit below the fold. *Keeping the bell in the details*: it is the header's compact control; in
the details there is room to say the level.

**Cost of reversing:** one component's layout, a `Dialog` size and a token; no contract changes.

### D-155. Who may make a workspace: the operator names them — #633

*Amended 2026-10-21 by D-179:* `WORKSPACE_CREATORS` is a server setting, imported once from the environment
at the first start and changed in the browser after; the rule below is unchanged.

**Context.** Signing in is open — an invited person has to be able to — and making a workspace asked
only for a session, so on an instance reachable from the internet anybody with a GitHub account could
sign in and make any number of workspaces, each with its own attachment quota (D-109 §5): disk without
a bound, for a stranger who found the address. Joining a workspace was already closed (an invitation,
D-115); making one was not. Decided in the owner's standing instruction to decide and proceed, and open
to their reversal.

**Decided.**

1. **The operator names who may: `WORKSPACE_CREATORS`** (`CONFIG.md`), GitHub logins, comma-separated
   and compared in any case, or `*` for anybody signed in — what a cloud or a demo wants. A login
   matches the username of an account signed in with GitHub, which is the login as GitHub last gave
   it; an account made by an email link (D-138) has no login, whatever its username spells, because
   its name came from an address anybody can own. A malformed value refuses to start. *Amended by
   D-169:* matched against the login itself, kept in a column of its own — a username is not one.
2. **Unset, nobody may but the first person to sign in, and only while the instance has no
   workspace** — the earliest living account, while `workspaces` is empty. The one-command install
   (D-144) still ends with its operator owning the first workspace, and a stranger who signs in after
   them cannot make a second. Two first workspaces asked for at once take turns on a lock, so only one
   is first.
3. **One check, in the transaction that makes the workspace** (`modules/workspaces/creators.ts`).
   Refused, it is `403 FORBIDDEN` — the endpoint is no resource of anybody's to hide — and nothing is
   made. Signing in is untouched.
4. **The client asks before it offers.** `GET /api/me` carries `mayCreateWorkspace`; a person with no
   workspace who may not is told to ask for an invitation, with no form, and the workspace menu's
   **Create workspace…** (D-124 §8) is offered only where it would be accepted. A refusal anyway — the
   first workspace made a moment ago — says the same above the form's button.
5. **Recorded as the create already is.** The audit trail is a workspace's (D-26), and a refusal has
   none to belong to; the request log carries the `403` and its code, as it does for every refusal.

**Rejected.** *An allowlist of who may sign in* (#633's option 2) — it closes the door earlier, but every
invitation would then need the operator to add the person too. *Leaving it open and bounding the
instance's storage instead* (option 3) — it bounds the disk, not the stranger's workspaces or what they
put in them. *Matching every account's username* — an email link would let anybody take an allowlisted
login that has not signed in yet. *The first workspace for whoever asks first* — the person who signed
in first is the one the install is for.

**Cost of reversing:** the variable, `creators.ts`, the field on `/api/me` (a client older than it reads
it as absent and offers the form, as before) and the screen; no migration.

### D-156. Writing in a channel is a member's — #690

**Context.** The client gives a person who has not joined a public channel no composer — a bar that
says they are reading without being a member, and **Join** — but the API checked only that the channel
was visible to them (ARCHITECTURE §7.5), and every member of the workspace can see a public channel. A
script signed in as somebody outside `#design` posted to it, every message `201`; the channel's members
were notified by a person its member list does not show, and the writer had no read position, no
unread place for a reply, nothing in their sidebar. The spec said nothing either way. Decided in the
owner's standing instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **Writing requires membership** — Slack's `not_in_channel`. Sending a message or a thread reply to
   a channel the caller can see and is not in is `403 NOT_A_CHANNEL_MEMBER`, over HTTP and the socket's
   `MESSAGE_SEND` alike, since both are `sendMessage`; nothing is written and nobody is told. Seeing
   stays as it was: reading, searching and the thread panel are anybody's who can see the channel.
2. **One code for every write of a visible non-member**, from the one guard (`requireChannelMember`):
   adding a reaction, editing one's own message, resolving or reopening a thread — each changes what the
   members see, and a reaction or an edit can tell somebody — and what was already a member's (D-104,
   D-123, D-130, D-137): pins, the incident, the channel's name and topic, bringing people in. Those
   were `403 FORBIDDEN`; they keep the status and gain the code, so a client can say *join to do this*
   rather than *not allowed*. A direct message is unchanged: who is in it is fixed, and its refusals say
   so as before.
3. **Taking one's own back is not writing**: deleting one's own message (or an earlier version of it),
   taking back one's own reaction, and saving for oneself stay open to somebody who has left. A
   moderator's delete is an owner's or an admin's, as it was (D-103 §7).
4. **The client already behaves this way** (the bar and **Join**); what it gains is the reason. A send
   in flight that meets the refusal is `failed` with *you are not in this channel; join it to write
   here*, and Retry sends it again (UX §3.1); every other surface says the same through the shared
   failure table, which the compiler holds to every code.
5. **A read, not a lock.** The guard reads the membership row. A send locks the channel's memberships
   in one order after its own row is written (#668), and a purge or a delete takes them all first; a
   lock taken before either would be a second order beside theirs, and the deadlock #668 and #669
   removed. So a leave in the same instant as a write can let that one write land — from somebody who
   was in the channel when it was checked.

**Rejected.** *Writing joins* (#690's option 2) — a message would quietly change who is in the
channel, and the member list and its notifications would follow from a side effect. *Keeping it as it
was* (option 3) — a member list that does not include the people writing is the surprise an admin of a
regulated workspace (audit, export, erasure by member) does not expect. *A second code only for sends,
`FORBIDDEN` for the rest* — two answers to one condition. *Holding the membership row `FOR KEY SHARE`*
— see 5: it deadlocked against the retention purge in its own race test.

**Cost of reversing:** the guard's calls in `sendMessage`, `reviseMessage`, `setReaction` and
`setResolved`, and the code — back to `FORBIDDEN` for the rest; no migration.

### D-157. The palette finds every place, and a query never ends in nothing

**Context.** `PRD.md` §4.6 promises a palette over channels, DMs, people and settings, and UX §1.3 calls
it the primary navigation. The messaging audit (2026-10-19) found it a channel switcher: "inbox",
"saved", "search", a public channel not joined, a group conversation — none were found, and a query
that matched nothing ended in "No match".

**Decided.** The palette lists the rail's places (Open questions, Inbox, Saved, Search) as views;
public channels the person has not joined, with *Not joined* beside them (opening one shows its Join
bar); group conversations by their people (D-127), found by any member's handle; every settings page
the person may open (D-146). Whatever was typed is also offered as **Search messages for “…”**, in a
group of its own that is always last, so arrows and Enter reach it in the order it is drawn; with no
other match the palette still says "No match" above it.

**Rejected.** *Actions that open dialogs (New channel, Invite)* — their dialogs are owned by the
components that draw their doors; a second door would need the state lifted for one shortcut.
*Keyboard shortcuts as an action* — the Settings page of that name is already listed; two rows with
one name is a guess for the person.

**Cost of reversing:** the items in `use-palette-items.ts` and the search row in `command-palette.tsx`.

### D-158. The list screens share one shape

**Context.** The inbox, the open questions, search and saved each drew their list their own way — hung
from the left at the feed's width with half the window empty, rows as floating rounded hovers, saved
items with two or three buttons under every row. After the inbox became cards (D-153), the other three
read as a different product.

**Decided.** One shape, in `ui/list-column.tsx`: a centred column at the feed's width (D-119) on the
ground a step below its cards; each list a card of rows divided by hairlines, with its heading (a day, a
channel) above it; a row is one button, padded alike. A row's own actions (Mark read, a saved item's
moves) sit beside its button, appearing over the row's meta line in its hover tone on a pointer's hover
or a keyboard's focus, and stay below the words on a phone. Search's field and *where* sit in a card of
their own above the results.

**Rejected.** *Leaving each screen its own layout* — four answers to one question is the drift a shared
primitive exists to stop. *Always-visible row buttons on a wide window* — three buttons under every
saved item made the list a toolbar.

**Cost of reversing:** the primitive and its four uses.

### D-159. A picture opens in a viewer; a refused upload says why

**Amends D-109 §6 and D-129, and `UX.md` §2, §3 and §5.** The owner's audit of messaging (2026-10-19):
a click on an image left the app for the raw `/api/attachments/…` file in a new tab (F7), and a failed
upload said only "Didn't upload · Retry", whatever had gone wrong (F8).

**Decided.**

1. **An image opens the image viewer**, from the feed and from the Files panel alike: the picture over
   the whole window, fitted to it — never cropped, never enlarged past its own size — with its name, who
   shared it, its size and when, **Download** and **Open original** (a new tab), and Close. Esc, the close
   button and a click beside the picture close it, and focus goes back to the thumbnail. It is a Radix
   dialog (focus moves in and stays in, the page behind is hidden from a screen reader); the viewer takes
   the first focus itself, and **Esc is the viewer's whatever is focused** — a control's tooltip does not
   take the first one (#623's trap, closed here at its source for this surface). The thumbnail stays a
   link to the image, so ⌘/Ctrl-click and the middle button still open a tab. Any other file still
   downloads.
2. **←/→ step through the pictures it was opened from** — a message's, or the Files panel's as far as the
   panel has read (no page is fetched for it: the panel's list is already the channel's newest-first
   index, and reading more is the panel's Load more). It stops at either end rather than wrapping, and the
   controls keep their place there, so the picture never moves under the pointer. Not the whole channel's
   pictures from the feed: the feed holds a window of fifty messages, so "the next picture" would depend
   on what happened to be loaded.
3. **On the navigation's tone** (D-118): the viewer is dark in both themes, so a picture is judged against
   the same ground whatever the theme and the chrome recedes. Not the `scrim`: the page behind showing
   through a picture is noise, and `UX.md` §1's rule against a modal that hides the conversation is about
   reading — a picture is opened on purpose and left with one key.
4. **The viewer is deferred**, with the settings, in one chunk: `apps/web/src/app/deferred.ts`, asked for
   with `import()` on the first open and on pointing at or focusing a thumbnail, so it is usually there by
   the click. *Measured:* with the viewer in a chunk of its own the bundler (rolldown under Vite 8) did not
   fold what two lazy chunks share with the entry back into it — it emitted a third, preloaded chunk of
   every module that reaches React — and the first page grew by 2.9 KB gzipped, 1.9 KB more than the
   viewer itself weighs. In one chunk with the settings it costs the first page nothing; the price is that
   the first picture opened also fetches the settings' code, once, ahead of the click. A later deferred
   feature joins that module rather than becoming a second `import()`. A viewer that does not arrive says
   so in a toast and nothing opens. *Amended by D-163:* the build now keeps every initial module in the
   entry, so a second lazy chunk no longer costs the first page; the rule of one deferred chunk stays,
   because the shell preloads it once when the browser is idle.
5. **A refused upload says why, in words, from its code**, under the file's name in the chip: too large
   (with the limit), an image past the side or pixel bound (with them), an image that does not decode, a
   type refused, the workspace's storage full (with **the room left**), too many files waiting, no
   connection, the server busy, file storage unavailable, the session ended. Anything else is "Didn't
   upload". The mapping is a switch over every code, so a new one is a compile error until it is placed.
   **Retry is offered where trying the same bytes again can be answered differently**, and not for too
   large, an image past the bounds, one that does not decode, or a type refused — there the one control is
   Remove, which every chip keeps.
6. **`STORAGE_QUOTA_EXCEEDED` carries `details.remainingBytes`**: what the quota leaves after what is
   stored and what is waiting to be sent, never below zero. It is the workspace's own number, told to a
   member of it who is uploading into it; it is at most the size of the file refused, so it says nothing
   about the quota beyond "not this file". Optional in the contract, as `LAST_OWNER`'s details are, so a
   client reading an older server says "Workspace storage is full" without the room.

**Rejected.**

- *A lightbox library*: D-52's bar for a dependency; Radix's dialog already is the hard part.
- *Zoom and pan*: Open original is one click away, at the browser's own zoom; a viewer that zooms has to
  own touch gestures, and that is a feature of its own.
- *Swipe between pictures on a phone*: the same; the arrows are touch-sized there.
- *Retry on every refusal*: a button that can only fail again teaches people that it does nothing.

**Cost of reversing:** `messages/image-viewer.tsx`, `image-viewer-door.tsx`, `app/deferred.ts`, the
thumbnails' click in `attachments.tsx` and `files-panel.tsx`, the chip's words in `composer/uploads.tsx`;
the quota's `details` is an optional field nothing else reads.

### D-160. Channels stay where they are; conversations come forward

**Context.** The sidebar ordered channels by their last message, newest first. Every message moved a
row: a mention put #deploys on top while the person was reaching for the row that had been there, and
with no sound and no banner (D-12) the reshuffle was the loudest signal the product made. UX §1.4 says
content never moves under the reader; the sidebar did exactly that. Found by two audits (2026-10-19).

**Decided.** Joined channels are listed **by name**, as starred ones already were (D-132): a channel is a
place, and a place stays put. What is unread is said by the row's weight and its badge, where it is.
**People and group conversations stay newest first**: a conversation with someone is a correspondence,
and the one being had is the one to find. `Alt+↑/↓` steps through unread in the sidebar's order, so it
now walks channels alphabetically.

**Rejected.** *A setting for the order* (Slack's "Sort by activity / alphabetically") — a preference
for what should simply be right is a second thing to maintain and test; reopen it if the team asks.
*Activity order frozen while the pointer is over the sidebar* — the list still jumps the moment the
pointer leaves, and the next look finds everything elsewhere.

**Cost of reversing:** one sort in `ordering.ts`.

### D-161. A thread can be followed, and let go — amends D-29

**Context.** A notifications audit (B5) found no way out of a thread. Replying once made a person one
of the up to fifty earlier repliers every later reply tells (D-29, D-99 §2): a drive-by "+1" in a long
incident thread meant every reply after it, for good. The only exit was setting the whole channel to
*Nothing* (D-107), which silences everything else in it too. And the other way round, somebody who
wanted to watch a question they had not answered had no way in short of writing in it. Slack and
Linear both let a person follow and unfollow. Decided in the owner's standing instruction to decide
and proceed, and open to their reversal.

**Decided.**

1. **Follow is per person, per thread.** Without a choice, participation decides, as D-29 always has:
   the root's author and whoever has a live reply follow it, nobody else does. A choice, either way, is
   a `thread_follows` row (`SCHEMA.md` §7.7), and it stands until the person makes another.
2. **Replying after letting a thread go does not follow it again.** Slack re-follows on reply; here
   the one thing the person said about this thread was *stop*, and a reply — often the last word,
   "thanks", "shipped" — is not a request to be interrupted again. Quiet is the product (D-12): of the
   two mistakes, the one that is noisy behind the person's back is the worse, because they cannot see
   it happen; the quiet one shows on the panel's toggle, one press from undone.
3. **What a choice moves is only the thread's own reasons to tell somebody.** Let go: no
   `thread_reply`, and no `channel_message` for a reply in that thread at level `all` — the thread is
   more specific than the channel. Followed: `thread_reply` for each reply, under the same conditions
   as a participant (can still see the channel, D-34; the 50 most recent followers by choice, beside
   the 50 most recent repliers, the bound D-99 §2 puts on what one reply writes). A person who let it
   go does not take a replier's place under that bound. **A mention still arrives**, and a direct
   message is still told: both are addressed to the person, not to the thread. A channel at `none`
   stays silent for a thread followed (D-107 §1: nothing at all). Deep Work, the counters, `NEEDS_YOU`
   and D-147's reading are unchanged; not retroactive.
4. **`GET` and `PUT /api/messages/:messageId/follow`** (`ThreadFollow`, `SetThreadFollowRequest`).
   Anybody who can see the root may — a member of the channel or not: it is the person's own, as a
   save is (D-156 §3); a reply has no thread, `404` as `GET …/thread` answers. Idempotent; told to
   nobody, and not yet to the caller's other devices, which read it when they open the thread (as
   D-107 left the level).
5. **Its own endpoint, not a field on the thread's page.** `ThreadPage` is a page of messages the
   socket writes into for everyone in the room; a per-person fact on it would need one page to be the
   one that says it, and a reply arriving would have to know which. The panel reads it beside the
   replies, under its own key, and reads it again when the person's own reply lands — answering a
   thread one had made no choice about follows it.
6. **The control** is in the thread panel's header (`UX.md` §4.2): **Follow**, a toggle with one name,
   its tooltip in Slack's words. Not in a root's More menu: the feed's messages do not carry the state,
   so the menu would have to ask for it on every opening; the panel is where the thread is.

**Rejected.** *Re-follow on reply* (Slack) — see 2. *A `mute` state only, no explicit follow* — the
person who wants to watch a question without writing "+1" in it is the other half of the audit's
finding. *Muting the thread in the inbox too, so its old notifications vanish* — what was told stays
told (D-107 §3); the badge comes down by reading. *Following everything one can see by default* — the
broadcast D-12 exists to prevent.

**Accepted.** The panel says *following* for a replier older than the 50 most recent, whom a reply does
not tell (D-99 §2's bound); the state is the person's relation to the thread, the bound is what one
reply writes.

**Cost of reversing:** `thread_follows` (migration `0044`), `modules/messages/follow.ts`, the choices
read in `delivery.ts`, the two routes and their contract, the panel's `follow-toggle.tsx`, and their
tests.

### D-162. One busy thread is one row in the inbox, named by its root — lifts D-153's *Rejected*

**Context.** The notifications audit (B4, C6) found one busy thread turning the inbox into
"Alice Chen replied in your thread · api" six times over, none of which said *which* thread — and every
reply said "your thread", even to somebody who had only answered in it. D-153 refused grouping by
thread because a notification carried the reply and not its root, so a group could not name what it
gathered without a read per row.

**Decided.**

1. **The contract carries the root in brief.** A reply's `Notification` has
   `thread: { rootId, excerpt, authorId }` (`NotificationThread`), null for anything that is not a
   reply. `excerpt` is the root's text as every excerpt is (#651) — plain, on one line — cut to
   `THREAD_EXCERPT_MAX` (120) characters with an ellipsis, and null when the root is deleted (D-9: its
   words are not shown anywhere) or says nothing in words. It is read by joining the root into the
   inbox's own statement: a page costs the same whatever threads it names, and the root is in the
   reply's channel, so the visibility the inbox already applies (D-106 §2) is the root's.
2. **Whose thread.** `authorId === me` is *replied in your thread*; anything else is *replied in a
   thread you're in* (D-29 tells both). The inbox, a background tab's notice (D-148) and a push
   (D-126) say it alike; a push reads the root's author in its own statement.
3. **One thread's replies of one day are one row** (`features/inbox/group.ts`). Only `thread_reply` is
   gathered — a mention, a direct message or a resolution is about the person and stands alone, even
   in a thread. The row sits where its newest member sat, so nothing above it moves; it says how many
   (*3 new replies in “…”*, without *new* once all are read), the newest replier's avatar, who
   (*Alice, Bob and 1 other*), the newest time and words, and is unread while any member is. Opening
   it or its Mark read reads every member that waits, by id. A single reply names its thread too:
   *In “…”* above its words.

**Rejected.** *Gathering across days* — a row in Today would carry yesterday's replies under today's
time, and Earlier would hold one row spanning a week. *Gathering mentions in a thread with its
replies* — a mention is the one notification that is about the person by name; folding it under
"3 new replies" hides it. *Fetching roots in the client* — a read per thread, which is exactly the
N+1 D-153 refused; or the whole root as a `Message`, which ships what a row never draws. *Counting
only the unread members* in the headline — "1 new reply" over three names would contradict itself.

**Cost of reversing:** the `thread` field and `NotificationThread`, the join in `inboxOf`, the
root's author in the push sender's statement, `group.ts`, the row's thread line, and their tests.
No schema or stored value depends on it.

### D-163. The first page is one file, and what is opened on purpose comes when the browser is idle — amends D-159 §4

**Context.** The initial JavaScript stood at 246.72 KB gzipped of the 250 KB budget (D-49), so the
next feature would not have fitted. Measured from the build with its source map, the 246.72 KB were
six files: the entry, and five chunks the bundler (rolldown under Vite 8) cut from it because the lazy
chunks share modules with it — every one preloaded by `index.html`, so all of it was downloaded
anyway. The one called `es2015` was the markdown engine and Radix's dialog machinery, named after
`react-remove-scroll`'s `dist/es2015` folder; nothing in it was a dependency loaded by mistake.

**Decided.**

1. **Every module the first page needs is in the entry** — one file. A `codeSplitting` group in
   `vite.config.ts` takes every module the `$initial` tag marks, except the push worker's, which is an
   entry of its own and stays one file that imports nothing (D-126). *Measured:* the same modules in one
   file are 5.30 KB gzipped smaller than in six (246.72 → 241.42 KB): one compression dictionary instead
   of six, and no import and export lists between them. It changes nothing a person sees; the lazy
   chunks are still lazy.
2. **What a person opens on purpose joins the deferred chunk** (`app/deferred.ts`): the command
   palette, the shortcut reference, New channel, Browse channels, Invite people, New message, a group's
   details and Add people. *Measured:* a further 5.38 KB (241.42 → 236.04 KB) — 10.68 KB in all.
3. **Nothing visibly waits, because the chunk is fetched when the browser is idle.** Once the
   signed-in shell is drawn it asks for the chunk with `requestIdleCallback` (at most two seconds), or
   after two seconds where there is none (Safari) — `app/deferred-door.ts`. ⌘K has no pointer to
   preload on, so an idle preload is the only way to have the palette there by the time it is asked
   for; one fetch, after the first screen, covers every door. An overlay asked for before the chunk has
   arrived is drawn the moment it lands. A chunk that does not arrive says so in a toast and the
   overlay stays closed; the next request asks again.
4. **Before the chunk arrives an overlay is not mounted; after, it stays mounted** — open or closed,
   as it was in the first chunk, so it keeps its closing animation and its state. The data a closed
   dialog asked for (the invitations list) is asked for when the chunk lands, not with the first screen.
5. **D-159 §4's reason for one deferred chunk is gone, and the rule stays for a new one.** Two lazy
   chunks no longer push what they share with the entry into a third, preloaded chunk — §1 puts all of
   it in the entry. A second deferred chunk would be a second preload to remember, so a later deferred
   feature still joins `app/deferred.ts`.
6. **The shape is checked** with the number: `bun run budget:web` fails when the initial modules are
   in more than one file (a locale catalogue beside the entry is allowed, D-41) and when
   `push-worker.js` imports anything.

**Rejected.**

- *Deferring the markdown engine* (about 20 KB): every message on the first screen is drawn from it,
  so the feed would wait for it or be drawn twice.
- *Deferring Radix's menu, tooltip and dialog primitives*: the message actions, the tooltips and every
  menu are on the first screen, and a trigger drawn before its primitive would lose its ARIA until the
  chunk came.
- *Deferring the list screens* (the inbox, saved, search, open questions): a screen is reached by a
  link, and a link that waits for a chunk is a navigation that waits; the overlays came to enough.
- *Raising the budget*: D-49.

**Cost of reversing:** the group in `vite.config.ts` and its two checks in `scripts/budget-web.ts`;
`app/deferred-door.ts`, the exports added to `app/deferred.ts`, and the door at each overlay's place
(`global-keys.tsx`, `channel-list.tsx`, `conversation-list.tsx`, `people-list.tsx`,
`workspace-menu.tsx`, `channel-header.tsx`). No stored value depends on it.

### D-164. A thread's box has the channel's buttons; an upload refused for a workspace left says so

**Amends D-110 §8, D-159 §5, and `UX.md` §5.** The owner's audit of messaging (2026-10-19): in the thread
panel the composer had no buttons — no bold, code block, mention, and no way to attach a file but a paste
or a drop — while the channel's had all four. Nothing decided it: the reply box had been drawn as a
one-line field with the send button beside it when the card was introduced (#320), and the buttons were
added later only where there was room for them (#379). D-110 §8 says *the composer* has the three buttons;
a reply is a message like any other, and a file belongs in an answer as often as in a question.

**Decided.**

1. **The thread's box is the channel's box**: the words, the files under them, then one row of Bold, Code
   block, Mention and Attach, the length left, and Send. What it leaves out is what the panel's 380px
   (`size-thread`) has no room for or no use for: the key hints are not drawn — they stay the field's
   description, read by a screen reader — the send button is the square icon without the ↵ beside it,
   and who is typing stays the channel's (`UX.md` §5).
2. **An upload refused with `WORKSPACE_NOT_FOUND` says "You no longer have access to this workspace"**,
   with Remove and no Retry. The workspace answers somebody taken out of it, or a workspace that was
   deleted, as one that does not exist (404, never 403 — `CONTRIBUTING.md` §1.2), so the chip says the
   one thing true of both, and the same bytes would be refused the same way. It was "Didn't upload" with
   a Retry that could only fail again, which D-159's *Rejected* already refuses.

**Rejected.**

- *The buttons in a menu behind one "+"* — a click more for every file in a thread, and a control the
  channel's box does not have: two composers that look alike and work differently.
- *Hints wrapping onto a second row in the panel* — the box grows when it is focused, which moved what was
  under the pointer on a narrow window (#654); the panel is that narrow at every width.

**Cost of reversing:** the footer row's `compact` branches in `composer/composer.tsx`, one case in
`composer/uploads.tsx` and its two sentences; the tests and the two mutation entries that name them.

### D-165. A sidebar row has a context menu: the row's own actions, without opening it

**Context.** Everything a person could do to a channel from the sidebar meant opening it first: star
it in its header, set its level in the header's bell, leave it from its details' Danger zone, copy its
address from the browser's bar. Slack and Linear both answer a right click on a sidebar row with that
row's actions, and the owner asked for the same (2026-10-19). How it is built was decided under their
standing instruction to decide and proceed, and is open to their reversal.

**Decided.**

1. **What it holds is the row's, and only what applies and the person may do.** *Mark as read* while
   the row is unread; *Star* / *Unstar* for a channel (a conversation has none, D-132); the
   notification level as the header's three choices (D-107), one radio group, not a submenu; *Copy
   link*, the channel's whole address; *Channel details…* for a channel and *Conversation details…*
   for a group (a conversation of two has no details, `UX.md` §2); *Leave channel…* for a public or a
   private channel, never for a conversation, whose people never change (D-127). Each reuses what the
   header and the details already do — `useStar`, `useChooseLevel`, `actions.leaveChannel`, the same
   strings and the same refusal for the last member of a private channel — and calls only endpoints
   that already exist.
2. **Mark as read reads the feed, as reaching its bottom does.** `PUT …/read` with the channel's newest
   root, asked for by `GET …/messages?limit=1` because the cache's feed may not be loaded or current.
   A reply still waiting in a thread stays unread (D-147): the row is painted read at once and then
   shows what the server counted, which may be *still unread*, for that reason. Reading every waiting
   notification as well would make a press in the sidebar read answers nobody looked at — the failure
   D-147 exists to prevent.
3. **Leave asks first, in a dialog** (the menu has no room for the details' in-place question), says
   what leaving costs for a public and for a private channel, and says a refusal inside the dialog.
   Done, a toast says so; the person is taken to the workspace only when they left the channel they
   were reading.
4. **Opened the platform's three ways.** A right click opens it at the pointer; Shift+F10 or the
   ContextMenu key on a focused row opens it under the row (caught on `keydown`, so the menu does not
   land wherever a browser puts a keyboard's `contextmenu`); a finger held still for 500 ms opens it
   at the finger, and the tap that ends the press does not follow the link. Escape gives focus back
   to the row, and a dialog an item opened gives it back there too.
5. **The existing dropdown, anchored to a point** — `AnchoredMenu` in `ui/menu.tsx`, Radix's dropdown
   opened from an invisible box at the pointer or around the row, drawn on the page's body. Its items,
   keys, look and `min-w-sidebar` are the account menu's, because they are the same component.
6. **Its body is deferred** (`app/deferred.ts`, D-49): the door in every row costs the first page
   0.34 KB gzipped; drawn statically, the menu measured 1.87 KB, more than half the room the budget
   had left. The chunk is fetched when a pointer enters a row or the keyboard reaches one; a chunk that
   does not arrive is said in a toast and asked for again next time.

**Rejected.**

- *`@radix-ui/react-context-menu`.* It is the primitive for this, and it is one more runtime
  dependency (§1.12) for what the dropdown already does once it is anchored; its trigger must also
  wrap the row in the first page's code, so the menu could not be deferred.
- *The row itself as the dropdown's trigger.* A trigger opens on a press and on Enter, which are the
  link's; and every row would be announced as a menu button.
- *A More (`…`) button revealed on hover*, as Slack also draws. A control that appears only under a
  pointer is one a newcomer never finds, the reason the section headings' buttons are always shown
  (`UX.md` §2); the context menu is the desktop's convention and adds nothing to the row's look.
- *The level as a submenu.* A second primitive (`MenuSub`) for three choices that fit in the menu.

**Cost of reversing:** `features/sidebar/row-menu.tsx` and `row-menu-body.tsx`, `AnchoredMenu`, the
row's handlers, the export in `app/deferred.ts`, the strings and their tests. No contract, route or
stored fact depends on any of it.

### D-166. A search can be narrowed to who wrote it

**Context.** `PRD.md` §4.6 narrowed a search to a workspace and a channel. "What did Ayşe say about the
retry budget?" was answered by reading every result for her name. The owner asked for a *From* beside
*Where* (2026-10-19); how it is built was decided under their standing instruction to decide and
proceed, and is open to their reversal.

**Decided.**

1. **`senderId` on `GET …/search`, a filter on the visible set, never a way round it.** It narrows the
   channels the caller can see (D-105 §4) to one person's words, in the same query; it never widens
   them. An author's words in a private channel or a conversation the caller is not in stay unseen.
2. **A person who wrote nothing there is an empty page, not a 404.** `channelId` names a resource and
   is refused when it cannot be seen (D-105); `senderId` names nothing the caller is shown: a person of
   another workspace, one who left, and an id nobody has are answered alike, and what is answered comes
   only from the caller's own channels — so the empty page confirms nothing. Somebody who left is still
   found by what they wrote while they were here (D-152), which a 404 for a non-member would have lost.
3. **No new index.** `idx_messages_sender` already exists (0005). Measured on a million messages in
   twenty workspaces (2026-10-19, PostgreSQL 18.6): without `senderId` the plan is unchanged, a bitmap
   scan of `idx_messages_search_folded`; with it, for a person of five thousand messages, a `BitmapAnd`
   of `idx_messages_sender`, the workspace and the channels (13–21 ms); for a person who wrote all fifty
   thousand of a workspace's messages, the trigram index again (2 ms). No sequential scan in any.
4. **On the screen: *From*, beside *Where*, kept in the address as `?from=`** with the person's id, so
   Back and a shared link keep it as they keep `?q=` and `?in=`. *Anyone* first, then the person
   themself, then everybody by name, each with their avatar — the workspace's people the sidebar lists.
   Somebody the address names who is no longer listed is still searched for and shown as *Someone*.
   The palette's *Search messages for "…"* opens a search of the words alone (D-157).
5. **The menu's radio items, not the native select *Where* uses.** A native select cannot draw a face,
   and a face is how a person is found in a list of thirty; the menu is already on the first page (the
   account menu), so it costs no dependency and little weight, and its keys — arrows, typing a name,
   Escape — are a picker's. Typing reaches a name by its words, not by its avatar's letters.

**Rejected.**

- *`?from=` as a username.* The handle is display-only and follows a rename on GitHub (D-38), so a
  shared link would come to name somebody else or nobody; the id is what the API takes.
- *A 404 for a person who is not a member.* It would hide what a person who left wrote, and a 404 on a
  filter says nothing a 404 on the workspace does not already.
- *A combined `(workspace_id, sender_id)` index.* The planner reached a cheap plan with the indexes
  there are in every case measured; an index is paid on every send (D-10).

**Cost of reversing:** `senderId` in `SearchQuery`, the route's parameter list and one `where` in
`modules/search/search.ts`; `?from=`, `features/search/author-picker.tsx` and the strings on the web.

### D-167. Browse says what a channel is before it is joined; a group has a face

**Context.** Browse channels listed a name and, sometimes, a topic: nothing said whether a channel
was where the team talks or an abandoned experiment of one, and the only way to find out was to join
it. Slack and Linear both say how many people are in a channel before you join. In the sidebar, a
group conversation drew the first of its people's avatars, so a group of three looked like a direct
message with one of them. The owner asked for both (2026-10-19); how they are built was decided under
their standing instruction to decide and proceed, and is open to their reversal.

**Decided.**

1. **A channel carries `memberCount`**, for every channel the caller sees, joined or not: its live
   members, an erased account not among them — the number its members list holds, so the dialog and
   the details never disagree. It is read in the channel list's own statement, as one aggregate
   grouped by channel over the same ids the list is narrowed to (`readChannels`), joined in, never a
   count a channel; the list's statement count stays the same however many channels there are
   (the existing N+1 test). `EXPLAIN ANALYZE` over 2,000 channels and 100,000 memberships, sixty
   channels listed: one `HashAggregate` fed by a bitmap scan of `channel_members (channel_id,
   user_id)` with `channel_id = ANY(…)` as its index condition, 2.1 ms. The count is as of that read: another person's join is not pushed to
   everyone who might browse. A count a person reads in a dialog they opened is allowed to be a
   minute old; a frame to every member of a workspace for every join is not worth that minute.
2. **Each row of Browse** is the name, then one quiet line: *12 members*, and the topic after a dot,
   cut with an ellipsis before the count is. By name (D-160), as before.
3. **A field to find a channel appears past eight**, the threshold the channel details' members list
   already uses — now one constant, `FINDABLE_FROM` in `ui/text-field.tsx` — matching the name and the
   topic without case or marks (`fold`), and saying so when nothing matches. Closing the dialog forgets
   the search.
4. **A group's face is its first two people, the second overlapping the first, and "+N" for the
   rest**, in the order of its key — the order its name is written in, so the faces and the name
   agree. Each piece is one small avatar (`size-avatar-sm`) overlapping the last by 4px and showing
   one letter — two letters at 20px were half covered by the next face, seen live — so the row keeps
   its height; a group is
   at most ten people (D-127), so N is at most seven and is always one digit on a chip of the same
   size. An overlapping piece is cut out of the one behind it by a hairline in the colour of what it
   is drawn on — the sidebar's, following the row's hover; the accent on the row you are in; the
   page's in the header; the selected option's in the palette — so two people with the same tint are
   still two. The same face stands in the sidebar row, the palette's group row and the group's header,
   where a generic glyph stood. An erased person is *Deleted user* in the reader's language, in the
   face and in the name.

**Rejected.**

- *The count only for channels the caller has not joined.* A field that is sometimes absent is a
  second shape for every reader of the list; the aggregate costs the same either way.
- *Pushing counts on every join and leave.* See §1: a frame per membership change to every member of
  the workspace, for a number read in one dialog.
- *A count in the members list's endpoint, read when a row is shown.* A request per row is the N+1
  (D-13).
- *Slack's stacked square (two smaller avatars diagonally inside one)*: it needs an avatar smaller
  than `size-avatar-sm`, a new size token for one place, and the initials stop being legible.
- *A number in place of the faces* ("3"): it says how many but not who, which is what a face is for.

**Cost of reversing:** the column in `readChannels`, the field in `Channel` and its fixtures,
`features/conversations/group-face.tsx` and its three uses, the dialog's row and field, the strings
and their tests.

### D-168. A list of messages is one Tab stop; a row's own controls are reached from it

**Context.** The feed had one row in the Tab order (roving focus, `UX.md` §7) and its bar went inert
until its row was the one (D-150), but everything *inside* a message was still a stop: reaction chips,
the thread's line, a code block's Wrap and Copy and the block itself, a diff's view and its region,
links, files, GitHub cards. Measured in the demo channel (2026-10-19), Tab from the header's last
control walked **78 stops** inside eleven messages before reaching the composer — and never the
feed's own row — every row's bar joining in once focus had entered its content. The thread panel had no row in the Tab order at all,
and the root's chips and bar were reached directly. Slack's message list and the WAI-ARIA feed
pattern both make the list one stop. How it is built was decided under the owner's standing
instruction to decide and proceed, and is open to their reversal.

**Decided.**

1. **The list is one stop: its current row.** Tab from what is before the list lands on the row the
   keyboard was last on — or, untouched, the feed's newest and the panel's root — and ↑ ↓ Home End
   move between rows as before (`row-keys.ts`). The panel's list now has its own roving row, as the
   feed has.
2. **Tab from the focused row walks that row's controls, then leaves.** Only the row that holds focus
   has stops inside it, in the order they are drawn — its words' links, its code and diff blocks, its
   files and cards, its chips and thread line, then its bar — and after the last one Tab goes on to
   what follows the list (the composer, or in the panel Resolve and then the reply box). Shift+Tab
   from there comes back to the **row**, not to the last control passed: once focus leaves a row its
   controls are out again. Escape on a row still goes to the composer.
3. **Out of the Tab order means `tabindex="-1"` and nothing else** (`features/messages/row-stops.ts`).
   A row's controls are found by what makes an element a stop, whoever drew it; the `tabindex` each
   had is written down, and given back as it was when focus enters the row. What a component draws or
   changes while its row is out — highlighting, a reaction, a block unclamped — is taken out as it
   arrives, and a change its author makes in that time is what is given back. One row holds focus for
   the document, across the feed and the panel; the document's own focus events say which.
4. **Pointer, touch and screen readers lose nothing.** A control out of the Tab order is still
   clicked, tapped and focused by a script (a menu giving focus back, the image viewer giving it back
   to its thumbnail), and focusing it by any of those ways brings its row in. It stays in the
   accessibility tree with its name: browse mode reads every message's links and buttons and presses
   them, and a links list still holds them all. **Nothing is traded.**
5. **A scrolling block in a row that is out is reached through its row.** axe's
   `scrollable-region-focusable` audits the page as it stands and calls a code block, a diff or a
   table in any other row unreachable. The browser tests' audit (`e2e/fixtures.ts`) checks the path
   instead of excusing the rule: it focuses the block's row and drops the finding only when the block
   is then a stop; anything else stays a violation.

**Rejected.**

- *Enter or F2 into the row, Escape back out* (the grid pattern). It is one stop in a stricter sense,
  but a Tab user who does not know the key never reaches a row's link, the bar 8917edc made reachable
  by Tab would need the key too, and Escape already means "to the composer" on a row (`UX.md` §7).
- *`inert` on every other row's content*, as the bar has. It takes the words out of the accessibility
  tree — browse mode would read only the current message — and out of reach of the pointer.
- *Each control asking whether its row is current* (a context read by chips, links, code blocks…). A
  dozen components today and every new one tomorrow would have to remember it; the first to forget is
  back in the Tab order with nothing to say so.
- *Moving focus by hand on Tab* (a key handler that computes the next stop). It has to know the page's
  order outside the list, and Shift+Tab from the composer arrives before any handler of the list's runs.

**Cost of reversing:** `row-stops.ts` and its one call in `message-row.tsx`, the panel's roving row in
`thread.tsx`, and their tests. No contract, route or stored fact depends on any of it.

### D-169. `WORKSPACE_CREATORS` is matched against the GitHub login, kept in a column of its own — amends D-155 §1

**Context.** D-155 matched a listed login against the username of an account signed in with GitHub,
taking the username to be "the login as GitHub last gave it". It is not: a login another account
already holds here is stored with a `-N` (`availableUsername`), an email link names its account after
the address's local part (D-138), and a login shaped like an erased account's is given `user-` before
it (D-139 §5). A security review (2026-10-20) showed both directions: a stranger who signs in by email
as `alice@…` before GitHub's `alice` does makes her `alice-1`, and she is refused; a listed `bob-1`
lets in GitHub's `bob`, stored as `bob-1`. Decided under the owner's standing instruction to decide and
proceed, and open to their reversal.

**Decided.**

1. **`users.github_login`: the login as GitHub gave it at the latest sign-in** (migration 0045,
   `SCHEMA.md` §3.1). Written on every GitHub sign-in, as GitHub sent it — `TEXT`, never cut to the
   username's 39, since a cut login is another login. `NULL` for an account made by an email link —
   until it connects GitHub, which holds the login as a sign-in does (D-176).
2. **A sign-in takes its login from any other account that still holds it**, in any case. GitHub lets a
   login be given up and taken by somebody else; whoever signs in with it now is the one GitHub says it
   is, and an account renamed away keeps no claim until it signs in under its new one.
3. **`WORKSPACE_CREATORS` is compared with `github_login` alone** (`modules/workspaces/creators.ts`),
   in any case. The username plays no part.
4. **Existing accounts are filled where the username is the login unaltered** — a GitHub account whose
   username has no `-N` and no `user-` before it. Any other is `NULL` until its person next signs in:
   refused for a while rather than let in on a name that may be somebody else's.
5. **Personal, as `github_id` is.** Erasure clears it (I-11); an export omits it (D-140).

**Rejected.** *Not suffixing a GitHub login on collision, renaming the email account instead* — it
moves somebody's name under them and still leaves a username that only usually is a login. *Listing
GitHub ids instead of logins* — exact, but an operator knows logins, and the id is one GitHub API call
away for each, at configuration time. *A `UNIQUE` index on the login* — two sign-ins at once would each
take it from the other, and the loser's sign-in would fail; without it they share it a moment, which
only refuses neither more than it should. *Resolving the listed logins with GitHub at start-up* — a
network call to start, and still stale after a rename.

**Cost of reversing:** the column and its index (a migration dropping them), `holdLogin` in
`auth/identity.ts`, the one comparison in `creators.ts`, a line each in erasure and the export's
table.

### D-170. Decodes wait in a bounded line, and the image proxy holds at most one — amends D-109 §2

**Context.** At most two decodes ran at once per node (D-109 §2), but the line for them had no bound,
and the image proxy decoded after its fetch slot was released, so its own bound (four fetching,
sixteen waiting) did not cover decoding. A security review (2026-10-20) measured a 6300×6300 PNG of
128 KB taking about 287 ms to decode; two members at their costly-read budget (D-81) made an unrelated
small upload wait 17 s, and growing — one member could stall every upload on the node.

**Decided.**

1. **At most eight wait for a decode slot, per node.** At about 290 ms a decode at the pixel bound, the
   last of eight waits about a second and a quarter, as long as an upload should sit before it is told
   the server is busy. Past it a decode is refused at once, `429 RATE_LIMITED` — what the upload's own
   gate already answers, and what the composer says as "busy", with Retry. Never a 500.
2. **The proxy has a share of its own: one decode at a time, four waiting** — a round of its four
   fetches finishing together. Holding at most one of the node's two slots, a feed of pictures never
   keeps an upload waiting behind it; past its line, or the node's, the picture is not available now,
   the same `404 IMAGE_NOT_AVAILABLE` as any failure, with the reason in the log.
3. **Eight is above what today's callers can make wait at once** (four uploads per node, and the
   proxy's one), so the node's bound refuses only a caller that has lost its own gate.

Measured after (the review's own script, 2026-10-20): the same small upload decoded in 1 ms after ten
seconds of two members at budget.

**Rejected.** *Holding the proxy's fetch slot through its decode* — #110's review separated them on
purpose: a slow server would then hold a decode's turn as well, and the fetch line would wait for both.
*A longer node line* — a wait nobody sits through, and memory for every buffered image in it. *Ordering
uploads before proxy decodes in one line* — a priority queue to say what a share says with a second
`slots`.

**Cost of reversing:** two numbers in `attachments/images.ts`, the share in `images/proxy.ts`, and
their tests.
### D-171. A send waiting on its files is the place's, not the composer's; a reply box and a non-member are not heard typing

**Amends `UX.md` §5 and D-114.** An audit of main (2026-10-20) found two things the composer said it did and
did not. *Send while an upload is in flight* held the send and the files in the composer's own state, and
the composer is remounted on a channel switch (`<ChannelView key=…>`) and unmounted when a thread's panel
closes: the words came back as a draft, the files and the send did not — a person who pressed Send and
moved on believed something had gone that never would. And a thread's reply box announced typing to the
channel, so its members read "Alice is typing…" and nothing ever arrived in their feed; the server let
anybody who could *see* a public channel announce there, though only a member may send (D-156).

**Decided.**

1. **The files and the waiting send are held per place, above the composer** — keyed as the draft is (a
   channel, or one thread in it), for the life of the signed-in page (`features/composer/outbox.ts`, mounted
   in the shell below the engine). A channel switch, another screen of the workspace or a closed panel
   loses neither; going back shows the files with their state and *Sends when the files finish uploading*.
2. **While a composer for the place is on the screen, it sends; while none is, the outbox does**, the moment
   the last file lands: the words the box held when it went, with the files, to where they were written,
   and the draft is cleared as a send from the box clears it. The row then paints and reconciles like any
   other send (`CONTRIBUTING.md` §1.9).
3. **A file that fails while nobody is looking holds the send back, and says so at once** in a toast naming
   the place — *Not sent to api: a file did not upload. The message is still there.* — and it is: the words,
   the files and the reason, with Retry and Remove, when the person goes back. Nothing is sent without a
   file the person attached.
4. **A reply box does not announce typing.** `UX.md` §5 already said a reply composer shows nobody typing,
   because typing belongs to the channel; it now also says nothing to it. No thread-scoped indicator is
   specified, and none is built: a `TYPING` frame names a channel only.
5. **The server hears typing only from a channel member.** A visible non-member's announcement is dropped,
   answered with nothing as every announcement is, and takes no place in the registry.

**Rejected.**

- *Keep the composer mounted per channel, hidden.* Every channel visited would hold a live composer, its
  effects and its member list; and it does not cover a thread's panel, which is closed, not hidden.
- *Refuse to switch, or ask, while a send is waiting.* It turns a promise the composer made — send while it
  uploads — into a dialog the person did not ask for, at the moment they chose to move on.
- *Send what is ready and drop what failed.* A message that arrives without the file it was about says
  something other than what was written.
- *Survive a reload.* The files are in the page's memory; keeping them across a reload means writing blobs
  to the browser's storage, a client-side store D-7 refuses without a measurement. A reload still keeps the
  words (the draft).

**Cost of reversing:** `composer/outbox.ts`, its provider and hook in `composer/uploads.tsx`, the provider in
`shell.tsx` and the two test trees; one condition in `composer.tsx` and one in `realtime/router.ts`; their
tests and mutation entries. No contract or stored fact depends on any of it.
### D-172. Somebody can be taken out of a channel — amends D-104, D-123

**Context.** Only leaving existed (D-123); D-104 left *removing* for later. Somebody brought into a
private channel by mistake could only leave on their own, or be removed from the whole workspace
(D-111). An audit before a team's daily use found it, and the owner asked for it (2026-10-20). How it
is built was decided under their standing instruction to decide and proceed, and is open to their
reversal.

**Decided.**

1. **`DELETE /api/channels/:channelId/members/:userId`**, the path a person's membership has, beside
   `POST …/members` that brings them in. `204`, and the person is out of the channel; **their messages
   stay** (D-9), by their name.
2. **Who may.** An **owner or an admin**, from any channel they can see — a role is not a way round
   visibility, so a private channel they are not in is the stranger's `404` (D-34), as archiving is
   (D-123 §2). As for the workspace, **an owner is an owner's to take out** (D-111 §1): an admin is
   `403` for one. A **member of a private channel** takes out another member of it whose workspace
   role is `member`: whoever is in a private channel brings people in (D-104), so taking out somebody
   brought in by mistake is theirs too, and waiting for an admin would leave the mistake in the room.
   They do not take out an owner or an admin — those run the workspace, and a member removing them is
   a demotion by another door. **In a public channel a member takes out nobody** (`403`): anybody can
   join it again, so it would only be a quarrel with a button.
3. **Yourself is leaving.** Naming yourself is `POST …/leave` by another door — the same last-member
   refusal, the same `reason: "left"`, nothing on the trail. A refusal would teach a client a second way
   to say *leave* is wrong; a removal of oneself would put leaving on the audit trail.
4. **Never in a direct message or a group** (D-127): a conversation's people are its identity and
   never change. The stranger's `404 CHANNEL_NOT_FOUND`, as leaving and renaming answer one (D-123 §4).
5. **The last member of a private channel stays** (`409 LAST_CHANNEL_MEMBER`), the rule leaving keeps
   (D-123 §3): with nobody in it, nobody could reach it again. Somebody who removes must be able to
   see it, so they are in it and this is reached only by a race, but it is checked under the lock.
6. **The same discipline as a workspace's removal** (`modules/workspaces/members.ts`): the workspace
   row first (shared, so a role change waits and the roles read are the ones that hold at the commit,
   D-111 §2), then the person's membership, then the channel row (#669's order); the roles — the
   caller's too — are read inside the transaction. Somebody not in the workspace is
   `404 USER_NOT_FOUND`; somebody not in the channel is `204` again and tells nobody.
7. **Every open screen of theirs is told** (D-85): their sockets are sent `ACCESS_REVOKED` on their
   own topic with a new reason, **`removed`**, so a person reading the channel is told what happened
   — *You were removed from this channel* — rather than that it is not there. Their sidebar loses it at
   once; a public one comes back to their list as one not joined. What they are told about it stops
   with the membership: nothing from a private channel, and from a public one only what reaches anybody
   not in it — a mention of their name, a thread they follow (D-29, D-161).
8. **On the audit trail** as `channel.member_removed`, the person as its target and the channel by id
   only, so the audit page names it to a reader who can see it and says "a channel" to anybody else —
   the rule feeds' entries keep (#691).
9. **Offered in the channel's details** (D-154, *Members*), on each row the person may remove and not
   their own: Remove asks in the row first, as Settings → Members does, the row goes at once, and a
   refusal puts it back and says why. **Not in the sidebar's menu** (D-165): that menu is the person's
   own relationship to the channel, and taking somebody else out is not one.

**Rejected.** *Any member removes anybody, as D-104 lets any member add* — in a public channel it is a
quarrel nobody can settle, and in a private one it lets a member take out the people who run the
workspace. *Owners and admins only* — the people who bring somebody into a private channel are the ones
who notice the mistake. *Refusing to remove oneself* — a second answer for a request whose outcome is
exactly leaving. *Telling the rest of the channel* — nobody's screen depends on it; the members list is
read when it is opened.

**Cost of reversing:** `removeChannelMember` in `modules/channels/settings.ts`, its route, a reason in
the contract, a row on the audit page and the details' Remove; no table changes shape.

### D-173. A workspace's storage is shown to its owners; its quota stays the operator's

**Context.** D-16 caps uploads per workspace, and the cap is enforced (`modules/attachments/uploads.ts`)
— but nothing showed it: an owner learned of it when a file was refused, and only SQL changed it.
`CONFIG.md` said the quota "varies per workspace" and not how. Decided under the owner's standing
instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **Owners see it**: `GET /api/workspaces/:workspaceId/storage` answers `StorageUsage`, the bytes used
   and the quota, and Settings → Data & retention shows a meter with the numbers ("1.2 GB of 5 GB"),
   what is left, the warning tone from nine tenths and the danger tone with a sentence once it is full.
   An owner's, as retention and exports are: it is what the workspace costs the operator.
2. **One reading for both.** *Used* is the stored bytes and the uploads still waiting to be sent, the
   sum the upload check refuses by — the same function (`modules/attachments/quota.ts`) — so the meter
   never says there is room a refused upload then denies.
3. **The quota is the operator's**, not the owner's: it is their disk. It is set with
   `bun run storage:quota <slug> [<size>]` (`CONFIG.md`), whole bytes or binary units; a quota below
   what is used deletes nothing and refuses uploads until there is room. There is **no in-app control**.
4. **A change is on the trail** *(amended 2026-10-20)*: `storage.quota_changed`, `from` and `to` in
   bytes, written in the command's transaction with no actor — the operator is nobody in the workspace,
   as with the nightly purge (D-139 §3) — and said on the audit log in the reader's units. The same
   quota again writes nothing. An owner whose uploads start being refused can see when the cap moved,
   and to what, without asking the operator.

**Rejected.** *An owner raises their own quota* — the cap exists because self-hosters pay for the disk
(D-16); a control the person who does not pay can turn is not a cap. *An instance-wide default in an
environment variable* — the quota is per workspace, and a default is already the column's.
*A documented `UPDATE` instead of a command* — it takes no lock, so an upload in flight could pass
against the old quota, and a typo in bytes is silent; the command parses and locks.

**Cost of reversing:** a route, a card and a command; no table changes shape.

### D-174. A workspace starts with one channel, `general`, its creator in it — amends D-123 §5

**Context.** Making a workspace made the workspace and its owner's membership and nothing else
(`modules/workspaces/workspaces.ts`). The person who had just made it landed on *Pick a channel* with
nothing to pick, and the first person they invited before making one passed a welcome step that
offered nothing (D-132 §5) and landed on the same empty screen. The first five minutes of the product
were two empty states. Slack- and Linear-class products start a workspace with a place to talk.
Decided under the owner's standing instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **A new workspace starts with one public channel named `general`**, its creator in it
   (`DEFAULT_CHANNEL_NAME`, `packages/types`). Made in the transaction that makes the workspace, by the
   same `createChannel` a person's **New channel** runs, through the membership guard the creator has
   just passed: a workspace never exists without it, and it is a channel like any other from its first
   moment.
2. **On the trail as every channel made is**: `channel.created` by the creator (D-26), the first entry
   of every workspace's audit log.
3. **Named, not described.** A name is what the whole workspace finds a channel by (D-123 §1), and
   `general` is the one teams already know from every other chat product, Turkish-speaking ones
   included. **No topic:** the server would have to write it in one language, and the second person
   may read another. An owner who wants `genel` renames it.
4. **Nothing marks it afterwards.** No column, no flag: it is renamed, left and archived by D-123's rules,
   and a workspace whose people archive it is a workspace with no channel, as any other can become.
   D-123 §5's *there is no default channel* now reads: there is a first channel, and nothing protects it.
5. **An invitation still joins nothing** (D-115). The welcome step offers `general` with the rest of the
   public channels by D-132 §5's rules — silent, it is offered and not picked. Joining a channel is the
   person's choice; the step is where they make it.
6. **The creator lands in it.** The form goes to `/w/<slug>`, which opens the first channel the person
   is in (`workspace-home.tsx`): now `general`, never the welcome step, which is the invited person's.

**Rejected.**

- *A default channel joined by every invitation, Slack's `#general`.* It needs the channel marked (a
  column, and a rule for what happens when it is archived or renamed) and overrides D-115's choice that
  joining is the person's. The welcome step already puts it one tick away.
- *The name in the creator's language.* Two people in one workspace may not share one; a name is an
  identifier, not a sentence.
- *Making it in the client after the workspace is made.* Two requests, and a workspace with no channel
  whenever the second fails — the empty state this removes.
- *A welcome message posted in it.* Words nobody wrote, under somebody's name or a system's, in a
  product whose history is what people said.

**Cost of reversing:** one call in `createWorkspace`, the constant, their tests and the mutation entry;
the integration tests that stand on an API-made workspace name their own channel and would still pass.
No migration: channels already made stay.


### D-175. The layout takes the width a desktop window has

**Context.** The columns were sized for a laptop: the feed at most 760px, Settings 720px, the thread
panel 380px, the sidebar 240px, dialogs 480px and 640px. On a 1440px window the feed left about 190px
empty on each side, and on a 1920px one about 450px; Settings sat in a column of 640px usable width.
The owner, judging it live, found the product too narrow. The widths are tokens
(`packages/tokens/tokens.json`), so the change is the tokens and nothing beside them.

**Decided.**

1. `size-feed-max` 760px → 1040px: the feed, the composer under it and the list screens that share
   its column (D-158). A bubble is still at most five sixths of the feed (D-119; *no bubble since D-187*), so a line stays
   readable while a code block, a diff and a card get the room they lacked.
2. `size-settings` 720px → 960px, and `size-field` 320px → 360px, so a settings row's label and its
   control both breathe and a description is not wrapped into a column.
3. `size-thread` 380px → 440px: a reply's code and the panel's composer toolbar (D-164) fit without
   the key hints being the only thing dropped.
4. `size-sidebar` 240px → 264px: longer channel names and a group's faces (D-167) are cut later.
5. `size-dialog` 480px → 520px and `size-dialog-lg` 640px → 760px, in step with the rest.

Below `size-narrow` nothing changes: every column is the window's width there already.

**Amends** D-110 (the sidebar and the feed's width), D-119 §7, D-122 §3 (the panel's width), D-146 (the
Settings column) and D-154 (`size-dialog-lg`). Those entries keep the numbers they were decided with;
this one is where the widths are now.

**Rejected: a fluid feed with no maximum.** On an ultrawide window a line of a few hundred characters
is not read; the cap is moved, not removed. **Rejected: a density setting** (compact / comfortable) —
one layout the product is judged in until somebody needs the other.

### D-176. Connecting GitHub to an account made by email, from a session signed in as it — answers D-138 §3

*Amended 2026-10-21 by D-179:* the separate connect flow is replaced by linking on one verified address;
D-179 §5 says when two accounts are one and what is never linked.
*Removed 2026-10-21 (D-179 §5):* `POST /api/me/github/connect`, the connect `state`, the outcome set
`ConnectGitHubOutcome` and its address `?github=<outcome>`, `GITHUB_ALREADY_CONNECTED`, the connect
module and the card's **Connect GitHub** button and footer are gone; §1–§5 and §7–§8 below describe what
was. What stays: `GET /api/me/sign-in`, now read only, is the card's source (the address, whether a link
signs in, the linked login); `github_connected_at` is written by the sign-in that links an account
(§6's rule that a linked account keeps its email link holds); `GITHUB_ACCOUNT_TAKEN` is still what a lost
race on the GitHub id's index is called. The sign-in screen's `email-taken` no longer sends anyone to
Settings: a local account has that address but has not verified it, so the sentence says to sign in by
the link sent to it first where the server sends mail (the sentence is chosen by whether the email form is on screen), or to ask an administrator to verify it where it does not.

**Context.** The owner's team signs in both ways: with GitHub, and by email link (D-138). D-138 §3 refuses
a GitHub sign-in whose verified address is an email account's — the pre-hijack it closes is real — and
left "connecting the two deliberately, from a signed-in session" to a decision of its own. Without it,
somebody who first came in by link can never use GitHub: their GitHub sign-in is `ACCOUNT_EMAIL_CONFLICT`
for good. Decided under the owner's standing instruction to decide and proceed, and open to their
reversal.

**Decided.**

1. **Only an account without a GitHub account connects one, only from a session signed in as it.**
   Settings → Sessions & account shows *How you sign in* — the address and whether a link to it signs in,
   and the GitHub login or **Connect GitHub** — and the button is `POST /api/me/github/connect`: a
   same-origin JSON `POST`, so D-39 §2 refuses it from any other site, and there is no `GET` a link or an
   image could make. It answers where to send the browser and sets the state cookie.
2. **The state is a sign-in's, bound to who asked.** The same `__Host-` cookie and ten minutes as D-62,
   the same HMAC, under a key derived for this purpose alone (`purlay:oauth-connect-state:v1`): the
   random state, its expiry, the user, the session and the workspace slug to come back to. A sign-in's
   cookie is never read as a connect's nor the other way round; one this server did not sign as a
   connect — forged, rewritten, another key — is a sign-in's failure (`expired`), and connects nothing.
3. **The callback finishes it only in the session that asked.** It is the one callback GitHub knows
   (D-61); the cookie says which handshake it is. Before GitHub is asked anything, the session signed in
   in this browser must be the very one named — not merely the same person — so a sign-out between the
   halves, a browser where somebody else has signed in since, or a cookie carried to another browser
   ends it (`session`), and the code is never spent. As the account is written the session is held
   live (`FOR SHARE`, D-85), the row locked, and one connect of a GitHub account runs at a time.
4. **Never merged, never moved.** A GitHub account another Purlay account signs in with is refused —
   `GITHUB_ACCOUNT_TAKEN`, `409`, with the unique index behind the check — and so is an account that
   has one already, `GITHUB_ALREADY_CONNECTED`. What is connected is the account GitHub vouches for with
   the code; the address plays no part, and nothing the browser sends names it.
5. **It changes the GitHub columns and the picture, nothing else.** `github_id`, `github_login` — taken
   from any other account still holding the login, as a sign-in takes it (D-169 §2) — `github_connected_at`
   (migration 0046), and `avatar_url`, since pictures are GitHub's (D-11) and an account made by email
   has none of its own to lose. The address, the username and the display name stay the person's; no
   session is issued. A line is logged at `info` with the user and the session. No audit row: the trail is
   a workspace's, and connecting touches none.
6. **After it, the account signs in both ways.** A GitHub sign-in finds it by `github_id` and refreshes
   the picture and the login only — never the names, which were never GitHub's (D-38's refresh is for an
   account GitHub made). Its email link still signs in: D-138 §2 keeps links from accounts **GitHub
   made**, which is what `github_connected_at` tells apart once both have a `github_id`.
7. **The way through is said where the refusal is.** D-138 §3's refusal stands for every unlinked
   GitHub sign-in — nothing is ever linked silently — and the sign-in screen's `email-taken` now says it:
   made with an email link, sign in by link and connect GitHub in Settings → Sessions & account; made with
   another GitHub account, sign in with that one.
8. **How it came out is said in words on the page it began on** — `APP_URL/w/<slug>/settings/account?
   github=<outcome>`, a closed set (`ConnectGitHubOutcome`, `API.md` §2), as D-121 does for a sign-in.
9. **Erasure and export.** Erasure clears `github_connected_at` with `github_id` and `github_login`
   (I-11); an export omits it as it omits them (D-140).

**Not built: disconnecting.** An account keeps every way in it has. An account made by email that
connected GitHub could lose GitHub and keep its link, but nothing needs that yet, and an account GitHub
made has no other way in — disconnecting it would lock its person out. When it is needed it is its own
decision: who may, from how recent a sign-in, and what of `WORKSPACE_CREATORS` (D-169) then.

**Rejected.** *Connecting by matching addresses* — D-138 §3, the takeover it closes. *Binding the state
to the user alone* — a connect would outlive the sign-out of the session that asked, and finish in any of
the person's browsers. *A second cookie for a connect* — two handshakes in one browser would each find
the other's state; one cookie, the latest started, is what a person who pressed twice means. *A `GET`
that starts it, as `/auth/github` does* — a sign-in begun by a third party signs nobody into anything
they did not hold, but a connect begun by one would start binding an identity to the victim's account.
*Taking GitHub's name and login as the account's names on connect* — they would move under the person,
silently. *Merging two accounts when the GitHub account is taken* — one person's messages, memberships
and audit rows becoming another's is not a sign-in decision. *An audit row in each workspace* — tells
every workspace's admins about a person's identity elsewhere, which an export already withholds.

**Cost of reversing:** `modules/auth/connect-github.ts`, the connect half of `state.ts`, the branch in
`ingress/http/auth.ts`'s callback, the two routes, the column (a migration dropping it) and its three
readers (`identity.ts`, `email-sign-in.ts`, erasure), the card on the account page, the two error codes
and the outcome set in `@purlay/types`. Accounts already connected keep their `github_id` and become
accounts that sign in with GitHub and — by D-138 §2 — no longer by link.

### D-177. The main column is the window's width, from its left edge

**Context.** D-175 widened the centred column to 1040px and rejected a fluid feed. Judging it live on a
1600px window, the owner still found it cramped and narrow: the feed, the composer, the inbox, the
open questions, search, saved and every Settings page sat in the middle of the main area with an empty
band on each side, while Slack, which the team uses daily, keeps its messages against the left edge
however wide or narrow the window is. The owner asked for exactly that and reversed D-175's rejection.

**Decided.**

1. The feed, the composer under it, the list screens (D-158) and the Settings pages (D-146) take the
   main area's full width, their content from its left edge. Nothing centres them; the gutter is the
   only margin — 24px on the feed, the composer, a list screen and the headers above them, 40px on a Settings page, and
   16px each below `size-narrow`.
2. A bubble is still at most five sixths of the feed (D-119; *dropped by D-187: a line is the feed's width*): the cap on a line moves with the window.
3. `size-feed-max` stays and bounds only what is drawn inside a column — an empty state's sentence, a
   GitHub card — not a column. `size-settings` bounds only the welcome screen, a focused one-time step.
4. A thread's line under a message — its status and **Show thread** — is as wide as what it says and
   sits beside the bubble, on the bubble's side; a full-width row would put the two a window apart.

**Amends** D-119 §7 (the centred feed and composer), D-175 (its rejected fluid feed is what this decides), D-146 §2 (the Settings column) and
D-158 (the list screens' centred column).

**Rejected: keeping a cap and left-aligning it.** On a wide window the empty band moves to the right
and the screen still looks unused. **Cost of reversing:** the containers' classes in six files.

---

### D-178. A pull request says how it fails

**Context.** `CONTRIBUTING.md` §6.9 asks every feature to answer six kinds of bad day — refused
input, authority, concurrency, partial failure, network and time, volume — with a test or a reason.
Written as prose alone it is a wish (§6.2): the omission it guards against is silent by nature, and a
reviewer reading a diff sees what is there, not the category nobody thought of.

**Decided: a fourth rule beside D-74's three**, in `scripts/check-pull-request.ts`. A pull request
that changes the product — `apps/` or `packages/`, outside tests — carries `## Failure modes` with one
non-empty line per category. The template lists the six with empty answers inside no comment, so leaving it as it is
fails; an answer inside a comment or under another heading does not count. Documents, tests,
tooling, configuration and dependabot owe none: §6.9 is about how the product fails, and asking a
`.gitignore` change for six answers teaches people to write *n/a* without reading.

**The check proves presence, not quality.** Whether *n/a — no input* is honest is the reviewer's to
judge; that the question was asked is the machine's. One line each keeps the cost to a minute on a
small fix, which is the price of never shipping a category nobody considered.

**Rejected: requiring a test file per category.** Many changes have no surface in a category, and a
test written to satisfy a counter is the theatre §6.2 warns about.

**Rejected: running the check again on every edit of the body.** Adding `edited` to the trigger
would rerun the whole verify job on each keystroke saved; a body fixed after the fact is rechecked
by the next push or by rerunning the job.

---

### D-179. Identity moves to Better Auth, and a server is set up in the browser — amends D-11

**Context.** The team goes live in one to two weeks. Today sign-in, sessions, workspaces and invitations
work and are tested (D-11, D-38, D-115, D-138, D-176), but three things a stranger needs are missing: a
server cannot be set up without editing `.env`, nobody can make an account from the site, and the first
administrator, GitHub, mail and the first workspace are four unconnected chores instead of one path. D-31
had already named `better-auth` as the library an identity provider would justify, and the owner
decided it is the library now. The owner's decision is not reopened here; this records how it is done,
what a spike measured before any of it was built, and what each earlier decision becomes.

**What the spike measured** (Better Auth 1.7.12, pinned exactly in the manifest; a scratch database,
nothing merged; its report is the record of every number below).

- *Q4, the Organization plugin on `workspaces`:* two owners stepping down at once left **0 owners** —
  I-2 broken, because the plugin reads the owners and then writes without a lock; a removal is not
  atomic with its hook, so a failed channel clean-up left the member already gone; the codes are its
  own (400, 401, 403) instead of D-111's 403, 404 and 409, and a non-UUID id reached Postgres as a 500.
  Its invitation is a different thing from ours (addressed to one email, with a role and a status; ours is
  a link with a token hash, D-115). It would need a second invitation model, a trigger for I-2, an
  error-translation layer and half of the plugin turned off. Cross-tenant, every crossing was refused.
- *Q2, the session token:* **the default stores the raw token** in `sessions.token_hash`. The cookie is
  the token plus an HMAC of it under the secret, so a dump alone is not a cookie — but a dump plus the
  secret is every live session, which is weaker than D-11 and fatal if the secret is ever kept in the
  database. Nothing built in hashes it (`storeIdentifier: "hashed"` covers verification rows only).
- *Q7, GitHub:* **the default takes the public profile email, not the primary one**, and an unverified
  primary signs up with `email_verified = false`. `disableSignUp` and refusing to link to an unverified
  account both worked as documented.
- *Q8, the first administrator:* with password sign-up closed, `auth.api.signUpEmail` is refused on the
  server too (`400 EMAIL_PASSWORD_SIGN_UP_DISABLED`); creating through the internal adapter worked.
- *Q9, the hourly limits:* counters kept in the database survived a real process restart (429 on the
  next attempt); the in-memory store did not (401), and is shared across instances in one process.
- *Also measured:* the secret is fixed when an instance is built (Q5), a replacement instance swapped
  into a holder serves the next request while an in-flight one finishes on the old one, and sessions
  survive while the secret is the same; `@purlay/db`'s Kysely is accepted as it is (Q6), and
  `transaction: true` is what makes a sign-up atomic; the session resolves on a WebSocket upgrade from
  the same cookie (Q3); `users` maps through `modelName` and `fields` (Q1).

**Decided.**

1. **Better Auth owns identity: `users` (mapped, not renamed), `sessions` (mapped and hashed, below),
   `accounts`, `verifications` and the rate-limit counters.** It is mounted on the Elysia server under
   `/auth`, its base path — as a `GET` and a `POST` route for `/auth/*` handing the request to its handler,
   since Elysia's `.mount` strips the prefix the library expects and a route for every method loses to the
   client's `GET *` (measured on 1.4.30) — and the version is held exactly, as every dependency is. The library's documentation
   (concepts/database) says its `migrate` command checks the database and adds missing tables and columns,
   and only for its built-in Kysely adapter. **That is not used here, and this is the decision's own rule,
   not a finding about the library:** we never run it, at runtime or otherwise, and `generate` is only a
   reference. The schema stays in numbered migrations (D-45), the single source, checked by Better Auth's own
   schema validation once the migrations are in — at boot after a migration on start, and by readiness —
   and a mismatch is a process that refuses to start or is never ready.
2. **What stays ours.** The `workspaces` module — workspaces, `workspace_members`, the roles and every
   rule of D-111, the audit trail — and its invitations, still links at `/invite#<id>` with the token
   hash of D-115. Tenancy is still read from `workspace_members`, keyed by the same `users.id` (D-21,
   D-54). **The Organization plugin is not used.** Q4 is the reason: its failures are in exactly the rules
   this product treats as non-negotiable, and making it pass means building around it. D-111 and the
   cross-tenant tests must stay green **unchanged**, and that is the check the code change is judged by:
   an identity change that needs either edited has touched what it should not. Better Auth does not hold a copy of anything the `workspaces` module holds (§6.1).
3. **Mechanisms we build and test, because the library does not do them.**
   - *A session-hash plugin* on the Kysely instance handed to Better Auth: every value bound to
     `sessions.token_hash` is SHA-256ed on the way in, and a result row keyed by the raw token gets the
     raw token back. D-11's property — a dump is not a session — holds with the secret too. The plugin
     has its own tests and an entry in `scripts/mutations.ts`. **The plugin is scoped to the `sessions`
     table**, and alone it broke the library's `revoke-other-sessions` into a silent no-op (reproduced
     in the spike's fix round 1), so that route is answered by an endpoint of ours: it deletes the user's
     other sessions by row `id` and never accepts a digest as a token. A session list or a revoke by row
     goes through our endpoint by the session's `id` for the same reason; its tests include
     `revoke-other-sessions`, change of password and password reset. The library deletes a session's row on sign-out and revoke, so `sessions.revoked_at` stays in the schema
     and is unused, and `audit_log.session_id` becomes `NULL` as it already does (D-116) — at once, when
     the session ends, since every way Purlay ends one deletes the row too (D-116 §4, as amended).
   - *A `getUserInfo` override for GitHub* that takes only the primary **and** verified address, and
     makes the username from the login there — an override skips the library's own `mapProfileToUser`.
     `github` is never in `trustedProviders` and `requireLocalEmailVerified` stays `true`. **The
     username is never a client's.** The field is declared `input: true` only because the library's
     OAuth callback drops the fields marked `input: false` from a provider's profile and then fails
     the sign-in for the missing one; so a value a client sends could reach it, and a
     `databaseHooks.user.create.before` validates every username — lower case, `[a-z0-9-]`, at most 39,
     the first one free through `availableUsername` — shaping or replacing what it is given and never
     storing it raw (Ruling R23). `/update-user` is closed, so no later request can set one. The same
     hook supplies the username and display name for the magic-link path, which checks nothing and
     would otherwise be a 500 on `NOT NULL`.
   - *The first administrator through the internal adapter*: `createUser` and `linkAccount` (a
     credential account, the password hashed by the library) in **one** transaction, with
     `emailVerified = false`. The spike measured it with `true`; the design says `false` and wins (§7).
   - *A holder swap* for changing settings: a new `betterAuth()` is built from the saved settings and put
     where the handler is read, atomically per request. The secret is not a setting: it is derived from
     `ENCRYPTION_KEY`, the key the environment already requires at boot, with a purpose label of its own as
     D-62's state key is, so no new variable exists, and it is never stored in `server_settings` or edited in
     the browser, because changing it signs everyone out (Q5) and a dump with it is every session (Q2).
   - *Fixed configuration, from the spike:* telemetry off; the cookie named exactly
     `__Host-purlay_session` (`useSecureCookies: false` with `Secure` set in the default attributes —
     otherwise an https base URL prefixes `__Secure-` and the name is doubled); `database` as
     `{ db, type: 'postgres', transaction: true }`; `generateId: 'uuid'`; rate limiting **enabled** with
     storage `database` (its default is production-only); and a `databaseHooks.session.create.before` that
     turns the library's empty address into `null`, since `sessions.ip_address` is an `INET`. The
     library's schema check is asked of a fresh instance, never left to the serving one: the library runs
     it the moment an instance is built and keeps a mismatch for the life of the process, so a server that
     migrates on start refused every sign-in until a restart (measured by `migrate-on-start`'s two-process
     test). It is not asked inside transactional tests, and a test asserts the check itself. The session
     lasts `SESSION_TTL_DAYS` from sign-in and is never slid forward by use, as D-60's always was.
   - *GitHub's code is redeemed with its PKCE verifier.* The library sends a `code_challenge` (`S256`)
     with every authorization, and GitHub then requires the matching `code_verifier` with the code
     (docs.github.com, *Authorizing OAuth apps*). The token exchange is ours — through the injected
     `fetch`, with a deadline — and found in review to have dropped the verifier: every real sign-in
     would have been refused while a lax test double passed. The verifier is sent, and the double now
     checks it as GitHub does, so a test that passes is one GitHub would pass.
   - *A known limit of the library's state:* its cookie lasts five minutes and its row ten, so a person
     who spends between five and ten minutes on GitHub's page comes back to `expired`, whose sentence
     already says to start again; neither lifetime is ours to change.
   - *Every session the library ends is told to its sockets.* Its delete hooks announce each row
     after the commit, but they see only the rows the library read first — at most a hundred — and
     a failure of that read is swallowed while the delete goes ahead. So the five routes that end
     sessions (`/sign-out`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`,
     `/reset-password`) are watched whole (`/change-password` ends the others itself, below): every session id of the person is read
     before the route and again after it, by the person and never as a list of ids, and each one gone
     is announced on its own, so one announcement refused never silences the rest. The cost is two
     indexed reads per such request, and a session announced twice, which the hub ends once. A read
     of the watch that fails is written down and never stands between a person and signing out.
   - *The library's log lines are ours.* Its logger writes through Purlay's: its message and the first
     error of its arguments, any address replaced and a driver's `detail` never copied; the rest of
     its arguments are counted, not written. `onAPIError.throw` is on, so an error that is not one of
     its answers reaches our error handler instead of its router's raw `# SERVER_ERROR` print — and
     since the library then logs no failure it answers itself, ingress writes each `5xx` it answers
     once, with the route, the status and its known code only, and
     sessions are read with their user in one statement (`advanced.database.joins`), since the
     library's adapter prints a failed second read raw and no option quiets it.
   - *A log line names a path under `/auth/` by the library's route, never as sent.* A path segment
     is the caller's to write, and a reset's token travels in one (`/reset-password/:token`); so the
     request line, a failure thrown under the library and a `5xx` it answers all carry the route as
     the library's own endpoint table spells it — the parameter left as `:token` — or `/auth/*` for a
     path it has no route for. The table is read off the instance (`Auth.routeOf`), never copied.
   - *A first sign-up lost to the same person's other tab is sent round once.* The library answers
     the losing tab `unable_to_create_user` with its state spent; where the other tab's account now
     exists, that tab is sent to `/auth/github` again with a one-shot `__Host-purlay_signin_retry`
     marker, and GitHub authorises without a prompt. A tab that loses again with the marker is told it
     failed. D-78's property, two sessions and one user, holds (Ruling R28).
   - *Sign-in by link is the library's magic link, with what it does not decide decided first.* It is
     installed only where there is a relay (`storeToken: 'hashed'`, `expiresIn` from
     `SIGN_IN_LINK_TTL_MINUTES`, its token Purlay's 64 hex digits). Its own two routes are closed:
     `/sign-in/magic-link` takes a display name and knows none of the rules here, and
     `/magic-link/verify` spends a link on a `GET`, which a mail scanner makes. Purlay's routes ask it
     through its API, which those closed paths do not reach: `sendMagicLink` never sends the library's
     `url` — it mails `APP_URL/sign-in/email#<token>` through the outbox, in the asker's language —
     and the page shows the address by reading the library's row by the token's digest
     (`magic-link:` and base64url SHA-256, measured), spending nothing. Who may be sent a link, the
     word to an account GitHub made, and the hourly limits are Purlay's (`modules/auth/magic-link.ts`):
     the library's own `disableSignUp` stays off, so whether a new address may become an account is
     decided in one place. A request is answered `202` once its two counts are taken, the same work for
     every address; the account is read and the link made only after the answer, so its time says
     nothing (D-138 §1, §6) — measured in review, a link made before the answer told a verified
     account from an unknown one in a single request. What is left for after the answers has no cap of
     its own: its bound is the two counters and the edge's `auth` budget, which every request passes
     first. A link a day past its expiry, and a counter a day
     old, are swept by `sweep:email-sign-ins`; `email_sign_ins`, which nothing wrote any more, is
     dropped (migration 0048).
     The limits are counters in `rate_limits`, keyed by a purpose and a digest — never an address —
     and taken in one statement, so requests at once cannot each see a stale count; a counter's
     `last_request` holds when its hour **closes**, because the library prunes that table by the column
     against the longest window it knows of, shorter than an hour. The library spends a link before it
     makes the account, so its spend runs in one transaction of the library's own
     (`runWithTransaction`): a spend that loses a unique index — the same new address by its other
     link, or another new address wanting the same name — is undone whole and tried once more, and
     finds the account, or the next name; without the second try the race tests fail on it.
   - *No provider token is stored.* The library has no option to leave them out (`encryptOAuthTokens` only
     encrypts them) and Purlay never calls GitHub for a person, so `databaseHooks.account.create.before` and
     `update.before` set the access, refresh and ID tokens and their expiry to `NULL`. `accounts` keeps the
     columns because the schema check demands them.
4. **The browser setup.** A server with no user is open to setup, and to nothing else:
   1. **A setup code.** The first start writes a one-time code to the log and stores only its hash; the
      wizard asks for it first. A wrong code is refused and counted.
      *As built (`modules/setup/setup.ts`, migration 0050):* twenty symbols drawn evenly from 32 that
      cannot be taken for one another (`2`–`9` and `A`–`Z` without `I` and `O`) — 100 bits — shown in five
      groups of four, and taken in any case, with or without its dashes and spaces. **Every start of an
      open server writes a new one**, in one line at `warn` under the field `setupCode` — the one secret
      logged on purpose, so that field is not on the logger's never-logged list, and the claim's token
      is — and keeps only its SHA-256; the newest code is the only one that opens, so one nobody used is
      replaced by the next start. No function returns it. **A code opens for an hour** from its start
      (Ruling R39); after it the right code is answered, and counted, as a wrong one, so a code found
      later in a kept or shipped log is dead. **The throttle is the server's**, not an address's, since
      the code is the server's secret: the fifth wrong code locks every claim, the right code included,
      for fifteen minutes; the count is kept by the database under the row's lock; a refusal while
      locked is not counted; a lock that runs out starts the count again. **The lock belongs to the code**
      (Ruling R40): the next code, written at a start, begins with no count and no lock, and five
      guesses at 100 bits per forced restart are worth nothing. That undoes only a **slow** stranger: one
      who keeps sending wrong codes locks the new code five requests after each start, and neither a
      restart nor the statement `CONFIG.md` gives to clear a lock lets the operator in. The cost is
      that whoever can reach `/setup` can keep it locked by guessing; the answer is a limit per client
      on the route, which comes with the endpoint — **a requirement of the `/setup` endpoints**, not an
      option, and built (§4.10: ten codes in fifteen minutes from one client) — and an operator who
      blocks the source.
   2. **A claim lock.** The moment the code is accepted, setup is bound to that one browser; a second
      browser sending the code at the same time is refused, and exactly one wins. A browser that closes
      and returns resumes at the step it reached, in the same claim; a half-written setting never stays.
      *As built:* the row is locked while a code is weighed, so of two right codes at once one claims and
      the other is refused as `claimed` (measured, 25 rounds); the claim **spends** the code, so the same
      code from any browser afterwards is refused. The winner is handed a random token once — for an
      `HttpOnly` `__Host-` cookie — and only its digest is kept; every later step is guarded by it
      (`requireSetupClaim`), and a missing, wrong, replaced or idle token, or a closed server, is the one
      refusal, compared in constant time. The steps are a closed set, `SETUP_STEPS` in `@purlay/types`
      (claim, admin, address, policy, github, email, workspace, invite, finish — the policy chosen on the
      address's screen, `UX.md` §11), passed in order; passing
      one again changes nothing, and `finish` is written only by the finish rule, with
      `server_settings.setup_completed_at`. **Abandoned or lost:** a claim whose browser has not been
      seen for a day no longer opens. A browser without the token — another one, cookies cleared, a day
      gone — needs a code, and the code is spent: the operator restarts the server and enters the new
      code from the log, which **takes the unfinished setup over at the step it reached — only once the
      claim has gone unseen for fifteen minutes** (Ruling R39; seen means the guard passed or a step
      was recorded). A claim seen within them is refused to every code, a fresh right one included,
      which the refusal does not spend; so a crash, a deploy or a restart that writes a new code while
      an operator works hands their setup to nobody who reads the log afterwards. The browser that held
      a claim taken over is refused from its next request. An operator who lost the browser waits at
      most fifteen minutes and a restart.
   3. **The administrator** gives a name, an address and a password, and signs in with them. The address
      starts **unverified**: whoever knows the code runs the server, but has not proved the address is
      theirs, and one mistyped could be claimed through GitHub. It is verified when the link in the mail
      step is followed — a one-time mail of the wizard's own, its token kept as a hash, and **never the
      library's magic link**. The library's documentation (plugins/magic-link) says a magic link that
      verifies an account whose address was never confirmed removes its password and revokes its
      sessions, and on 1.7.12 it does more, measured against the real tables: every `accounts` row of
      the account goes — the password **and** a linked GitHub account — its sessions are deleted, a new
      one is opened and `email_verified` becomes `true` (`revokeUnprovenAccountAccess`). The setup
      administrator is exactly such an account. So **no magic link reaches an account whose address is
      unverified**: asking for one sends nothing and is answered `202` as for any address; a link
      already in a mailbox when such an account appears at its address is refused as one that does not
      open, before the library is asked; and should anything reach the library past that, two hooks of
      its own (`account.delete.before`, `user.update.before`, on its spend's route) refuse the
      promotion, and the spend's transaction undoes the rest (`magic-link-guard.integration.test.ts`).
      Without mail, a
      password is reset by a command on the server (`bun run admin:reset-password`), which the wizard
      names when mail is skipped. Password sign-up stays closed to everybody else.
      *As built (`modules/setup/admin.ts`, `modules/auth/password-attempts.ts`, `@purlay/types`
      `password.ts`):* **the step.** `createAdmin` needs the claim this browser holds, weighed again under
      the row's lock, and the setup standing at `claim`; once an administrator is recorded a second is
      `admin-exists`, whatever it is called (five at once make one). In **one transaction** of ours, the account is made through
      the library's own adapter pointed at that transaction (`kyselyAdapter` over it, `runWithAdapter`) —
      `createUser` with `emailVerified = false`, so its user hook names it by the rules every account is
      named by, and `linkAccount` with a credential: `provider_id` `credential`, `account_id` the user's
      own id, the library's scrypt — then `users.is_server_admin`, `setup_state.admin_user_id` and the
      `admin` step; a failure anywhere leaves no user, no password and no administrator (measured). The
      address is one mailbox (`normalisedMailbox`), the name 1–128 characters after trimming with no
      control or format character, an address an account has is `email-taken`; each is a typed refusal
      before anything is written; the password is hashed only past every refusal, inside the
      transaction, so nobody without the claim makes the server spend scrypt. Only the account's id comes
      back. The administrator is then signed in by the library's own `/sign-in/email`
      (`Auth.passwordSignIn`, through `signInAdmin`, which requires the client's address so the attempt is
      counted as the route's are): its cookie, its session row, hashed at rest — no session is made by
      hand, and only the answer's `Set-Cookie` is for the browser, since its body carries the raw token. A command that resets a password writes the same row shape
      (`credential`, the user's id, `hashPassword` of `better-auth/crypto`), and the library accepts it
      (tested). **The policy**, one home in `@purlay/types` and read by the setup, the library's options
      and its hook: 10 to 128 characters (the library's `minPasswordLength`/`maxPasswordLength` are set
      from the same constants, so its sign-in, change and reset agree); no control character and not
      blank; compared after NFKC and lower case, not containing the address, its local part (four
      characters or more), the display name or any word of it (four or more); not one of a short list of
      the commonest passwords of ten or more, nor one of them with digits or marks added at its end
      (`Password123!`); at least four different characters. No breach lookup, no network call. A change of password or a
      reset is held to it by a `before` hook (`400 PASSWORD_TOO_WEAK` with the reason, said to the
      account's holder only), before the current password is weighed. **Sign-in with the password**
      works for the unverified address: `requireEmailVerification` stays off, and a change of password
      always ends the person's other sessions — but not the caller's own: the hook forces the library's
      `revokeOtherSessions` **off** (on, the library deletes and replaces the caller's session, and the
      open page is told its session ended before the new cookie reaches it), and an `after` hook, on a
      success only, deletes the person's other sessions by row id in one statement and tells exactly
      those ids to their sockets (§3). If that step fails after the password changed, the answer is
      `500 OTHER_SESSIONS_NOT_ENDED`, written down redacted: the password did change, the other sessions
      stand, and the page says to use *Sign out everywhere*. **No enumeration:** an unknown address, an account with no password and
      a wrong password are one answer — `401 INVALID_EMAIL_OR_PASSWORD`, body and headers alike — and one
      cost: the library hashes the password it was given for an address it does not know (1.7.12,
      `sign-in.mjs`), measured over sixty interleaved samples each at a median of 32.91 ms for a known
      address and 32.64 ms for an unknown one before this work, 33.36 and 33.35 after it, so no dummy hash
      of ours is needed; the timing test stays to say so if the library changes. **The throttle is on
      wrong guesses, and is not a lockout.** A client is a **network**: an IPv4 address, or an IPv6 /64
      (`limitKeyFor`, the edge's key too) — one subscriber's allocation, whose host bits are theirs to
      rotate, so a key per IPv6 address would be a fresh budget per request (found in review: 25 rotated
      hosts of one /64 had every guess weighed). An attempt is counted before the password is weighed — in
      `rate_limits`, one statement each, so attempts at once cannot all pass a count that has not moved —
      and given back unless the library answered a wrong password (`INVALID_EMAIL_OR_PASSWORD`,
      `INVALID_PASSWORD`): a sign-in that works spends nothing. Ten wrong for an **address from one
      client**, twenty from one client whatever the addresses, in fifteen minutes; past either the answer
      is `429 RATE_LIMITED` with `Retry-After`, and the password is not weighed, the right one included.
      The address is never counted alone: a count per address, whoever sends the guesses, would let a
      stranger spend the administrator's allowance from anywhere and keep them out with the right
      password — a lockout anybody can cause. So a stranger's wrong guesses use up only the stranger's
      own. **The residual risk this accepts:** a guesser spread over many networks — many IPv4
      addresses, many IPv6 /64s — has ten tries at an address from each network every fifteen minutes,
      and there is no ceiling for the address across networks, since any hard one would hand a stranger
      the lockout this refuses; the policy and the hash's cost are what stand against it. `/change-password` counts its wrong current passwords with the
      sign-in's. The library's own rule for those two routes (three requests in ten seconds, successes
      counted, `X-Retry-After`) is switched off (`customRules`), so the throttle has one home and one
      answer; the edge's `auth` budget still bounds every request first. A password over 128 is refused
      by the library before it is hashed and is not counted; a body past the edge's bound is `413` before
      it is read. **The library's password routes**, every one of its endpoint table whose path or body
      names a password, each decided and held by one test that fails when an upgrade adds another: open
      and counted, `/sign-in/email` and `/change-password`; open and held to the policy, `/reset-password`,
      whose token no route issues; **closed** (the API's `404`), `/verify-password` — it says whether a
      password is the session holder's, so a stolen session would guess the password behind it, found in
      review answering 25 wrong guesses and then the right one — `/delete-user` (an account is erased by
      Purlay's own route, D-139 §5) and `/request-password-reset`, so no token for a reset is ever issued
      over HTTP; `/reset-password/:token` takes no password; `/sign-up/email` answers
      `EMAIL_PASSWORD_SIGN_UP_DISABLED`; `setPassword` is the library's API alone, with no route and so no
      hook to hold it to the policy, and a test holds that nothing of ours calls it. An erasure deletes the account's `accounts` rows — the password's hash with them — and
      the wrong-password counters under its address.
      **The address check** (`modules/setup/verification.ts`, migration 0051, Ruling R32): one link,
      `APP_URL/setup/verify#<token>` — the token in the fragment, as every link's is — mailed in the
      e-mail step as the very letter the relay is tried with (§4.4). It is issued only under the claim,
      for the administrator the setup recorded, while the address is unverified; a new one replaces the
      one before it. The token is 256 bits, handed back once for the letter, and only its SHA-256 is
      kept, in a table of one row (`admin_email_verification`) that names the account itself — not in
      `setup_state`, because the letter may be opened after *Finish*, which forgets the administrator and
      spends the claim. Following it needs no claim and no particular browser: the token is compared
      with the digest in constant time, opens for **a day** from its issue (one issued "in the future",
      a clock moved back, does not open), and is spent in the transaction that sets
      `users.email_verified` — so of two clicks at once one verifies: the row is locked while it is
      weighed, and, should the lock ever go, only the click whose `DELETE` removed the row may mark
      the address (both held by a test that makes the second click wait on the first). The row keeps
      the address it was mailed to, and a link followed after the account's address changed verifies
      nothing. An unknown, spent, expired or wrong link, or one whose account was erased or whose
      address changed since, is one refusal, with nothing to tell them apart; a wrong guess spends
      nothing; a link tried past its day is deleted, and the daily `sweep:email-sign-ins` deletes one
      nobody tried. Erasure deletes the row (its key's `ON DELETE CASCADE` does not see a soft
      deletion), and it is never exported.
   4. **The server address, GitHub and mail are each tried before they are saved.** GitHub is called
      with the pasted values and mail is sent a test message; a failure is answered with what happened,
      how to correct it, and the service's own reply, as one of a closed set of reasons. A step may be
      skipped, and says what then stops working.
      *As built (`modules/setup/probes.ts`; the reasons are `PROBE_REASONS` in `@purlay/types`):* each
      probe takes the **candidate** values and reads and writes no setting; the endpoint saves only
      after `ok: true`. **GitHub:** a `POST` to the token endpoint under `GITHUB_URL` — the base every
      sign-in uses (Ruling R36) — with the client id, the secret and a code GitHub never issued
      (`purlay-setup-probe-never-issued`), no `redirect_uri`, bounded at ten seconds like a sign-in's
      calls. GitHub weighs the app before the code, so `200 {"error":"bad_verification_code"}` says the
      pair is good and only the code was refused (documented; not measurable without a real app's
      secret, so held by the strict stub); `200 {"error":"incorrect_client_credentials"}` is a known app
      with the wrong secret, **`secret-rejected`** (measured against github.com on 2026-10-22 with a
      public app's id); an id GitHub does not know is answered **`404 {"error":"Not Found"}`** —
      measured, and not in GitHub's documentation, which names `incorrect_client_credentials` for "the
      client_id and/or client_secret" — **`client-unknown`**. No code a person was given is ever sent,
      and a token, should anything hand one back, is neither kept nor shown (`unexpected-reply`).
      **What it cannot try: the callback address.** GitHub checks it on its authorize screen, which only
      a browser reaches, and the probe sends none — the parameter is optional at the token endpoint, and
      sending one would add a check whose order against the code's cannot be measured without a real
      app — so `callback-mismatch` is not a reason: the wizard shows the exact address to paste,
      `APP_URL/auth/callback/github` (Ruling R35), and says what GitHub's own error page means (Ruling
      R47). **Mail:** a transport built from the candidate address as every relay's is
      (`transportOptions`: TLS required past this machine unless the operator says the link is
      private), asked whether it answers — nodemailer's `verify()`: DNS, connection, TLS, login — and
      then sent **one** letter, the administrator's own verification letter (§4.3), so a relay that
      refuses the sender or the message is found here rather than at the first invitation. Each phase
      is bounded at ten seconds (DNS, connection, greeting, silence) and the whole try at twenty;
      nothing is retried. The reasons follow nodemailer's codes as measured on 10.1.2, where they differ
      from its error reference: a refused connection, a host that does not resolve and a timeout are
      **`unreachable`** (`ESOCKET` with `ECONNREFUSED`, `EDNS`, `ETIMEDOUT`); an untrusted certificate is
      **`tls-failed`** — reported as `ESOCKET` with the certificate's code in `originalCode`
      (`DEPTH_ZERO_SELF_SIGNED_CERT`), not the `ETLS` the reference names — as are `smtps://` to a plain
      relay and a relay past this machine that does not offer the upgrade (`ETLS`); a refused login is
      **`auth-failed`** (`EAUTH`); a refused `MAIL FROM`, `RCPT TO` or message is **`sender-refused`**,
      **`recipient-refused`** or **`message-refused`**; a greeting that is not SMTP, and anything else,
      is **`unexpected-reply`**. **The reply** shown with a reason is the service's own words, trimmed to
      200 characters, with every spelling of what was tried — as typed, escaped, and in base64 as `AUTH`
      sends it — an address's credentials and anything token-shaped taken out, so a relay or a GitHub
      that echoes a login shows none of it; the spellings are the secret as typed, inside a JSON string
      (the probe's own request body, echoed), percent-escaped, form-encoded, and in base64 with and
      without its padding. **What a hostile answer cannot do** (found in review, fix round 1): GitHub's
      reply is read no further than 8 KB (a stream that never ends is cut, a `Content-Length` past it
      is not read), and **no redirect is followed** — a `307`/`308` would re-send the body, secret
      included, to wherever `Location` points, and that origin's answer would have decided the try;
      every 3xx is `unexpected-reply`. The same holds for a sign-in: `GithubFetch` requires
      `redirect: 'manual'` of every call (the token exchange, the profile, the addresses), a redirect
      is GitHub failing the sign-in, and each reply is read no further than 64 KB. (Bun drops
      `Authorization` on a redirect to another origin, measured, so the workspace unfurls' bearer
      token is not carried off; their bodies carry no secret.) A relay's conversation still running at
      the deadline is cut — the probe opens the sockets and hands them to the transport, since
      nodemailer's `close()` lets go of none — so no probe leaves a socket open. The sender is one
      plain address (`normalisedMailbox`, no name, no line break) or the try is refused before it
      starts, as an address no transport can be built from is (`CandidateRefused`, for the endpoint to
      answer as invalid input). **A relay with a private certificate** is refused (`tls-failed`);
      nothing turns the check off, and the operator gives the server the authority with
      `NODE_EXTRA_CA_CERTS` (`CONFIG.md`; measured to work with Bun and nodemailer) or uses a relay
      with a public certificate. **Who may run a probe is in its type** (Ruling R48): each takes a
      `ProbeAuthority` first — a `SetupSession`, minted only by `requireSetupClaim`, or a
      `ServerAdminSession`, which only Administration → Server's guard will mint — branded by symbols
      their module does not export, an assertion into either refused by lint (`verify:enforcement`
      proves it). **Where the probe connects is the claim holder's to say.**
      The relay's host is typed by whoever holds the setup's claim, who proved they run the server by
      reading its log; the probe connects wherever that is, internal relays included, with no allow or
      deny list that would refuse a legitimate one — only while the setup is open, and only for the
      claim's holder (the endpoint requires the claim).
   5. **The finish rule.** *Finish setup* is refused until at least one way for **other people** to sign
      in is connected **and tried**: GitHub's app accepted by the probe (§4.4), or a relay that took the
      test letter — so a server nobody but its administrator can sign in to never counts as set up. The
      administrator always has the password, so signing in through the channel is not asked (Ruling
      R47: a GitHub sign-in to the unverified administrator is refused by design, §4.3). It is enforced
      by the server, not only the button.
      *As built (`modules/setup/wizard.ts`, migration 0052):* the setup remembers when it saved each way
      in after a try that worked (`setup_state.github_tried_at`, `email_tried_at`, written with the
      step), and the finish counts a way only when it was so saved **and** serves now (the instance has
      the GitHub provider, or a relay): an app or a relay merely in the settings — seeded from the
      environment, never tried — does not count, nor one a rotated key left unreadable. With it: every
      step before the finish passed (the invitations, skipped or not, the last) and the first workspace
      there. Every reason that holds is listed to the holder (`SetupState.finishProblems`); the finish
      itself is refused with the first, and calls `completeSetup` in the same transaction.
   6. **Without mail** (GitHub only): email sign-in, inviting by email and *create an account by email*
      are hidden, the invitation step only copies the link, and a link already works without any mail
      (D-115).
   7. **The default is invite-only**, and the one choice made in setup is invite-only or open.
   8. **After setup** `/setup` answers as a closed door on a server with any user, and the settings are
      managed in **Administration → Server**, with the same try-first probes.
      *As built:* closed rests on **two facts, either enough**: `server_settings.setup_completed_at` is
      set — the one home of "setup is finished", written only by `completeSetup` and never cleared (a
      patch clearing it is refused by its type and by the server) — or a user exists **other than the
      administrator an unfinished setup made** (`setup_state.admin_user_id`), so the wizard's own
      administrator, made at its second step, does not shut it halfway. Finishing, in one transaction,
      sets the first, clears `admin_user_id`, records `finish` and spends the claim — so afterwards every
      user, the administrator too, keeps the door closed, and a lost or restored settings row reopens
      nothing. **Only a server with no user at all is open, and that is a fresh install.** A server that
      had people before this version is closed from its first start. Closed, every setup function
      refuses; each start clears what an unfinished setup left (code, claim, count, lock), writes no
      code and says `setup is closed` instead. **One allowance (Ruling R42):** while the finish is not
      written, users who arrived during the setup — an invitee who accepted before *Finish* — close it
      to everybody but the browser holding a valid claim, which may still pass its steps and finish, so
      the door ends on both facts; a start then keeps that claim and clears the rest.
      *Administration → Server, as built* (`modules/setup/server-admin.ts`, `ingress/http/server.ts`,
      `API.md` §2 `/api/server/*`). **One guard** — `requireServerAdmin`, the only thing that makes a
      `ServerAdminSession`, the other authority the probes take (R48) — reads the request's own session and
      then `users.is_server_admin` and `deleted_at` from the database each time; a workspace role proves
      nothing, and nothing in the request can say it. **Everybody else is `404 ROUTE_NOT_FOUND`**, signed
      out included: the repo's convention for what is not for a caller is absence (`SETUP_UNAVAILABLE`,
      `WORKSPACE_NOT_FOUND`), and a `401` would tell a stranger that the route exists. **A change is the
      wizard's machinery**: tried with the candidate under the administrator's authority and kept and
      served by `applySettings` only when the try worked — and the wizard's `tried` flags are **not**
      used: they exist for the finish rule of a setup that is open, so the routes refuse while it is
      (`409 SERVER_CHANGE_REFUSED`, `setup-unfinished`), which is also what keeps a change made here from
      leaving a flag describing a pair that was never probed; `canFinish` is never consulted. **The
      relay's test is a plain letter to the administrator's own address**, not the address-proof link.
      **Never the last way in by accident**: disconnecting GitHub or the relay is refused (`last-channel`)
      when no other way for other people to sign in would remain, unless the administrator says
      `confirmLastChannel`; the rule is weighed inside `applySettings`' own transaction, from what that
      transaction saved, so two disconnects at once cannot both pass. **Every change is on the server's
      trail** (`server_audit_log`, migration 0054): `audit_log` is a workspace's and requires one, and
      these settings belong to none; the row is written by `applySettings` in the same transaction as the
      save (its `alongside` hook), so it exists exactly when the change does, and holds the actor, the
      session and the action — never the value. A limit per client, sixty in fifteen minutes, is charged
      before the session is looked at. **The password's recovery is `bun run admin:reset-password
      <email>`** (`modules/setup/reset-password.ts`): the break-glass for the server administrator only —
      any other address is refused in the words an unknown one gets — with the new password read from the
      terminal (nothing shown, asked twice) or from standard input, **never an argument or the environment**
      (a second argument is refused unrepeated); the policy applies; the credential row is written as the
      library reads it (R10); and every session of the account ends in the same transaction. It works on
      the database `DATABASE_URL` names, the real one included: that is what it is for. It leaves a row
      on the server's trail (`server.admin_password_reset`, the account itself as the actor, no session,
      never a value) in the same transaction. **Open real-time connections end within about half a
      minute**: the command is a process with no bus, and the hub resolves a socket's identity once, so
      the hub's **liveness sweep** (`realtime/liveness.ts`) asks, every 30 seconds and in one query
      (batches of at most a thousand sessions, never one per socket), about the sessions of all open
      sockets, and ends — with the `SESSION_ENDED` frame and close code every other end of a session
      uses — each whose session row is gone, expired, or whose account is erased; a query that fails
      closes nothing and is tried again at the next tick, and the timer neither keeps the process alive
      nor survives shutdown. That is also what ends the sockets of any session an operator removes by
      SQL. A GitHub secret or relay address the key cannot open can be disconnected (`needsReentry`
      counts as connected for that), under the same last-way-in rule, which clears the ciphertext.
   9. **A changed setting takes effect without a restart** (Ruling R37; *as built*,
      `modules/setup/runtime.ts`). What the wizard and Administration → Server change — GitHub's app, the
      relay, who may sign up, who may make a workspace — is applied by `applySettings`, which in **one
      transaction of its own** saves the patch, reads the whole row back as a start would, builds a new
      library instance and relay from it (`runtimeServicesFrom`, the start's own function; nothing is
      connected), and asks the new instance the library's schema check. A failure at any of these rolls
      the save back and the old pair serves on. Only once the commit is confirmed is the new pair swapped
      into the holder — one synchronous assignment that cannot fail — so the database and the process
      disagree for no longer than that step, and a process that dies at any point leaves the database as
      the next start should read it. The instance is **replaced, never edited**: the library fixes its
      providers and plugins at construction (Q5), so the GitHub provider exists exactly when the settings
      hold an app and the magic-link plugin exactly when they hold a relay, both ways; who may sign up is
      built in too, and rebuilt with the rest. Who may make a workspace is read per request and would need
      no rebuild; every change rebuilds the pair anyway, at about half a millisecond.
      - **What never changes at run time**: the secret sessions are signed with (derived from
        `ENCRYPTION_KEY`), so **every session outlives a swap**; `APP_URL` and where GitHub is
        (`GITHUB_URL`, `GITHUB_API_URL`), which stay in the environment (§6). The library's in-memory rate
        counters are process-wide and its database ones shared, so a swap hands no attempt back.
      - **A request is served by the pair it started on.** The application holds a stand-in that reads, on
        every use, the pair the request **pinned at its first hook** (`AsyncLocalStorage`, the same
        mechanism the request's log scope uses): a request in flight during a swap finishes on the old
        instance, what it leaves for after its answer posts through the old relay, and the next request
        is served by the new one. A socket's admission and its open each pin their own. The stand-in, not
        an accessor passed to every handler, because over a hundred handlers take the instance as a value
        and the pin makes each of them correct without a change; it is typed as the library's instance and
        holds no `any`.
      - **The replaced relay is let go cleanly**: its letters still on their way are waited for (two
        seconds at most), then its transport is closed. Every relay the process built counts its sends
        in one ledger, which the shutdown waits for after the drain and before the pool closes
        (`closeAfterDrain`, `lifecycle.ts`), so a letter posted to a replaced relay — even after it was
        closed, by work pinned to it — is not cut off. That last part rests on the transport being
        **unpooled** (a connection per letter; `close` holds nothing back): a test sends a letter through
        a closed transport, so pooling it would fail first. The
        old instance has no timers and no dispose; it is garbage once its last request ends (a hundred
        swaps measured: no instance, timer or relay connection left).
      - **Two changes at once run one after the other**, the second built from what the first saved, and
        not begun until the first has let its replaced relay go. A change before the start has read the
        settings is refused (`starting`), one once the process has begun to drain is refused
        (`shutting-down`: a pair built then would be dropped a moment later; a change already under way
        finishes, the drain waiting for its request), and so is one handed a caller's transaction, whose
        commit would not be its own to wait for.
      - **How long an old pair lives**: until the last flow pinned to it ends — a request and what it
        left for after its answer, a socket's admission or open, and any timer started inside one of
        those, which carries the flow's pin with it (so at most a socket's lifetime). Then it is
        garbage. Nothing else holds it: the hub and the edge hold the holder's stand-in, not an instance.
      - **A GitHub sign-in started across a change of GitHub's app fails at the callback**: GitHub issued
        its code to the app the browser was sent to, and the new instance redeems it with the new app's
        credentials, which GitHub refuses. The person lands on the sign-in screen with that sign-in's
        failure and simply signs in again (which reason GitHub's refusal maps to was not measured against
        github.com). Sessions are not affected; only a round trip in flight at that moment.
      - **The failure mode, said, never half-swapped** (`SettingsChangeFailed`, by stage): `save`, `build`
        or `verify` — nothing saved, the old settings serve; `commit` — the database did not confirm, so it
        may or may not hold the change while the old pair serves: **restart the server**, and the start
        serves what the database holds; `retire` — the change serves, the replaced relay could not be
        closed: restart to release it. **No restart fallback is built** (§9: Q5 passed); restarting is the
        recovery the two last stages ask of the operator, in words.
   10. **Over HTTP** (*as built*, `ingress/http/setup.ts`; the contract is `API.md` §2 `/setup/*`).
      **One guard**: every route but the status, the claim and the address link takes the claim's
      cookie (`__Host-purlay_setup`, `HttpOnly; Secure; SameSite=Strict; Path=/`, a day's `Max-Age` —
      the claim's idle limit — sent again on every pass, cleared by the finish) through
      `requireSetupClaim` before it reads its body. **One answer to everybody without the claim**: closed, never claimed, claimed by another
      browser, a cookie wrong, idle or taken over — `404 SETUP_UNAVAILABLE`, the same body and headers
      and, measured over forty interleaved samples each, the same time (about a millisecond); the claim
      tells apart only a wrong code (a field's `400`) and the lock (`429 SETUP_LOCKED`, `Retry-After` to
      its end). `GET /setup/status` says `{ open, appUrl }` and nothing else: the address the server is
      configured for, which the page compares with its own origin before a code is sent (Ruling R35 —
      a browser on another origin is refused as cross-site, so the warning cannot wait for the claim;
      the request's `Host` is no guide behind a proxy that rewrites it). The browser's id is the server's
      own. **Limits per client** (`limitKeyFor`: an address, or an IPv6 /64), charged at the edge before
      the claim is looked at or a code weighed: the claim and the address link ten in fifteen minutes,
      every other step thirty, the status with the sign-in traffic, a `HEAD` as the `GET` it runs; the server's lock on wrong codes
      stays, and the limit is what keeps one client from holding it shut. A cross-site `POST` is refused
      before all of it (D-39); every answer is `no-store` and `noindex`. **Steps in turn**: a step is
      refused (`409 SETUP_STEP_REFUSED`, `out-of-order`) unless every step before it is passed —
      checked before anything is tried, so a probe out of turn calls nobody and saves nothing. The
      policy is chosen on the address's screen, so its step follows the address (`SETUP_STEPS`;
      `UX.md` §11, step 3). **Tried, then kept**: GitHub's app and the relay are saved only when the
      try worked and the caller asked to keep it (`save`), through `applySettings` — the swap of §4.9 —
      and a change that fails is said by its stage (`500 SETTINGS_CHANGE_FAILED`, or `503` while
      starting or shutting down), never its value. The relay is tried with the administrator's address
      letter; an address already verified is sent a plain test letter, since there is no link to send.
      The relay's address (`smtpUrl`) connects wherever the holder says, internal hosts included —
      the claim is the boundary (§4.4).
      **The first workspace** is made under the claim for the administrator, through the workspaces
      module with `#general`; who may make a workspace (`WORKSPACE_CREATORS`) is not asked, the claim
      being the authority and the administrator the person that rule exists to let in first; asked
      again, the one made is the answer. **The administrator** is made and signed in by the library,
      and only its `Set-Cookie` reaches the browser, never its body. **The address link**
      (`POST /setup/verify`) needs no claim, outlives the finish for the link's day, and refuses
      everything that is not a well-formed token before hashing it, as one answer
      (`404 ADMIN_LINK_NOT_FOUND`). **Nothing secret is written**: the request fields are `code`,
      `password`, `clientSecret`, `smtpUrl` and `token`, all on the logger's never-logged list, and a
      test reads every line of a whole setup for the code, the claim's token, the passwords, the
      secrets and the link.
5. **Sign-up and linking.** "Create an account" is on the site (the sign-in screen and its own screen).
   - *Open* lets anyone with GitHub or an email address make an account. *Invite-only*, the default,
     lets in only a person holding a valid invitation, by GitHub or by email alike; an invitation is the
     exception to the closed door, not a way around it.
   - *The same verified address is one account*: a GitHub sign-in whose primary, verified address is a
     verified local account's links to it. Neither side is linked while its address is unverified, and an
     address GitHub keeps private or unverified is never used. This replaces D-138 §2–§3 and the
     connect flow of D-176 (below). What D-138 §2 says of an account **GitHub made** stands: a link is
     never sent into it — the address is sent a word to sign in with GitHub — since whoever holds a
     mailbox the GitHub account no longer uses would otherwise be let in; linking runs one way, from a
     GitHub sign-in to a verified local account.
   - An account made by email link has its address verified by that link; an invitation accepted by an
     account with an unverified address is refused until it is verified. The invitation stays a link
     that whoever holds it can use (D-115); a link carries no address to match, so none is. **"Invitation
     by verified address" therefore means the *account's* address is verified, never that it matches the
     invitation's.**
   - **Invitations by email are the bearer link, sent.** The owner asked for invitations by email, and the
     prototype had address chips and a role chosen per invitee. In this form both are **dropped**: no role
     at invite time (the person joins as `member`, D-115 §3, and is promoted afterwards by D-111's rules)
     and no binding of a link to an address. Where mail is configured the message carries the same link
     through the existing mailer; otherwise the link is copied. This is the builder's call, and the owner
     is told in the report that closes this work. **Bounds and wording:** one request makes one link and
     names at most twenty addresses (repeats in any case dropped); an inviter has fifty letters a day and
     a workspace two hundred, counted in `rate_limits` so a restart hands nothing back, and a request that
     fails gives back what it took. Letters are posted after the answer, so the answer says only *queued*
     (the screen: "asked the mail server", never "sent" or "delivered"), a failed send is logged by its
     code, and the link is always answered too; whether an address is already a member is neither
     looked up nor said, since members' addresses are not shown to one another. The subject is fixed
     and the names in the body are cut and stripped of line breaks, control characters and web addresses.
   - **The exception is a passport** (Ruling R51; *as built*, `modules/workspaces/invitation-passport.ts`,
     migration 0053). On an invite-only server a newcomer asks `POST /api/invitations/passport` with the
     link's token — public, charged per client — and is given a **passport** made from a link that opens,
     refused with the preview's own `404 INVITATION_NOT_FOUND` otherwise. By GitHub the passport is a
     `__Host-purlay_invite` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`, an hour; `Lax` because it
     must survive the redirect back from github.com); by email it is for the address typed with the token,
     with no cookie, since the mail's link may be opened in another browser. Only the digest of the cookie
     or of the lower-cased address is stored. The sign-up spends it: `databaseHooks.user.create.before`
     — which GitHub's provider is never switched off ahead of (`disableSignUp` is `false` always) — lets
     the account be made on GitHub's callback with the cookie, or on the spend of an email link for
     exactly that address, and spends the passport **in the transaction that makes the account**, by one
     update that only one caller can win (`signup_disabled`, which the callback shows as `signup-closed`,
     otherwise); the sign-in by link is let to mail a newcomer's address only while a passport for it
     lives, the answer the same for every other address. One hour, once; **at most twenty live per link**,
     counted under a lock on the link's row; read against the link again at every use, so revoking,
     expiring or deleting the link's workspace takes its unspent passports with it. A passport is only for
     making an account: for an address that has one it is never read. Open servers need none; the setup's
     administrator, made outside a request, and anyone already signed up, are not asked for one. Erasure
     deletes an address's passports by the digest it read before the tombstone, and the daily sweep
     (`sweep:email-sign-ins`) a day past an hour or a use. The cookie is not cleared by the sign-up: spent,
     it opens nothing.
6. **The `.env` boundary.** What the process needs before it can serve stays in the environment:
   `DATABASE_URL`, the encryption key and the storage. What a person can set in the wizard — the
   GitHub client id and secret, mail (SMTP address and sender), who may sign up and
   `WORKSPACE_CREATORS` — moves to `server_settings`, the secrets encrypted with the existing
   encryption key and never returned (a read says `set: true`). On the **first start** of a server with
   those values in the environment they are imported **once**; after that the database is the only
   home, and a changed variable does nothing — `CONFIG.md` says so.
   *Amended 2026-10-22, as built (`modules/setup/settings.ts`):*
   - **The server's address stays in the environment.** `APP_URL` fixes the cookies' `__Host-` name,
     the origin checks and the library's base URL and trusted origins when each is built, so an address
     edited at run time would be a rewrite of all of them; the wizard's address step shows `APP_URL`
     and the callback GitHub needs (`APP_URL/auth/callback/github`), warns when the browser's own origin
     differs, and says that changing it is a deployment setting.
   - **Where GitHub is stays in the environment too**: `GITHUB_URL` and `GITHUB_API_URL`, github.com
     and its API by default, are a deployment's shape (an Enterprise Server, a stand-in on the same
     machine), not a choice in the browser. `https://`, or `http://` to the loopback alone; the
     library's own option names the authorize address, and the token, user and address calls are
     Purlay's already.
   - **Each secret is sealed bound to its column's name**, so one copied into the other column does
     not open there. *Amended 2026-10-22 (zero-env boot):* one that does not open — `ENCRYPTION_KEY`
     rotated — no longer stops the start: the server starts **in setup mode with that secret read as
     unset**, records which (`needsReentry`: `github`, `smtp`) in its runtime state for the wizard and the
     Administration page to say *this secret needs to be entered again* (**both arrive with their own
     changes; nothing exposes it over HTTP yet**, so until then an installed server whose only way in was
     the broken method is recovered by putting the old key back or by `CONFIG.md`'s SQL, not in the
     browser — setup being closed once a user exists). A truncated or corrupt ciphertext is `SealBroken`
     too (`platform/crypto.ts`: *altered*), and is treated as a rotated key. The server says in one `warn` line
     which setting and where `CONFIG.md` explains it, never a value. **Nothing is deleted or rewritten**:
     the unreadable ciphertext stays in the row until the operator saves a new value over it. A row that
     fails to decode for any other reason, or a database that fails, still stops the start. A response carries `settingsView` only: a secret as `{ set }`, the relay's
     address as its host alone — its user can be a relay's token.
   - **An SMTP address is parsed before it is kept**, as the transport will parse it
     (`platform/smtp-address.ts`), by the configuration and by the settings alike: one with an
     unescaped `#`, `/` or `?`, a broken escape, half the credentials or no host would be imported once
     and then stop every start, so it is refused before anything is written. The recovery after a
     rotated key clears the secrets **and** `imported_from_env_at`, so the next start imports again
     (`CONFIG.md`, run as written by a test).
   - **The import is one transaction** that makes the row or waits on the one another starting process
     is making, and reads it locked: two processes at once import once (measured, twenty rounds, half
     of them over a row a crashed start left unimported). A variable still set afterwards is named,
     never quoted, in one line at each start.
   - **The order of a start** keeps D-93's: listen, migrate (or, without `MIGRATE_ON_START`, wait for
     the migrations, polled), then import and read the settings and build the library and the relay
     from them (`runtimeServicesFrom`), then the library's schema check. Until the settings are read a
     request that needs the library is answered `503 DATABASE_UNAVAILABLE` — a busy server, which a
     client retries — and readiness says why. Who may make a workspace is read from the row on each
     request that asks, so it needs no rebuild.
   - **A fresh server starts with no GitHub and no mail variable at all** (Ruling R38, built as the zero-env
     boot): only the database, `ENCRYPTION_KEY`, `APP_URL` and the storage are required. `GITHUB_CLIENT_ID`
     and `GITHUB_CLIENT_SECRET` are optional seeds, **both or neither** (one without the other refuses the
     start, naming both), and empty is unset, as for every optional variable. The first import then writes
     a row **without** a GitHub app, and the wizard fills it in. With no GitHub app the library is built
     **without the provider**, and without the magic-link plugin where there is no relay: `/auth/github`
     and the library's own start of a social sign-in answer `404 ROUTE_NOT_FOUND` (the route does not exist
     until GitHub is connected; the library throws for a provider it lacks, and a 500 for a person who
     typed an address would be the wrong answer), a callback that arrives anyway is sent to the sign-in
     screen as `expired`, and `GET /api/auth/methods` says `{ github: false, email: false }`, which the
     sign-in screen reads as *this server is not set up yet*. The setup code is written to the log as it
     is for any server nobody uses (§4).
7. **Tables.** One migration adds `users.email_verified` (`BOOLEAN NOT NULL DEFAULT FALSE`),
   `accounts`, `verifications`, `rate_limits` (`key` unique, `count`, `last_request` as `BIGINT`);
   another adds `server_settings` (0049): one row of typed columns, held to one by its key — who may
   sign up (`sign_up`), the GitHub app (`github_client_id`, `github_client_secret_encrypted`), the
   relay (`smtp_url_encrypted`, `mail_from`, `smtp_allow_plaintext`), who may make a workspace
   (`workspace_creators`, `workspace_creator_logins`), and `setup_completed_at` and
   `imported_from_env_at`; typed columns rather than key/value rows, so each setting has a type, a
   default and a check in the database. The setup code's hash, the claim and the step reached have a table
   of their own (`setup_state`, 0050, one row; 0052 adds when each way in was saved after a try that
   worked), and so does the administrator's address check
   (`admin_email_verification`, 0051, one row: a digest, its account, its issue). Which migration holds which, and their DDL, belong to the migrations and then to
   `SCHEMA.md`, which a test binds to them; this record does not copy them (§6.1). One more
   (0055) is for an install from before the library, and was found by rehearsing that upgrade: it writes
   the `accounts` row the library's GitHub sign-in finds a person by for each user who has a `github_id`
   and none (without it that person is refused, `email-taken`, at the sign-in they used all along), and
   sets `email_verified` for the people who existed when 0047 ran — each proved an address then, by
   GitHub's primary verified one or a spent link — so that a sign-in link is still sent to them and an
   invitation can be accepted. It stores no token, and leaves an account made since, and an erased
   one, as they are.
8. **No data is carried over.** There is no real server data yet, so the change writes no migration of
   people's rows: development databases are rebuilt. If the owner says a server with real data exists,
   this changes and a tested move and its reverse are added first.
9. **Where the owner decided and where the builder did.**

| Decision | Whose |
|---|---|
| Better Auth, the newest stable version, plugins where they fit; read the current documentation at each step | Owner |
| Setup in the browser, a wizard with its seven steps and error guidance; *Finish* needs GitHub or email connected | Owner |
| Sign-up from the site, as Slack does; sign-in by GitHub or an email link; invitations by email | Owner; **the form of the last is the builder's**: the bearer link sent by mail, no role, no address binding (§5) |
| The administrator sets a password; everyone else signs in by link or GitHub | Owner |
| Motion between steps, switched off by *reduce motion*; the prototype is the visual reference | Owner |
| Invite-only as the default, and one choice in setup | Builder |
| A one-time setup code in the log, `/setup` closed once a user exists | Builder |
| Settings in the database, secrets encrypted, an instance built from them and swapped | Builder (the swap measured, Q5) |
| `/invite#<id>` kept, seven days | Builder |
| No migration of data | Builder (an assumption; the owner says if wrong) |
| Owner / admin / member roles and D-111 kept | Builder (kept by not using the plugin, Q4) |
| The role selector and per-address binding of invitations dropped | Builder; the owner is told |
| Who may make a workspace from the same source as `WORKSPACE_CREATORS` | Builder |
| The delivery in three parts: the record, the Better Auth core, the wizard and sign-up | Builder |
| Two kinds of administrator: the server's and a workspace's, given separately | Builder |
| Restarting the process to apply settings, if a swap were impossible | Builder; **not needed**, Q5 passed |
| Linking rules: one verified address, primary and verified GitHub address only, invitation by verified address | Builder, to be reviewed for security |
| Without mail: email controls hidden, finish needs a channel the administrator used | Builder |
| `/setup` closed on a server with users; first-start import once | Builder |
| The wizard's screens, copy and errors taken from the prototypes | Builder, from the owner's reference |

**Two details settled.** The server administrator is a column, `users.is_server_admin BOOLEAN NOT NULL
DEFAULT FALSE`, added by the migration that adds `email_verified`; the Admin plugin is **not installed**,
since it adds `role`, `banned`, `impersonatedBy` and more that creating the first administrator did not
need (Q8). The callback GitHub is given is the library's own, `/auth/callback/github`, computed from the
server address, and the wizard shows exactly that address, so nothing is hard-coded; no OAuth app is
registered before launch, so the path the product used to show (`/auth/github/callback`) is simply
replaced.

**Rejected.**
- *The Organization plugin in place of the `workspaces` module* — Q4 above.
- *Sessions as the library stores them, protected by the secret alone* — a dump plus the secret is every
  session; D-11 chose a hash for exactly this.
- *A second administrator route that leaves password sign-up open and closes it after setup* — a second
  instance in setup mode also works (Q8), but a door that is open until somebody remembers is the failure
  this is built against; the internal adapter has no window.
- *Restarting the process to apply a setting* — not needed once the holder swap passed.
- *Keeping the hand-written sign-in layer beside the library* — two places that decide who a person is.
- *Storing the secret in the settings so it can be changed in the browser* — it signs everybody out and
  puts the key beside the lock.

**Amends**, each pointed at where it is stated:
- **D-11**: sessions are the library's, hashed by our plugin; the opaque cookie in the database stays,
  and "GitHub OAuth only" is not true any more — an email link and, for the administrator and nobody
  else, a password.
- **D-31**: `better-auth` is now the library. OIDC is still not built; it waits for an operator who
  asks, and the library is what it would be added to.
- **D-115**: an invitation is accepted only by an account with a verified address; a person who has
  mail set up can send the link by email, and a send that fails says it was not sent and keeps the link
  to copy. The link, its token, its seven days and every other rule stand.
- **D-138**: signing in by link is the library's magic link, its token still in the fragment, still
  never in a path or a query, the hourly limit still five, now kept in the database. §2 and §3 are
  replaced: the same verified address is one account, and a GitHub sign-in is no longer refused
  because an email account has the address — but an account GitHub made still gets no link (§5). A new
  address gets a link only where sign-up is open (§5), and no account whose address is unverified gets
  one at all (§4.3).
- **D-155**: `WORKSPACE_CREATORS` is a server setting, imported once from the environment; the rule it
  states is unchanged.
- **D-176**: connecting GitHub to an account by a separate flow is replaced by linking on a verified
  address. An account whose GitHub address differs from its own cannot be joined to it; that was never
  built either, and is not now.

**Restated, not amended.** The guarantees of D-38, D-61, D-62 and D-121 — the callback is the one
origin's, state is verified or the callback is a CSRF endpoint, a failed sign-in comes back to the
sign-in screen with a reason — hold, and the code that replaces what carried them must show each one
tested. D-60's refusal of a revoked session on a socket, D-111 and the cross-tenant tests are untouched.

**Consequences.** Erasure (D-139, I-11) must clear `accounts` and `verifications` rows with the
rest of a person's data, and `DATA.md` lists them when their tables exist. `ENCRYPTION_KEY` now guards
settings as well as integration tokens, so rotating it invalidates both. Each later change names the
documentation page it was read from, and a difference between page and package is settled for the page.

*Amended 2026-10-23 (the letter again):* the administrator's letter can be sent again from the e-mail
step — `{ resend: true, locale }` on `/setup/smtp` — **through the relay already kept**, read on the
server (`readSettingsToBoot`), because the relay's address is never shown to a browser a second time
and a person whose first letter never came cannot be asked to type it, password and all. Refused
`out-of-order` before the mail step is reached and while no relay is kept. Considered and rejected: a
resend through the *serving* mailer, which would need failure reasons of its own — the probe already has
the closed set, the wizard already says each, and the same path gives the same words.

The link is one row, and a letter replaces it before it is known to have gone, so **any letter the relay
does not take puts the link it replaced back** — a resend, and equally a *new* relay tried and refused
(which, before, left the first letter's link dead). Three rules make that safe, each found by someone
who did not write it: it is put back **only while the row still holds the link this letter issued**
(`restoreAdminVerification` takes the digest; a later issue, or a link followed and spent, is not undone);
**letters go one at a time for a claim** (`oneLetterAtATime`: two at once each read the other's undelivered
link as the one to put back, and the delivered letter's link was lost — one process, since a setup is on
one node); and a put-back that itself fails is logged and says nothing more, so the relay's answer is
still the answer. *Accepted:* a try that ends at its deadline may have handed the letter over all the
same, and the earlier link is put back regardless — the common failure is a relay that is down, where the
earlier letter is the only one there is; the letter that arrives late then carries a link that no longer
opens, and another send makes it right. The same change makes the wizard say a sender that carries a name
— refused since the try was built — under its field, in its own words.

**Cost of reversing.** The library, its configuration and plugin, the migrations (dropping the new
tables and the column; `sessions` keeps its shape throughout), the wizard and `/setup`, and the
`server_settings` import. A reversal returns to the code D-11, D-38 and D-138 describe; the
`workspaces` module was never touched, which is what makes it possible.

### D-180. Navigation follows the theme: a light neutral in the light theme, the dark navy in the dark — changes D-118

**Decided (the owner, 2026-10-23).** D-118 drew the rail and the sidebar in dark navy in *both* themes. The
owner, using the product, asked for the left menu to be light in the light theme, and for the dark theme to
keep the tones it has. So the `nav-*` tokens now have a light value of their own (`nav-rail` `#e9ecf5`,
`nav-surface` `#f3f5fa`, `nav-hover` `#dfe3f1`, `nav-border` `#d6dbeb`, `nav-ink` `#1b1c2e`,
`nav-ink-muted` `#555977`) and the dark values are unchanged; the shell no longer forces `data-theme="dark"`
on the rail and the sidebar, so every shared control inside them speaks the inks of the theme it is in, and
`pairs.ts` computes the navigation's pairs in both themes like any other (`inNav` no longer pins the dark one).

**What it cost, and why.** A light navigation that is told apart from the white conversation by tone alone
is a narrow band, and the contrast pairs are computed against it: `accent-text` on `nav-hover` and
`ink-subtle` on the rail would have failed at their old light values. Three light values moved, each a small
step, each helping the rest of the screen too: `accent-text` `#2563eb` → `#1d4ed8` (links and mentions
read at 6.7:1 on white instead of 4.8:1), `ink-subtle` `#6b6b73` → `#63636e`, and `focus-ring` `#3b82f6` →
the accent `#2563eb` (the ring reads at 5.2:1 on white instead of 3.7:1). The accent fill, the dark theme and
every other token are untouched.

**What stays dark.** The full-screen image viewer: a picture is judged on a dark ground, so it sets
`data-theme="dark"` on its own overlay and content in either theme.

**Considered and rejected.** Keeping D-118 and only softening the navy (the owner asked for a light
navigation); tinting the sidebar and leaving the rail dark (two tones that match neither theme); loosening
the contrast pairs to keep the old light values (the pairs are the gate, D-97 §5).

**Cost of reversing.** The six light `nav-*` values, the three moved light values, the two lines in the shell
that no longer force the theme and `inNav`'s pin: tokens and one file each. No contract, route or key.

### D-181. The composer's formatting row, emoji picker and preview — extends D-110 (keys amended by D-188)

**Decided (the owner, 2026-10-23).** The owner called the message box "very weak" next to the competition's.
D-110 allowed three inserting buttons (bold, code block, mention); the renderer draws far more than that
(`packages/markdown/src/tree.ts`: bold, italic, strike, inline code, link, bulleted and numbered lists,
quote, code, tables). So the box now has **a formatting row above the text** with a button for every
construct the renderer draws (bold, italic, strike, link, bulleted list, numbered list, quote, inline code,
code block), **an emoji picker**, and **a preview toggle**. Each stays inside D-110's line: a button only
*inserts markdown* (`insertMarkdown`, pure and tested), the box stays a plain textarea, and what is sent is
the text. Nothing here is a second editor.

- **Keys do what the buttons do** (`formatKey`, one answer for both): `Mod+B`, `Mod+I`, `Mod+Shift+X` strike,
  `Mod+E` inline code, `Mod+Shift+U` link, `Mod+Shift+7` / `8` / `9` numbered list / bullets / quote,
  `Mod+Shift+P` preview. A button with a key names it in its tooltip; the shortcuts reference lists them.
- **`Shift+Enter` in a list or a quote carries it on**, and an empty item ends it (`continueList`); outside
  one it is the new line it always was. `Enter` still sends.
- **The emoji picker** is a grid on the menu primitive (four groups of sixteen: faces, hands and people,
  work, symbols), each tile named by its emoji, `←` `→` and `↑` `↓` moving through it. The emoji is text
  written at the caret. It is curated, not complete: a searchable list of thousands is a product of its
  own, and the operating system's emoji keyboard is one keystroke away for anyone who wants all of them.
- **The preview** draws the draft with the same `renderContent` a sent message uses and hides the textarea
  (it is not unmounted: the draft, the caret and the undo stack stay). It is a look, never a copy; Send
  works while it is open.
- A thread's box has the same row (D-164's parity).

**Considered and rejected.** A WYSIWYG editor (PRD §4.1 fixes plain textarea and GFM); a full emoji dataset
with search (cost out of proportion to what a team uses, and the system keyboard exists); a hidden toolbar
behind a "Aa" toggle (formatting that has to be discovered is not formatting people use); a preview in a
side panel (the width the thread panel needs).

**Cost of reversing.** `emoji-picker.tsx`, the row and the preview in `composer.tsx`, `insertMarkdown`,
`continueList` and `formatKey` in `composer-text.ts`, and the `MenuTiles` `grid` mode. No contract, route,
key or stored data: a draft is the same text it always was.

### D-182. One check box and one radio, the browser's input drawn in tokens

**Decided (the owner, 2026-10-23).** Walking the dark theme, the new-channel dialog's "Private" box was the
operating system's own: a light grey square in a dark window, a different size in each browser, sitting
above the baseline of its label. Eight screens drew their own native `<input type="checkbox">` or
`type="radio"`. There is now `ui/checkbox.tsx` — `Checkbox` and `Radio` — and the screens use it.

It stays the browser's input (`appearance-none`, drawn by hand), so the keyboard, the wrapping label, forms
and the screen reader are the platform's and nothing is reimplemented; the tick and the dot are shown by
`peer-checked`, so the screen can only show what the input holds. The edge is `border-strong`, which the
contrast gate holds to 3:1; the keyboard ring is the global one, inset over the edge (one line, not two).
`ui/checkbox.test.tsx` scans the screens and fails on a native check box or radio outside the primitive.

**Considered and rejected.** `accent-color` on the native input (still a light box in the dark theme and
sized by the browser); a Radix checkbox (a button with a role: it loses the form, the label and the
platform's keys, and adds a dependency for what one input does).

**Cost of reversing.** One file and eight call sites; no contract, route or key.

### D-183. The dark theme is one family: the navigation's indigo, in layers — now Midnight (D-184)

**Decided (the owner, 2026-10-23), amends D-180's "dark keeps the navigation's tones".** The dark theme's
content was a neutral near-black (`#0f0f11`, `#161618`) beside a navigation in indigo-navy (`#16162b`,
`#22223f`): two palettes side by side. The owner asked for the whole dark theme in the navigation's tone,
clean and in the manner of Apple's dark mode: deep, calm, layered, no hard edges. Every dark surface, border
and text token now sits in the navigation's hue: the window `#12122a`, the content `#1a1a34`, a raised
fill `#25253f`, a hover `#20203c`, hairlines `#2d2d4b`, a control's edge `#7d7da0`, text `#f1f1f8` /
`#a9a9c6` / `#9696b6`; the avatar tints moved from warm browns to the same family. The light theme and the
navigation's own tokens are unchanged.

The contrast pairs are the gate and were not touched: every pair passes at the new values (`bun run tokens:check`).

**Considered and rejected.** A neutral grey dark with only the navigation in indigo (what it was: the
mismatch the owner saw); a pure black "OLED" ground (harsh against the indigo navigation).

**Cost of reversing.** Eleven dark values in `tokens.json` and the avatar tints; generated files follow.

### D-184. Dark is black, and the indigo is a theme of its own, Midnight

**Decided (the owner, 2026-10-24), refines D-183.** D-183 put the whole dark theme in the navigation's
indigo. The owner asked for that indigo to be a theme called Midnight, and for the default dark to be a
black one. So there are three themes — `dark`, `light`, `midnight` — and four choices (`system`, `light`,
`dark`, `midnight`):

- **Dark** (the default dark, and what `system` gives when the device is dark) is neutral black in the
  manner of Apple's dark mode: window `#050506`, content `#0e0e10`, a raised fill `#1c1c1f`, hairlines
  `#252528`, text `#f5f5f7` / `#a9a9b1` / `#9696a0`, a black navigation (rail `#000000`, sidebar `#0d0d0f`),
  and quiet, neutral avatar tints.
- **Midnight** is D-183's indigo exactly as it was decided (every dark token and the navigation in the one
  hue, in layers) and is chosen from Settings → Preferences; the operating system has no word for it, so
  `system` never gives it.
- **Light** is unchanged.

Every colour and shadow has a value in each of the three, a theme never inherits (the token file refuses
one that does), and the contrast pairs are computed in all three; Midnight is told to the platform as a dark
`color-scheme`. The choice is the same `data-theme` switch and the same per-device storage as before; the
script that runs before first paint knows `midnight`, so it does not flash black first.

**Considered and rejected.** Keeping the indigo as the only dark (what D-183 made, and the owner did not
want as the default); a fourth, "OLED" theme beside it (black is the default, one is enough); reading
Midnight from the device (no such setting exists).

**Cost of reversing.** One theme entry and its values in `tokens.json`, three lines in `theme.ts` and
`theme-init.js`, a glyph, two strings, and the gallery's third frame. No contract, route or stored data
beyond the device's `purlay.theme`.

### D-185. `main` is the one branch, a merge deploys, and a release is a version someone chose

**Decided (the owner, 2026-10-26), builds on D-73, D-86, D-92, D-94 and D-95.** How a change reaches the
team's server, and what a release is, were a list of commands run by hand: build on the server (the Mac
cannot, D-92), copy the source, change `PURLAY_IMAGE`, `up -d`, look.
**Amended 2026-10-27:** use the image published by CI rather than rebuilding on production; keep the
Docker and deployment files in this repository. First installation is in `docs/DEPLOY.md`. Now:

- **One long-lived branch.** Work happens on `feat/`, `fix/`, `chore/`, `refactor/` and `docs/` branches and
  reaches `main` by a pull request that passes the required checks. There is no `develop`.
- **A merge deploys.** Every commit that lands on `main` is deployed to the server by the `deploy`
  workflow after the `image` workflow succeeds for a push to this repository's `main`. A **self-hosted
  runner on that server** runs `scripts/deploy.sh`: pull the published full-commit tag from GHCR, resolve
  and pin its digest, verify the revision label, smoke-test, back up, switch, and check that the API and
  scheduler run *this commit*. No application build runs on production. The backup is taken after the
  pull and smoke test, so an image failure costs no backup and the backup is close to the switch. One deploy at
  a time, and one in progress is never cancelled. The runner only asks GitHub for work; nothing reaches the
  server from outside. A hand-started run only runs from `main`.
- **A failure goes back the way `ARCHITECTURE.md` says, and no other.** Before the switch nothing has changed
  and nothing is restored. After it, the migration may have run and an older image does not start on a
  newer schema (D-86), so the way back is **the backup taken a minute earlier**: stop the API, restore the
  database alone (`--no-bucket`, D-95), put the old image and release back, start. What was written since the
  backup is what a rollback costs. A deploy told to stop (a cancelled job, a timeout) goes back the same way; one
  that is killed outright leaves a marker, and the next deploy refuses to start until someone has looked. A
  rollback that fails too exits 2 and names the backup.
- **A release is a version, and merging a pull request makes it.** The root `package.json`'s `version` is its
  one home. `bun run release -- minor` opens a pull request that sets it and moves what is under
  *Unreleased* into `docs/changelog/v<x.y.z>.md`; when that merges, the deploy is followed by a tag and a
  GitHub Release (`scripts/release-publish.sh`). A merge that leaves the version alone deploys and releases
  nothing: numbers mark moments the owner chose, they are not a count of merges. A hand-started deploy of an
  earlier commit on `main` tags nothing; undoing migrations requires the database restore procedure.
  The release job runs on a GitHub-hosted runner and checks out exactly the deployed commit.
- **The changelog is in one shape.** Keep a Changelog: **Added, Changed, Deprecated, Removed, Fixed, Security**,
  one line per bullet, with a bold area and the decision in parentheses, so that a person scans a release in two
  minutes instead of reading a transcript. `changes.md` says how to write an entry; `scripts/changelog.test.ts`
  holds the files to it and `bun run release` refuses an Unreleased that is not. What was written before the
  first release, in prose, is kept as it was (`docs/changelog/pre-0.1.0.md`).
- **What the runner may run is held by a test.** The server holds the production database, so the workflow
  that runs there starts only after a successful image publication from `main` or by hand, never on a
  pull request. Deploy has `packages: read`, and only the release job may write (`scripts/deploy-workflow.test.ts`).

**Considered and rejected.**

- *A `develop` branch (GitFlow).* It answers a question this product does not ask — several versions
  supported at once — and costs two merges and two CI runs per change, a branch that drifts from `main`, and a
  third path for a fix. If a stop before production is wanted, an approval on the deploy is cheaper than a
  branch.
- *A version number per merge* (release-please, semantic-release). With one server and no outside users, it is
  a number nobody chose, and it fights a changelog written by hand under *Unreleased*.
- *Deploying only on a tag.* One environment and a team using it is the feedback this phase exists for (S-1);
  waiting for a tag delays it for no safety the checks and the backup do not already give.
- *GitHub's hosted runners for the deploy.* They cannot reach a server that accepts nothing from outside, and
  the pipeline has been unavailable for billing more than once.
- *Running the old image to go back.* It refuses the newer schema (D-86); this was reproduced, not reasoned.
- *Publishing to GHCR as part of this.* `image.yml` and `scripts/release-image.sh` (D-92) stay as they are: that
  is how a self-hoster gets an image, and nobody is waiting on it for the team's server.

**Accepted.** A migration that passes the smoke test and the health check but is wrong in what it does is
not caught; the backup is what is left. The site is unavailable for as long as a migration runs (about 18 s
for a 15 s one, `ARCHITECTURE.md`), and every service is recreated when a file the stack mounts changes. A runner
on the production host is the highest-value thing to protect in the pipeline. GitHub keeps one run waiting behind
the one in progress, so merges that queue behind a deploy are deployed as the last of them (each commit contains
the ones before it); a release whose merge was skipped this way is tagged at the commit that was deployed. Entries
merged after a release pull request was opened conflict with it in `changes.md`: run `bun run release` again.

**Cost of reversing.** One workflow, three scripts and their tests. Going back to deploying by hand is
stopping the runner; the runbook in `ARCHITECTURE.md` is unchanged.

### D-186. macOS gets a native Swift client in its own repository, drawn in Liquid Glass — supersedes D-51's "not planned"

**Amended 2026-10-28 (#789).** The public client handshake carries optional additive capability
flags; `API.md` §2 owns their names and interpretation. A known flag exactly `true` advertises API
support, never permission; absent/unknown capabilities remain compatible with older peers. An open
optional object was chosen over version inference: additions do not bump the wire contract (D-58),
and a minimum-client gate would unnecessarily reject an older app for a new optional query. The
capability describes implemented behavior, not a rollout promise. Release versions keep D-185's
meaning, independently of these flags.

**Decided (the owner, 2026-10-26), supersedes the native-client clause of D-51 and the Tauri shell of D-14.**
D-51 chose one wrapped client and named its own reversal: "paying customers asking for it, with numbers". That
trigger has not fired. The owner has chosen to go native anyway, for the platform's own feel and performance, and
this decision records that as a choice made against D-51's reasoning, not as a measurement that overturned it.

- **A native application for macOS, written in Swift.** SwiftUI is the default; AppKit is used where SwiftUI is
  the wrong tool — the message feed's scrolling and the composer's text editing are the two expected places, and
  each such choice is recorded where it is made. The interface follows Apple's current design language, Liquid
  Glass, by using the system's own controls, toolbars, sidebars and materials rather than drawing glass by hand,
  and follows the system's accessibility settings (reduced transparency, increased contrast, reduced motion). It
  needs the macOS release that introduced Liquid Glass; older releases are not supported.
- **Its own repository, `purlay-macos`**, under the same owner, open source under the same licence and contributor
  agreement as this one (D-1). It is not a directory in this repository: this one is built, linted and verified
  with Bun tooling an Xcode project would fight, and the Swift client needs its own pipeline on macOS runners with
  signing and notarization, which must not block `main` here.
- **Distributed outside the App Store**: a signed, notarized download updated in place. Store review and the
  AGPL do not sit together, and a release channel the owner does not control is a cost D-51 already counted.
- **The contract keeps one home.** `packages/types` stays the owner of models, frames, shapes and error codes
  (`OVERVIEW.md`). This repository publishes a machine-readable export of it, versioned with the server; the Swift
  repository pins one version of that export, generates its `Codable` types from it and never writes a wire type
  by hand. A contract test runs the client against a real server of the pinned version, so drift is a red build
  rather than a decoding error in someone's app.
- **The visual values keep one home too.** `packages/tokens/tokens.json` owns colour, spacing and type (D-97). The
  Swift client generates its content-area values from it. System chrome — window, toolbar, sidebar, controls — is
  the system's and is not re-skinned.
- **Behaviour is `UX.md`'s.** The native client implements the same layout, thread interaction, keyboard model and
  states. Where the platform's convention is better, the departure is written into `UX.md` in the change that
  makes it; the web client is not the only place behaviour is specified.
- **The server no longer ships one client with it.** The app is installed by people and updated on its own
  schedule, so it will meet servers newer than itself. Responses are already additive (D-58) and the Swift client
  ignores fields it does not know; what it must also have is a way to declare its version and be told to update
  when a server needs a newer one. That mechanism is part of the plan, and is not built yet.

**What stays as D-51 decided.** Mobile is the installable web application. Windows and Linux use the web client.
No native iOS client is planned; a macOS app in SwiftUI makes one cheaper later, which is not a reason to start
it. The Tauri shell is dropped rather than built beside the native one: two desktop clients on the platform that
has one of them native is the "three mediocre clients" D-51 warned about, and D-2 says subtract.

**Considered and rejected.**

- *A directory in this repository (`apps/macos`).* One place for the contract, but it puts an Xcode project under
  `verify`, `knip`, `check:pr` and `mutate`, and a macOS pipeline under a CI that has been unavailable for billing
  more than once. The generated export gives the same single home for the contract without the coupling.
- *The Tauri shell of D-14.* It was the cheaper road and is the road the owner declined: a web view in a native
  frame is what this decision exists to leave.
- *Mac Catalyst or a cross-platform toolkit.* They give a native binary and not a native feel, which is the
  property being bought.
- *The Mac App Store.* See above.

**Accepted.** Everything D-51 listed, now incurred: a second design system, a second release channel, notarization,
platform expertise and permanent maintenance, and an Apple Developer account. Two clients to keep behaviourally
equal, held by `UX.md` and the contract test rather than by sharing code. Features land on the web first, as the
reference, and reach the app after. The app's first release is smaller than the web client by design, and its
contents are the plan's to decide.

**Open.** Whether the Apple Developer account exists and in whose name, and the first release's screens — the owner's,
and neither blocks the design. **How the app signs in** is not open: a browser session is a cookie
(`ARCHITECTURE.md` §7.1), so the app signs in once through the system browser and is handed a session of its own, by a
one-time code bound to a secret only the app holds. That handoff is a decision of its own, in the server work the app
waits for. Its parts were run — the system browser's session delivering a custom-scheme callback, the app holding the
session as an explicit `Cookie` header, the login keychain under the sandbox — and what was not run (other default
browsers, the GitHub round trip, the emailed link in a second browser) is checked against a real server before the
sign-in milestone closes.

**Reverses if** the app is not kept up to the web client's behaviour for two consecutive releases — then it is
archived and the web client is the product, which D-51 was.

### D-187. One edge again: every message hangs from the left, in no bubble — reverses D-119

**Reverses D-119 and amends D-150 §1, D-177 and `UX.md` §3, §4.1 and §4.2.** The owner's audit of the interface
(2026-10-26): messages are to sit on the left "like Slack", everywhere, direct messages included. D-119 had made the
opposite trade at the owner's request and recorded what it cost; this is the owner making the first trade again, and
the cost D-119 named — a bubble in a bubble around a code block — goes with it.

**Decided.**

1. **One edge.** A message by anyone, you included, is drawn as everyone else's was: the avatar in its fixed column,
   the display name and the time over the first message of a group, the words beside the avatar's column. The
   row has no `flex-row-reverse` and no `data-outgoing`; `data-own` marks it for a test and for nothing visual.
2. **No bubble.** The message body is a block without a fill, a radius or a border (`data-body`). The tint that
   told your side from theirs (`accent-subtle` against `surface-200`) is not needed with one side, and a fill under
   every message made a code block, a table and a quote three boxes deep. A failed send keeps its danger edge; a
   mention of you still fills your own `@name` (D-119 §5); a resolved thread's root is still muted.
3. **The bar of actions is at the row's top-right for every message** (the corner D-150 chose for other people's),
   and a thread's status line sits under the words from the left edge, as D-177 had it for theirs.
4. **The row is not made of one shape any more**, so there is no five-sixths cap: a line is as long as the feed.
   Long lines of prose are the feed's width, as in Slack; the composer and the feed already share it (D-177).

**Rejected.** *Keeping the bubbles and only moving yours to the left* — the two fills would then tell apart nothing
the name does not, and the box-in-a-box remains. *Keeping the right edge on a phone* — the second edge was a
feature of the whole screen, not of a width.

**Cost of reversing:** `message-row.tsx`, `message-actions.tsx`, `thread-summary.tsx`, their tests, `polish.e2e.ts`
and this paragraph; D-119's reasoning for the two edges is intact above for whoever wants it back. No contract,
route, keyboard path or required state depends on which side a message is drawn on.

### D-188. Writing and reading a message: Enter by context, code that is seen, and one grammar for an edge

**Amends D-110, D-181 and `UX.md` §3, §5.** The owner's audit of the interface (2026-10-26) asked for the
composer's code controls to be checked, Markdown to read properly, the send keys to be tested, code to be
formatted by its type, and the borders to stop disagreeing.

**Decided.**

1. **Enter is one function, `enterAction`, and the composer and the editor of a sent message both ask it.** Shift+Enter
   is a new line (and carries a list or a quote on); Ctrl/Meta+Enter sends from anywhere; a plain Enter sends, except
   inside a code fence that is still open, where it is a new line. The editor of a sent message did not know the fence:
   Enter inside a block of code saved the half-edited message. It now also takes the formatting keys and Shift+Enter's
   list continuation. **On a device that is only touch** (`(pointer: coarse) and (hover: none)`) a plain Enter is a new
   line, since a phone's keyboard has no Shift+Enter and the composer had no way to write a second line there; Send is
   the button, and Ctrl/Meta+Enter still sends from an attached keyboard. While the caret is inside an open fence the hint under the box names the key that sends
   (`Ctrl+Enter` / `⌘↵`) rather than saying Enter does, and so does the editor's, which names the key that saves; the
   composition (IME) rule is one hook, `composition.ts`, for both boxes — the editor had none, and an IME's confirming
   Enter saved a half-composed edit.
2. **A code block has a key**: Ctrl/Meta+Alt+Shift+C, read by the key's position (Alt turns C into `ç` on a Mac), shown
   in the tooltip of the button. Plain Ctrl+Shift+C is the browser's inspector and a page cannot have it. **A backtick
   typed over a selection wraps it** in inline code instead of replacing it; Ctrl+Alt is let through, as it is AltGr on
   Windows layouts that type a backtick. The same care applies to the code chord: a chord the browser reports as `AltGraph`
   is a letter on layouts such as the Polish programmer's, and is left to type it.
3. **A fence names its language, and the language is coloured.** The grammars grew from 14 to 33 (Java, C, C++, C#,
   PHP, Ruby, Kotlin, Swift, Dockerfile, TOML, XML, GraphQL, SCSS, Lua, INI, PowerShell, Makefile, nginx, protobuf, and their
   usual spellings: `c++`, `c#`, `rb`, `kt`, `gql`, `ps1`), each still a chunk loaded on first use, so the initial
   bundle is unchanged. A language that is not known stays plain, as before. The colour was there but could not be seen:
   `syntax-keyword` was `#2c2c54` in the light theme and `#c4c4ee` in the dark — the ink, within a shade — so a keyword
   looked like any other word. It is now a violet (`#6d28d9` / `#c4a7ff`), passing the same contrast pairs.
4. **One grammar for an edge**, held by `styles.test.ts`. At rest an edge is `border-subtle` (a card, a divider) or
   `border-strong` (a control the line is the only cue for); **hover changes the fill, never the line**; selected is
   `accent`; a fault is `danger`; focus is the one ring. The outliers were a reaction chip and a checkbox whose edge
   went to the dark ink on hover, the jump field's edge going to the dark navigation ink, and the channel details tabs
   underlining the selected tab in ink (black) where every other selection is the accent. Two hover edges remain, named
   in the test: the primary button's (`accent` to `accent-hover`, the same hue a step on) and the avatar ring in the
   sidebar, which is the sidebar's own ground.

**Rejected.** *A second key for "send" inside a fence only* — Ctrl+Enter already sends everywhere; the hint now says so.
*Highlighting with no language by guessing it* — a guess that is sometimes wrong colours a message wrongly, and the
language costs the writer three characters.

**Cost of reversing:** `enterAction`, `typedWrap` and the `formatKey` chord are in `composer-text.ts` with their tests;
the grammars are lines in `highlight.ts`; the colours are two values in `tokens.json`; the border test is one block.

### D-189. A heading in a message has a size — amends D-101 §3

**Amends D-101 §3.** D-101 drew every heading as bold text at the body's size, on the reasoning that a heading in a
conversation is not an outline. The owner wrote Markdown in the composer and found the `#` lines no different from
the paragraph under them (2026-10-26): a heading nobody can tell from bold text is a heading that does not work.

**Decided.** The narrowed tree keeps the heading's level, clamped to 1–3 (`level` on the `heading` block, additive: the
server's metadata, plain-text and prose readers ignore it). `#` is drawn at the `display` size, `##` at `title`, and
`###` to `######` at `heading` — the type scale has three sizes above the body, so a fourth level has none left to be.
All are semibold. They remain paragraphs, not heading elements: nothing in a message joins the page's outline, a
screen reader's heading list is the screen's and not the conversation's, and a message cannot take `h1` from the page.

**Rejected.** *Real `h1`–`h6` elements* — a hostile or careless `# x` in a feed of fifty would reorder the page's
structure for assistive technology. *Keeping the body size and relying on weight* — what the owner saw not working.

**Cost of reversing:** one field on one node, one branch in `render-content.tsx`, and their tests.

---

### D-190. A server tells a client what it is, and refuses one it can no longer serve — builds on D-186

**Context.** A browser client is served by the server it talks to, so it can never be too old. The macOS
application (D-186) is installed by people and updated on its own schedule, and a server is upgraded on its
operator's: the two meet in every combination. Nothing said what each side speaks, and the one thing a server
may have to do — stop serving an application that can no longer work, because a release was broken or a
contract changed — had no word the application could act on.

**Decided.**

- **`GET /api/client`**, public and uncached, answers `ClientInfo`: the server's version (the root manifest's, D-185),
  `contractVersion`, the canonical `appUrl`, the minimum an installed client must meet, and `AuthMethods` — so one
  call draws the sign-in screen. `appUrl` is there because the socket's `Origin` check is an equality with it
  (D-39): a client learns the one string that will be accepted from the server, never from what a person typed.
- **`CONTRACT_VERSION`** in `@purlay/types` is the wire contract's version. It is bumped when a client built
  against the old contract would misbehave against the new server — a field removed or retyped, a meaning
  changed, a frame removed — and **not** for an addition (responses may gain fields, D-58). A bump is a one-way
  door and is decided in this document before it is a number.
- **`X-Purlay-Client: macos/<semver> contract/<n>`**, sent on every request and on the socket upgrade. A
  header that is not exactly that shape — and a browser sends none — is no client, and is served: a refusal
  that fires on a typo locks a person out of their own server.
- **`426 CLIENT_TOO_OLD`** when the operator has set a minimum (`MIN_CLIENT_MACOS_CONTRACT`,
  `MIN_CLIENT_MACOS_VERSION`, `MACOS_DOWNLOAD_URL`; none set is no limit, the default) and the client is below
  either. Answered at the edge before the body is read or a session looked up, with `Upgrade: purlay-client` as
  the status requires and `details` saying what is still served and where to get it; to the socket upgrade as the
  status, not as a socket that closes for a reason a client must guess. Never to `GET /api/client` and `/health*`,
  however the path is spelled: they are how a client learns to update.
- **A minimum above this server's own contract is refused at boot**: it would refuse every client, and the first
  person to sign in would be the one to find out. The download address must be `https://`.

**Rejected.**

- *A version in the URL* (`/api/v1`). Every route would be spelled twice for a number most deployments never move.
- *Refusing a header that is not the shape.* A typo, a proxy that rewrites headers, a future platform name: each
  would lock someone out, for the sake of a check nothing needs (this is not a security boundary).
- *The server's commit in the answer.* The process does not carry it — the image does, as a label — and a field the
  server cannot fill honestly is worse than none.
- *A per-request check by the handler.* Every handler would carry it, one would forget, and the refusal would come
  after a session lookup and a body read.

**Accepted.** The application and the web are served by contracts that are the same number today and will not be
forever; the minimum is an operator's lever, not an automatic one. An older application against a newer server
relies on responses being additive and on its own tolerance of what it does not know.

**Reverses if** the only installed client is withdrawn (D-186's reversal): then the header, the route and the
three variables are removed and nothing else moves.

---

### D-191. The native application is handed a session of its own by a one-time code bound to a secret it keeps — builds on D-186, D-179

**Context.** A browser session is a cookie; an application is not a browser, and cannot take one. D-179 gave
identity one owner — GitHub, an emailed link, a password, the setup — and a form of the application's own would be
a second place for it to be decided, with its own throttles and its own mistakes. D-186 left *how the app signs
in* as the one open question.

**Decided.** The person signs in where sign-in already is, in the system browser, and the server then gives the
application a session of its own:

1. The application makes a **verifier** (32 random bytes, base64url), keeps it, and opens
   `<server>/sign-in/native?challenge=…&state=…`, where the challenge is the SHA-256 of the verifier and the
   state is its own word, to be handed back.
2. The page asks the person — naming the account, its address and the server, with *Sign out of this browser, use
   another* beside *Authorize* — and only a click calls **`POST /api/native/authorize`**, which needs a session and
   is refused from any other site by D-80's `Origin` rule. It makes a **code** (32 random bytes, hex, digest stored,
   two minutes) bound to the challenge, and answers `purlay://auth?code=…&state=…`. **The address is the server's
   own and fixed**; the request names none, so there is no open redirect to find. At most five codes are live for a
   person; a sixth makes the oldest room, so a retry never locks anyone out.
3. The application — which has no session yet — calls the public **`POST /api/native/token`** with the code, the
   verifier and a device name. A session is minted for the person who authorised, **a session of its own**, labelled
   `Purlay for macOS/<version> (<device>)`, answered as the usual cookie, which the application keeps and sends as
   an explicit `Cookie` header; it also sends `Origin: <appUrl>` on the socket upgrade, since D-39's check is an
   equality an installed client must meet itself. The session lasts `SESSION_TTL_DAYS` and is never slid
   forward, as every session (`ARCHITECTURE.md` §7.1).
4. **The code is of no use without the verifier**, which never left the application: the code travels in a URL on
   the person's own machine, where a log, a screen share or another application registered for the scheme may read
   it. **One refusal**, `404 NATIVE_CODE_NOT_FOUND`, the same bytes for a code nobody made, one spent, expired or
   burnt, one whose person was erased, and a wrong verifier (the stance of `SIGN_IN_LINK_NOT_FOUND`, D-138). **A wrong
   verifier is counted and committed with its refusal, and does not burn the code until the fifth** — a code
   someone has seen must not be a way to take it from the person it was made for; five guesses at a 256-bit value is
   what a stranger gets. Charged to the client's address before the code is looked at (ten at once, then one every
   ninety seconds; provisional, O-4).
5. **Carried through every way of signing in.** The page keeps `{challenge, state}` in the tab's `sessionStorage`
   across the GitHub round trip and a password sign-in, as D-115 keeps an invitation — the sign-in has no return
   path, and D-115 rejected one as an open redirect. The emailed link may open in another browser, so
   `POST /auth/email` takes an optional `native` pair and the letter carries it in the link's **fragment** beside
   the token, as an invitation the tab holds already is. Then the redirect reaches the application through the
   operating system's registration of `purlay://` and not through the session that was waiting; the application
   accepts it only while an attempt is pending and only with that attempt's `state`.

**Limits, stated** (found in a review of the change, written here so they are not discovered again):

- A custom scheme cannot prove which application is asking. Any application on the Mac may register `purlay://`;
  the challenge protects the code on its way, not the identity of whoever asked. The consent page therefore names
  what the person can check — the account, the address, the server — and says plainly that it signs the
  application in as that account.
- The sixth authorisation inside two minutes makes the oldest code room without a word: the application holding it
  gets the one refusal and starts again. A retry never locks anyone out; a displaced code is a cause of *does not
  open*.
- The address's budget is shared by whoever shares the address (and, without `TRUST_PROXY`, the whole proxy): ten
  spent by another client leaves the next to wait up to ninety seconds inside a code's two minutes. The
  application treats a `429` as *start again*. The handshake shares the sign-in budget on purpose (D-186): what
  could be spent through it can be spent through `/auth/` already.
- A refusal is written to the log with its reason and nothing else — a wrong verifier and a burnt code as warnings,
  the rest as information — so a guessing campaign is visible, and never the code, its digest, the verifier or the
  person.
- A device name holds none of the invisible characters that change how text reads — zero-width and directional
  marks, embeddings, overrides, isolates, the byte-order mark — so it cannot be made to look like another device.

**Rejected.**

- *A sign-in form of the application's own.* A second UI over D-179's throttles and policies; password managers,
  passkeys and the GitHub flow would each be rebuilt.
- *An embedded web view.* No sign-in shared with the person's browser, and a login page the application draws the
  frame of.
- *A bearer token in the response body.* `API.md` §1 says there is none: one credential kind, which a cookie is.
  The application keeps the cookie's value and sends it back as a header it sets itself — measured with
  `URLSession` on the platform, over HTTP and on the socket upgrade — rather than a second scheme the server would
  have to learn to resolve.
- *A loopback listener* (RFC 8252 §7.3). It needs the entitlement to listen, and a port another process can take.
- *Revoking the session a spent code minted when the code is shown again.* It was in the first design and was
  taken out: with the verifier, nobody but the application can mint a second one, so it catches only an event that
  needs the verifier to have leaked; and it turns a retry that raced its own answer — the same request sent twice —
  into the loss of the sign-in just made, which is the failure it was meant to prevent.
- *A `next` parameter through every sign-in method.* D-115 §8.

**Accepted.** A person signs in again every `SESSION_TTL_DAYS`. The web has no list of devices (*Sessions &
account* has only *Sign out everywhere*), so the application's session is ended there by that button and from the
application itself; the label is in `sessions.user_agent` for an operator. An application that loses the answer to
`token` starts the sign-in again. An emailed link opened in a browser that is not the default one still reaches
the application, but only if the operating system hands the scheme over.

**Reverses if** a scoped, revocable credential for non-browser clients is built (a device list and per-device
tokens): then this is replaced by it, and `native_authorizations` is dropped by a later migration.

*Amended by D-193:* the device list exists, so a session this handoff made is named and ended from any other
device; the credential is still the session.

### D-192. A client that is not the browser's own is generated from a bundle the server publishes with each release — builds on D-186, D-190

**Context.** The macOS application (D-186) lives in its own repository and cannot import `@purlay/types`. What it
has to agree with the server on is not a few shapes: the schemas, the routes, the limits, the error codes and the
status each is answered with, how a message id is made, what a message's markdown comes to, the colours. Copying
them by hand makes a second home for each, which `CONTRIBUTING.md` §6.1 forbids and which goes stale without a
sound; a client that is wrong about a rule the server enforces fails in front of a person.

**Decided.** `bun run contract:bundle` assembles, from the places that own each fact and from nowhere else, a
directory of plain files, and every GitHub Release carries it as `purlay-contract-<tag>.tar.gz` with its
`sha256`:

1. **`contract.json`** — every named schema of `@purlay/types` as JSON Schema, a schema met inside another written
   as `{"$ref": "<name>"}`; the endpoint table (D-190's `ENDPOINTS`) with each route's query, body and successful
   responses by name; an allowlist of the constants a client must know; every error `code` with its HTTP status;
   the socket's close codes. **The keywords a schema may use are a fixed vocabulary** (`SUPPORTED_KEYWORDS`): one
   outside it fails the server's build, because the alternative is a generator that quietly ignores a rule.
2. **`fixtures/`** — message-id vectors (what is made at known instants, what is refused, the plausibility
   window) and the markdown corpus with the tree the server's engine reads from each case. A second
   implementation passes the corpus or records each divergence; the corpus says that an address is the WHATWG
   parser's spelling, which is not always the typed one.
3. **`tokens.json`, `pairs.json`, `docs/`** — the visual values and which colours must be readable against which;
   `UX.md`, `API.md`, `ARCHITECTURE.md` and `DECISIONS.md` at this version.
4. **`MANIFEST.json`** — server version, contract version, the bundle's own layout version
   (`CONTRACT_BUNDLE_FORMAT`) and the digest of every file. The client pins the digest of the manifest and refuses
   a file that does not match it.

The output is **deterministic**: sorted, with no clock and no randomness, so two builds of one commit are one
bundle. `contract:bundle --check DIR` is exact in both directions. The release script builds the bundle **before**
the release exists, so a bundle that cannot be built, or comes out empty, leaves no release behind.

**Rejected.**

- *An OpenAPI document.* One more description of the contract to keep equal to the schemas it would be written
  from; what the generator needs is the schemas, which already are the contract.
- *Publishing `@purlay/types` as a package.* The client is Swift; a TypeScript package is of use to nothing it does.
- *The client reading the server's docs by hand.* That is the copy this replaces.
- *Fetching the contract from the running server.* A client built against a server that is not the one it will talk
  to is the failure D-190's minimum is there to refuse; a bundle is pinned at the version it was built for.

**Accepted.** A change to a schema's vocabulary is a change to the generator first, deliberately. The bundle is a
megabyte and a half, most of it the documents.

**Reverses if** the application is ever built in this repository, or a second non-browser client appears whose
generator wants a different shape: then the bundle is revisited, not copied.

---

### D-193. A person sees where they are signed in, and ends one place — builds on D-60, D-179 §3, D-191

**Context.** D-191 accepted that the native application's session could be ended only by *Sign out* on that
device or *Sign out everywhere*, and said it reverses when a device list is built. An application that lost the
answer to `token` leaves a session nobody can name, and a stolen Mac could be answered only by ending every other
place too. The pieces were all there: `last_used_at` has been kept for this since D-60, and a session is ended by its
row id (D-179 §3), never by a token.

**Decision.**
1. **`GET /api/me/sessions`** answers the caller's live sessions, the one used last first, at most
   `DEVICE_SESSIONS_MAX` (100). Each is `{ id, kind, name, createdAt, lastUsedAt, expiresAt, current }`. `kind` is
   `native` when the session was handed to the application by a code, `browser` for every other; `name` is the
   device name the application sent (`null` for a browser). *Live* is judged by `SESSION_CLOCK`, the clock the
   library judges expiry by, so a lapsed row the sweep has not removed is never listed.
2. **`DELETE /api/me/sessions/:sessionId`** ends one of the caller's sessions: `204`, the row deleted (its push
   subscriptions with it, 0024), its sockets told `SESSION_ENDED` once the delete is committed (D-85). A session that
   is somebody else's, one that never was and one already ended are **one** answer, `404 SESSION_NOT_FOUND`, so the
   endpoint cannot be used to learn whether an id exists. Ending the session the request came in on is signing out
   of it (the cookie is not cleared; `POST /auth/logout` does that too).
3. **`sessions.device_name`** (0057) holds the name, written when the code is spent. It is the *only* thing a
   device list names a session by: the user agent and the address stay for an operator and are never in the answer,
   and the token's digest is not selected at all.

**Rejected.**
- *Reading the name back out of `user_agent`* (`Purlay for macOS/1.2.3 (Name)`): a label this server wrote for
  its operator, parsed back by a pattern that is one edit from wrong.
- *Listing by the library's `/auth/list-sessions`*: it lists token digests and answers `403 SESSION_NOT_FRESH` for a
  session older than a day; its `revoke-session` takes a token, which under the hashing plugin matches nothing and
  answers `{ status: true }` (D-179 §3).
- *Ending the current session with `409`*: a second way to sign out with a different answer for the same effect.
- *A browser's name from its user agent*: a heuristic nobody can hold to a test. A browser's session is `browser`
  with no name; the web shows it as "This browser" or by when it was used.

**Accepted.** A session minted for an application that never saw the answer appears in the list under its device's
name and can be ended: the orphan D-191 accepted is now visible. `lastUsedAt` is precise to the hour (D-60).

**Reverses if** the list is wanted with the address or the browser: then it is a decision about personal data
(D-81), not an addition to this one.

### D-194. A client that was away asks what changed since it last heard, by the server's clock — builds on D-65, D-82, D-33

**Context.** A reconnecting client is replayed the root messages above the newest id it holds (D-65). That cannot
tell it about an edit, a deletion, a reaction taken back, a reply, a resolved thread: none makes a new id, and a
message that arrives late sorts *below* the newest id a client holds (D-33, and D-65's "a cursor is not a watermark").
The web client re-reads what it shows on every acknowledgement and so never notices; a second client built from the
contract would show a deleted message for as long as it ran, and nothing in the contract said it must not.

**Decision.**
1. **`messages.changed_at`** (0058): the instant the server last wrote the row, on the database's clock, to the
   millisecond. Stamped by a **trigger** on every `UPDATE` and by the column's default on every insert, and left
   alone when a statement sets it itself (a backfill, a test). It is a trigger, not a column each writer sets, because
   the writers include the ones nobody remembers — a retention job, an erasure, a repair by hand — and a client that
   is not told of one of them is wrong without knowing it.
2. **`GET /api/channels/:channelId/changes`**: with nothing, the watermark (`asOf`) and no data; with `since` — the
   `asOf` the client holds — the first page of what changed after it; with `after`, the next. Each page is `data`
   (the messages as they now stand: roots and replies, a deleted one as its tombstone), `nextCursor` and `asOf`. The
   cursor carries the walk's watermark, so `asOf` is one value however many pages the walk took, and a walk ends at the
   clock it began at: a change made while a client reads belongs to the next walk, which begins from that `asOf`.
3. **A walk begins `CHANGES_OVERLAP_MS` behind `since`** (the replay's, D-65): a write stamps its row before it
   commits, so a row stamped before a reader's watermark can be committed after the read. Rows inside the overlap are
   told again; a client keeps messages by id and discards what it holds, as for a replay.
4. **Who may read it** is who may read the history: the same guard, the same refusal for a channel the caller cannot
   see. Nothing about a person's other channels is in it.

**Rejected.**
- *Replaying edits and deletions inside `SUBSCRIBE`*: a protocol change for the web as well, and a replay budget
  (D-65) that a long absence would spend on one channel.
- *A change-log table*: a write on every reaction, a retention rule of its own and a second statement of what
  `messages` already says.
- *`state_version` as the cursor*: a per-row count, not an order across rows.
- *The id as the cursor*: the failure above, again.
- *Pins, memberships, the channel list*: not messages. They are read again, as before (`ARCHITECTURE.md` §5.4).

**Accepted.**
- A walk from an old watermark pages through everything the channel did in the time, which is as large as the channel
  was busy; a client away for longer than it cares to page reads the history again instead.
- **A row that is deleted is not in the walk.** The retention purge removes message rows (D-139 §3), and a deleted
  row has no stamp to be read by: a client that held a purged message keeps showing it until it reloads, exactly as
  every open screen does after a purge (the job has no bus). What the purge *updates* — a root whose thread it
  recounted, a root it made a tombstone — is told. Carrying removals would be a log of ids and a rule for how long to
  keep it, for a workspace that has opted into a window and a message that is already outside the one it shows; it is
  not built, and what would reverse it is below.
- A walk begins `CHANGES_OVERLAP_MS` behind its watermark, so a write that stays uncommitted for longer than that
  can be missed. The pool bounds a statement at 30 s and an idle transaction at 15 s (`POOL_DEFAULTS`), so a write of
  the application is stamped and committed well inside it; a transaction held open longer by hand is followed by a
  reload.

**Reverses if** the replay learns to carry changes itself, in which case this endpoint is the catch-up for what the
replay's budget could not carry; or if a purge that a client must see is wanted, in which case the removals are logged
by the purge and carried on the first page of a walk.
### D-195. A person arranges their own sidebar, by what is shown — builds on D-110, D-118 §6, D-132, D-160

**Context.** The sidebar listed everything the person had joined, always, in one fixed order, and the workspace's name
at its head was a button that ran from the rail to the hairline, so its hover and its focus ring touched both. Slack,
Linear and Notion all let a person fold what they do not need and leave out what they do not want: Slack folds a section
but keeps what is unread and the open conversation under its name, filters to unread and sorts by name or recency; Linear
hides what is not used and offers a menu for the arrangement; Notion folds a section by its heading. For a team of
a few dozen channels the difference is a column that is read and one that is scrolled.

**Decision.**
1. **The head of the column** is the workspace's tile, its name and the switcher chevron, inset and rounded as every row
   under it is, so nothing in the column touches the rail or the hairline; **Sidebar options** is beside it, and the jump
   field lines up with the rows.
2. **A heading folds its section.** It is a button (`aria-expanded`, its name still the section's), with a chevron after
   the name that is drawn on hover and focus, always once folded, and always on a touch window. A folded section keeps
   under it **what is unread, what mentions the person, a channel with an incident open and the open row** — a fold never hides what is waiting or what is on fire.
3. **Sidebar options** is one menu: *Show* — everything, or only what is unread (the same keep-rule, plus the open row);
   *Sort channels* — by name, which keeps a place where it was (D-160, and still the default), or by what was written
   in them last; *Sections* — Conversations and People may be switched off, **Channels may not**, and what the person
   starred stays (D-132); a section that is off is still drawn for the one conversation the person is in, under its
   heading, until they go elsewhere — a row is never taken from under them; *Hide muted channels* — a muted **channel** goes unless it mentions the person, has an incident open or is
   the open one, and a starred one stays whatever it is; conversations and people are not channels and are never left
   out for being muted (a muted person is still the only way to that conversation); **Reset sidebar**, offered only while something is changed. The button is
   drawn filled and its name says *changed* while anything is: a sidebar that shows less than the workspace has must
   not look like one that shows all.
4. **Kept in the browser, per person and per workspace** (`purlay.sidebar.<user>.<workspace>`), read once and written on
   change; a page whose storage refuses arranges the sidebar for as long as it is open and leaves the note D-126's other
   keys leave (`data-storage-failed`). It holds no words and no channel, so a sign-out does not forget it, and the person's
   id is in the key so the next person on the machine finds their own.
**Rejected.**
- *A compact row height.* D-118 §6 puts density in what is shown, not in compression; this decision is that, in menu form.
- *Dragging sections or channels into an order of one's own.* A saved order is the saved layout D-110 declined: another
  state to keep right as channels come and go, and the one place that would move a row under a pointer. If it is wanted it
  is its own decision, with the server keeping it.
- *A resizable sidebar.* `UX.md` §2 keeps no resizable panes; unchanged.
- *Custom sections, and a sort or filter per section.* Slack's own paid tier; for the size of team this is built for, one
  menu for the whole column is enough, and the second knob is where a menu becomes a settings page.
- *Keeping it on the server.* It would follow the person to every device and give the macOS client the same arrangement;
  it needs a table, an endpoint and a conflict rule, for a thing that is changed in passing. Not now.
- *A switch to turn Channels off.* A sidebar with no way into a channel, whose only way back is a menu inside it.

**Accepted.** A section switched off hides what is waiting in it too: a direct message from somebody is reachable
from the inbox on the rail, which is where what needs the person is gathered (D-106), and is listed again the moment
the section is back. The arrangement is per device: two browsers of one person differ until each is set. A fold of a section
with nothing waiting shows a heading and nothing else, which is the point.

**Reverses if** a per-person preference store is built on the server (the web and the macOS client would read one
arrangement): the keys here are then migrated into it and this one's storage is dropped.

### D-196. The initial JavaScript is a backstop, not a ceiling for features — amends D-49, `PRD.md` §5

**Context.** `PRD.md` §5 fixes the initial bundle at 250 KB gzipped and D-49 makes it a blocking gate, as the one
*deterministic* stand-in for what a person feels, which is time: cold load to an interactive channel (< 1.5 s), a
channel switch (< 100 ms), a keystroke painted (< 16 ms) — each recorded per commit and failed on a regression. Over
the product's first weeks the stand-in began to decide things the time never did. The overlays went into a deferred
chunk (D-163) when the bundle stood at 246.72 KB; the sidebar's arrangement (D-195) came to 250.20 KB and was
meant to lose a menu item, a tooltip and a sentence, and to have its menu made asynchronous, to finish at 249.95 KB.
A number that is rebuilt around by every feature is a ceiling on the product, and the product is what grows.

**Decision.**
1. **The cap is 400 KB gzipped.** The gate is unchanged in kind: `bun run budget:web` blocks, names the chunks and,
   with a source map, what grew in the largest. It is there so that an accident — a library imported whole, a locale
   that is no longer lazy, a grammar in the first chunk — fails loudly; the shape checks (one catalogue, no
   highlighter grammar, the initial modules in one file) stay as they are.
2. **A feature is put where it belongs, not where it fits.** Nothing is cut, left out or made asynchronous to pass
   the number. Deferring a thing nobody needs for the first screen is still a good choice — D-163's chunk stays as it
   was built — but it is made for **time**, judged by the time budgets and not by bytes.
3. **What a person feels keeps its own gates.** The cold-load, channel-switch and keystroke budgets, and the
   latency and idle-memory ones, are unchanged and are what is read when the first load seems slow.

**Rejected.**
- *No cap at all.* A rule needs a mechanism: with none, a 2 MB import is found by somebody's phone. The gate stays,
  at a size that the next few features do not touch.
- *A cap that rises with each feature.* The raising is the churn this removes; when 400 KB is near, that is a
  decision about what the first screen needs, taken with the time budgets in hand.

**Accepted.** The first load costs more bytes as the product grows. If that shows in the time budgets, the remedy is
chosen from them — what the first screen loads, what is cached, what is deferred — and not from a byte count.

**Reverses if** the time budgets are found not to see a cost that the bytes would have.

### D-197. A phase ends on what is built and verified, not on the owner's team switching — supersedes S-1, amends D-1, D-4, D-73

**Context.** S-1 made Phase 1 wait for the owner's team to stay off another product for thirty consecutive days, and
made the cloud wait behind it. That is a statement about one team's habits, not about the product: it cannot be
reproduced, it cannot be checked in CI, and it left finished work (rate-limit numbers, list virtualization, the
internal deployment) "open" for want of a calendar. Quality is what a reviewer or a stranger can verify.

**Decision.**
1. **S-1 is replaced by a check that can be run.** Phase 1 is done when every capability `PRD.md` §4 lists works end to
   end in a browser at both widths and both themes, `bun run verify` passes, and the deployed build runs the newest
   commit. The measurements that were left waiting for a team's usage are taken with a synthetic load and decided
   from it (O-4, O-5).
2. **The cloud's gate is S-3's preparation, not S-1.** Cloud work still does not start before the self-host path (S-2)
   is real, and the cloud sells operation, not features (D-1); only the thirty-day wait is gone.
3. **Dogfooding stays a practice, not a gate.** The team's own server (D-73) is the deployment every change reaches;
   what it shows is read as a measurement, never waited for.

**Rejected.**
- *Keeping S-1 as a stretch goal.* A criterion nobody is held to is a sentence that makes readers doubt the others.
- *Dropping the gates altogether.* A phase with no demonstrated exit is a phase that never finishes (D-4); the exit is
  moved to what can be demonstrated, not removed.

**Accepted.** Product fit with the owner's own team is no longer proven by the process; it is judged by use, as for any
product.

**Reverses if** the owner's team, or a customer, reports that a verified product is not one they can work in, which
the check above would then be missing.

### D-198. The frame budget is ten a second with a burst of sixty, decided from a measurement — closes O-4, amends D-66, D-81, D-84

**Context.** D-66's limiter was written with a working value, ten frames a second and a burst of twenty per
connection, and O-4 held the decision open until a week of a team's use could say whether any legitimate person
met it. Nothing now waits for a team (the phase no longer ends on one), so the number is decided from what a page
sends. `bun run measure:frames` (`apps/api/src/realtime/frame-profiles.ts`) runs each profile through the limiter
the server runs — the connection's bucket, and the user's write bucket a send is also charged to — and reports
the frames, the most in any second, the most at one instant and what was refused. What each profile assumes of
the client is pinned against the real engine and connection in `apps/web/src/realtime/frame-profiles.test.ts`.

**Measured** (the client says typing at most once per `TYPING_TTL_MS / 2` per channel, ACTIVE once a minute, a
ping per idle spell; a channel switch is no frame, because a page is subscribed to every channel its person is in):

| Profile | Frames | Peak per second | At one instant | Refused at 10 / 20 | Refused at 10 / 60 |
|---|---|---|---|---|---|
| Fastest typing (17 keys a second), 5 min | 117 | 3 | 3 | 0 | 0 |
| A short message every second, 5 min | 617 | 4 | 3 | 0 | 0 |
| A paste, sent | 2 | 2 | 1 | 0 | 0 |
| Four channels a second, a key in each | 240 | 4 | 1 | 0 | 0 |
| Eight channels a second, a key in each | 480 | 8 | 1 | 0 | 0 |
| Outbox of 20 sent on reconnect | 22 | 22 | 22 | 2 | 0 |
| **Full outbox (50) sent on reconnect** | 52 | 52 | 52 | **32** | 0 |
| Resubscribe 100 / 1,000 channels | 1 / 10 | 1 / 10 | 1 | 0 | 0 |
| Resubscribe 3,500 channels, 50 ms round trip | 35 | 20 | 1 | 0 | 0 |
| Resubscribe 3,500 channels, 20 ms round trip | 36 | 25 | 1 | 1 | 0 |
| Resubscribe 3,500 channels, 5 ms round trip | 37 | 22 | 1 | 2 | 0 |
| A flood of 500 at once | 500 | 500 | 500 | 480 | 440 |

Another tab is another connection with its own bucket, so several tabs change no row; the write bucket is the
user's, and a send it refuses is shown in the same table.

**Decision.**
1. **Ten frames a second, a burst of sixty** — per connection, and the same for a user's writes (D-81). The
   sustained rate is unchanged: no profile a person produces passes eight a second, and those that approach it are
   a key in a new channel every 125 ms. What was wrong was the burst: after a long disconnect the client sends
   every unsent message in one instant (`OUTBOX_MAX_MESSAGES`, fifty) beside the subscription and its upkeep —
   fifty-two frames, of which twenty were taken and thirty-two refused as `RATE_LIMITED`, which the client shows as
   a failed send. Sixty keeps eight frames over the worst profile.
2. **`FRAME_QUEUE_MAX` is sixty-four**, still above the burst (D-84): a connection inside its budget never meets
   it. A test holds the relation and a mutation tries it.
3. **The profiles stay as a test.** Every legitimate profile must pass with no refusal, a flood must still be
   refused, and the budget D-66 shipped with must still fail the full outbox — so a change to the outbox size, the
   typing interval or the subscription's chunk that outgrows the budget fails there, not in a person's session.
   `report:frames` stays as the check in use.

**Rejected.**
- *Keeping ten and twenty.* It refuses a person coming back from a gap with more than eighteen unsent messages, and
  the close for a full queue follows.
- *Pacing the client's resend instead.* Waiting for each answer, as subscriptions do (D-82), still sends faster than
  ten a second, and a `RATE_LIMITED` for a send is a failed message, not a retry; the right change is to the
  number, which the client is deliberately not told (D-82).
- *A higher sustained rate.* Nothing measured needs it, and it is the figure that bounds a flood that goes on.
- *A burst of one hundred.* More room than the outbox needs; it is also the size of the flood a connection may
  start with, and of the queue held behind it.

**Accepted.** A burst of sixty is a flood's first sixty frames instead of twenty, then ten a second; at most 64
frames of up to 64 KB wait per connection, which is a bound only a hostile client reaches (frames are a few hundred
bytes). Tabs that each hold the same stored outbox send each message once per tab: the id is the same, so the
server keeps one, and a refusal for the user's write bucket there is shown as a failed copy the other tab's
delivery has already answered.

**Reverses if** `report:frames` over a real stretch of use shows a legitimate refusal, or a peak above the burst
at the 99th percentile; or `OUTBOX_MAX_MESSAGES` is raised past the margin the test holds.

### D-199. The feed is not virtualized: a channel out of view keeps its newest page, and the rest is measured — closes O-5, builds on D-197, D-49

**Context.** O-5 asked whether the feed must be virtualized, to be answered against the channel-switch budget
(`PRD.md` §5, < 100 ms) once the team had used Phase 1 for a week. D-197 took the week away: the measurement is taken
with a synthetic load and decided from it. The load is the worst the product draws, not an average one:
`apps/web/e2e/feed-scale.e2e.ts` seeds a channel of **2,000 messages through the real API** — eight in ten heavy
(a ten-line TypeScript block, a long markdown body with headings, lists, a quotation and links, two GitHub
pull-request and issue cards, a picture, a root with three replies), the newest fifty all heavy — and drives the real
production client in Chromium at 1440 px, as a person does: opens the channel, scrolls to the top until a page loads,
repeats, goes to another channel and comes back. A heavy row is about 83 elements. The window of fifty was never the
risk; **the unbounded part was what the feed keeps after a person scrolls back**: `useMessages` is an infinite query
with no page cap and the feed mounts every page it holds, and the pages stayed cached when the channel was left.

**What was measured** (one Chromium on the author's laptop, 20 switches away and back, 30 keys typed; the heap is the
collector's `JSHeapUsedSize` after a collection; elements are `document.getElementsByTagName('*')`):

| | window (50) | 500 loaded | 2,000 loaded |
|---|---|---|---|
| elements in the document | 3,419 | 42,282 | 166,444 |
| JavaScript heap, in view | 25 MB | 125 MB | 454 MB |
| keystroke in the composer to the next frame, p50 / p95 | 1.8 / 16.3 ms | 5.9 / 19.1 ms | 41.8 / 42.8 ms |
| older page: top reached to its rows drawn, p50 / p95 | — | 83 / 95 ms (9 pages) | 113 / 153 ms (39 pages) |
| **switch back to the channel, before the fix**, p50 / p95 | 47 / 52 ms | **409 / 437 ms** | **1,959 / 2,113 ms** |
| **switch back to the channel, after the fix**, p50 / p95 | 47 / 52 ms | 48 / 50 ms | 49 / 50 ms |

The window passes with a wide margin (the switch 52 ms of 100; a keystroke inside one frame). What did not is the way
back to a channel after a long read: everything that had been scrolled through was drawn again, at 0.8 ms a row —
four times the budget at five hundred messages and twenty times at two thousand. The mounted rows were not bounded.

**Decision.**
1. **The feed is not virtualized.** The window holds the budget; the one place it did not was a consequence of what
   was *kept*, not of how the rows are drawn, and keeping less is a smaller change than a virtual list over
   variable-height rows (the scroll-anchoring rules of `UX.md` §6 are exactly what such a list makes hard).
2. **A channel that is no longer on screen keeps its newest page and lets the older ones go**
   (`keepNewestPage` in `data/cache.ts`, called as the feed goes away). A channel opens at its newest messages or at
   its unread marker, so what was scrolled through is not what a person returns for; it is read again, a page at a
   time, if it is scrolled to. The newest page stays whole: it is what the switch draws from the cache, what a read
   position names, and what a message that arrives meanwhile is written into. The way back is the window's, 50 ms,
   whatever was read before.
3. **Held by a test and by the budget.** A unit test and the feed's test hold the trim (two mutations in
   `scripts/mutations.ts`). The browser test holds a *count*, which a shared runner cannot excuse — what a channel
   draws on return is at most two pages — and its times join the existing mechanism: `bun run budget:browser` reads
   the median switch back after 2,000 messages from the same `test-results/performance` files as the rest, and
   blocks on a regression against main's last runs (D-49). On a person's machine the switch back is held to 100 ms
   and the keystroke at 500 loaded to two frames. **The keystroke with 2,000 loaded is recorded, not gated:** it
   measures the state this decision accepts (a whole visit's worth mounted), a hosted runner measured it at 144 ms
   against 76 on the run before, and a gate on an accepted number fails for the runner and not for the code.

**Rejected.**
- *Virtualizing the list* (a windowed list with measured row heights). It would bound what is mounted whatever a
  person does, and it is the answer if the in-view cost below is ever felt. It was not chosen because the measured
  failure was not the list in view but the cache outliving it; a virtual list over rows that change height when an
  image decodes, a card arrives or a highlighter finishes puts a scroll-position bug in the one place the product
  promises none (`UX.md` §1, §6), to fix a cost a trim removes.
- *`maxPages` on the infinite query.* It drops pages from the end opposite the one being read — here the *newest* —
  and the feed would then need to read newer pages on the way down and to place arriving messages in a list that
  no longer reaches the present: the machinery of a message's window (D-149), moved onto the channel everyone reads.
- *CSS `content-visibility` on rows.* It saves layout and paint, not the elements, the fibers or the heap, and its
  estimated heights move the scroll position under a reader.
- *Trimming on return instead of on leaving.* It would do the work on the switch's own path.
- *Leaving it, because two thousand messages in one sitting is rare.* It is forty scrolls to the top, but the cost
  was paid by the *next* visit, to a channel the person had left, and it grows without bound.

**Accepted.** Inside one visit nothing is bounded: after forty scrolls to the top, 2,000 messages are mounted, the
heap is 454 MB and a keystroke takes 42 ms to its frame — over a frame, well under the 100 ms at which typing feels
late — and an older page takes 113 ms to draw. At 500 loaded these are 125 MB, 19 ms and 83 ms, no worse than the
window within the noise of the machine. This is recorded, not hidden: `feed-scale.e2e.ts` writes it on every run,
and the 2,000-message keystroke is watched for a regression by `budget:browser`. History a person wants far back is
better reached by search and by a message's link (D-149), which open at the message.

**Reverses if** the keystroke with the messages a reader typically has loaded (about 1,000) is found over 33 ms on a
machine a team member uses, or the heap of a long visit is reported as a tab that is killed or slow — then the
mounted rows are bounded in view as well, and virtualization is reopened with this table as its baseline; or if the
switch back, with the trim in place, is measured over 100 ms.

### D-200. Single sign-on by OpenID Connect, as a third way in — builds on D-31, D-138, D-179, D-191; closes #88

**Context.** D-31 moved SSO from a permanent non-goal to "OIDC, only if an operator asks", and D-179 made the library
that owns identity one that can do it. The condition is gone: an organisation with an identity provider is the
customer the audit log (D-26) and the capacity ceiling (D-25) were written for, and a way in that is built after
somebody asks is one built under a deadline. The cost is a security decision, not a screen: a provider that is
believed too easily is an account takeover for everyone on the server. SAML stays refused (D-31, `PRD.md` §6).

**Decided.**

1. **Authorization code with PKCE, `openid email profile`, and the `id_token` as the only identity.** The browser is
   sent to the provider by `GET /auth/oidc` with the library's `state` (its row and `__Host-` cookie, D-62), a `nonce`
   and an S256 challenge; the provider sends it back to `GET /auth/callback/oidc`, where the library checks the state
   and this server redeems the code itself — client secret in the `Authorization` header (or the body, for a
   provider that takes it only there), the verifier, never redirected, ten seconds, at most 256 KB read. The access
   token is never used, and nothing of the provider's is kept: no token reaches `accounts` (`withoutTokens`). The
   userinfo endpoint is never read — an identity is what a signed token says, not what an unsigned answer does.
2. **What is checked, and where it is decided** (`modules/auth/oidc.ts`, once, for the sign-in and the probe).
   *Discovery* is fetched when a sign-in needs it and never at start or at save — **while no provider is set,
   nothing is sent anywhere** (the self-host path) — from `<issuer>/.well-known/openid-configuration`; the `issuer`
   in it must equal the configured one byte for byte (Discovery §4.3: a mismatch is how a mix-up is made), every
   endpoint must be `https` (`http` only to this machine), and a provider that does not offer the code flow with
   S256, or signs with nothing asymmetric, is refused. *The token*: signature against the provider's keys with an
   algorithm from an allow-list (`RS*`, `PS*`, `ES*`, `EdDSA` — never `none`, never `HS*`, never the token's own say);
   `iss` is the issuer; `aud` contains this client's id and, with several audiences, `azp` is it; `exp`, `iat`, `sub`
   present, thirty seconds of skew, no token older than ten minutes; `nonce` is exactly the one this sign-in made
   (the library refuses a callback with none to bind to). Also the callback's own `iss` parameter (RFC 9207) when the
   provider sends one. *Keys* (JWKS) are cached ten minutes; a token signed by a key not in the cache fetches the set
   again once, and not again for thirty seconds, so rotation works and a stream of forged `kid`s is not a stream of
   requests to the provider. A client-submitted `id_token` on the library's sign-in route is refused
   (`disableIdTokenSignIn`): the only way in is the redirect.
3. **Who an account is, and when an existing one is linked.** An account is `(issuer, sub)` — stored as
   `accounts.account_id = "<issuer>|<sub>"` under `provider_id = "oidc"`: a `sub` is unique only within its issuer, so
   a server later pointed at another provider cannot be signed into somebody's account by a `sub` that repeats.
   **A person whose address differs at the provider from the one on their account is still their account** (the
   subject decides, not the address), and **an account has one identity at the provider**: the library links a
   callback it does not know to the account whose address matches, so a new subject carrying a recycled or
   changed address is refused where the row is made (`identity_conflict`, `failed`), never added beside the old. **An address links to an existing account only if both sides say it is
   verified**: the token must carry `email_verified` of `true` (or the string `"true"`, which some providers send)
   and an address that is one mailbox written one way (D-138 §7), and the existing account's own `email_verified`
   must be true (`requireLocalEmailVerified`, as for GitHub, D-179 §5). Anything else is refused and said:
   `email-unverified` for a provider that does not vouch, `email-taken` for an account whose address was never
   proven — **no account is made, linked or touched**. This is the takeover that is closed: an identity provider
   that lets anybody register an address they do not hold must not be a way into the account of the person who does.
   *What is trusted* is the provider the operator chose, for the addresses it vouches for: an operator who connects
   a provider that verifies addresses loosely has decided that, as one who connects a mail relay has decided who
   reads the links. A multi-tenant issuer whose `iss` varies per tenant is not supported — a fixed issuer is the rule.
4. **Configuration, as GitHub's and the relay's are** (D-179 §6). `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET` (all three or none; the secret is sealed in `server_settings.oidc_client_secret_encrypted`
   with its column bound in, like `SMTP_URL`) and `OIDC_NAME` (the button's label, optional) are **a seed**, read on
   the first start only; afterwards Administration → Server is the home. It is **tried before it is kept** — the
   discovery document, the key set, and the token endpoint sent this client's credentials with a code nobody was
   given (`invalid_grant` says the pair is good; `invalid_client` is a refused secret) — under the administrator's
   authority and one rate class with the rest of `/api/server` (`SERVER_ADMIN_BUDGET`). Off while unset: no provider is
   registered, no route answers (`GET /auth/oidc` is `404 ROUTE_NOT_FOUND`) and `AuthMethods.oidc` is `null`.
   **The setup wizard has no step of its own for it**: a first-time server is set up with a way in that proves who the
   first person is (the administrator's password, GitHub or mail), and single sign-on is connected from Administration →
   Server, or by the seed variables on the first start. Disconnecting is refused as the last way in unless the
   administrator says so (`confirmLastChannel`), counting the third way now.
5. **One session, one set of rules.** The session, its cookie (`__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, a fixed
   lifetime, hashed at rest, D-11, D-179 §3), the state cookie, the origin rule (D-39), the closed routes and sign-up
   policy (`admittedByPassport`, which an invitation passport satisfies through the same callback) are the library's
   and ours, unchanged: the provider is one more `OAuthProvider` the library is handed, not a path round it. A sign-up
   lost to the same account made at once is sent round once, as GitHub's is (D-78). **The native application's
   handoff works with it with no change** (D-191): the page keeps `{challenge, state}` in the tab across the redirect, as
   it does across GitHub's. Each rate limit that applies to `/auth/*` (the `auth` class, per client) applies to the
   start and the callback.
6. **An account single sign-on is linked to is signed into by it alone, while the provider is connected.** The emailed
   link (D-138) is not sent to an address whose account has an `oidc` account row: asking is answered `202` as for any
   address and nothing is sent, and a link already sent is refused when spent (`fateOf` is asked again). **GitHub is
   not linked to such an account by address either** (`identity_conflict`). Disconnect the provider and both doors
   open again: nobody is shut out by a way in that is gone. A mailbox is not a second door past the
   provider that decides who still works there. *Accepted:* the person has no fallback when the provider is down;
   the server administrator has a password (R30).
7. **Names.** The display name is the token's `name`, cleaned as GitHub's is (controls and direction overrides taken
   out, cut to the column), else the username; the username is made from the address as an email account's is (D-138
   §5). **No picture is taken**: a `picture` is an address of somebody else's that every viewer's browser would be
   sent to. The button's label is plain text of at most 40 visible characters, never markup, and its default is
   worded in the person's language (`Continue with single sign-on`).
8. **The trail.** Connecting, replacing and disconnecting the provider are on the server's audit trail
   (`server.oidc_connected`, `server.oidc_disconnected`), written in the transaction that saves it, never the value. A
   refused sign-in is in the log by the check that refused it (`JWTClaimValidationFailed`, `JWSSignatureVerificationFailed`
   …) and never carries a token or a claim.
9. **Errors reach the person as one reason from the closed set** (D-121): `oidc-unavailable` (the provider did not
   answer, refused the code, or sent a token this server does not believe — the person cannot tell which, and is not
   told), `email-unverified`, and the existing `cancelled`, `expired`, `email-taken`, `signup-closed`, `busy`,
   `failed`; the sentences are in `UX.md` §11 and both languages.

**Rejected.**

- *`discoveryUrl` and the library's generic provider plugin as it ships.* It discovers at start (a network call from a
  server that has been told to send nothing), takes the discovery document's issuer on trust, follows redirects with
  a client secret in the body, has no deadline on its token call, and falls back to the userinfo endpoint when a
  token carries no `id_token`. Each of those is a place a provider's failure becomes ours; the provider here is the
  library's interface, written to the checks above.
- *Linking by address whatever the provider says* — the takeover of §3. *Linking by `sub` alone* — an account with no
  address to anchor it on, which D-38 refuses.
- *An allow-list of email domains (`OIDC_ALLOWED_DOMAINS`).* The provider decides who may sign in to this application
  (that is what an application assignment is); a second list here is a second place for it to go stale. It can be added
  without changing anything above.
- *A step in the setup wizard.* Three screens and a finish rule for a way in an organisation sets up after the first
  person has signed in; the seed variables cover the one-command install.
- *Reading the userinfo endpoint for the address or name.* Unsigned, and one more call that is the provider's to fail.
- *Provider logout (RP-initiated).* Signing out of Purlay ends Purlay's session (D-193); ending the person's session at the
  provider is theirs.
- *SAML.* D-31.

**Accepted.** A provider that does not send `email_verified` — some Microsoft tenants do not — cannot be used until it
does; that is the provider's claim to make, and the setting says why in the sign-in screen's words. A person whose
address is changed at the provider and then matched to another existing account is refused (`email-taken`), not merged.
Deprovisioning at the provider ends nothing here until the session expires (`SESSION_TTL_DAYS`); a server that needs it
sooner signs the person out from the devices list (D-193). The `OIDC_*` seed is ignored after the first start, as
GitHub's is, and named in the log.

**Reverses if** a provider's `id_token` is found to be believed in some case §2 does not name, or the linking rule of §3
turns away the people it should let in more often than it stops the ones it should not: then the rule changes, and
this entry with it. Dropping the way in is `DELETE /api/server/oidc` and a migration that drops four columns.

### D-201. The cloud's nodes share one Redis for the bus, the limiters and presence, chosen by `REDIS_URL` alone — builds on D-7, D-25, D-82, D-84, D-190, D-198

**Context.** D-7 (amended) made the shared adapter a requirement of the cloud, and D-25 placed three seams for it so that
it would be a file and not a refactor: `EventBus`, `PresenceRegistry`, `RateLimiter`. A second node makes each wrong in a
different way — a frame published on one node never reaches the sockets of the other; a person online on one is offline
to the other; the quota is granted once per node. The self-hosted product is unchanged and stays broker-free (D-7).

**Decided.**

1. **`REDIS_URL` is the only switch.** Set, `index.ts` opens the link (`platform/redis.ts`) and builds the shared adapters
   (`realtime/shared.ts`); unset, nothing here is built, no client is constructed, no timer starts, and the in-process
   implementations run exactly as before. `shared.test.ts` holds that: it makes every Redis client constructor throw and
   builds the application and its sockets, and it reads the source for the only two places that may name a client or ask for
   a link. The address is an environment variable only (`CONFIG.md`), a secret like `SMTP_URL`, never logged; the
   self-hosted compose file withholds it with a reason.
2. **Bun's own client, no dependency** (`CONTRIBUTING.md` §1.12). It has commands, scripts and pub/sub. It was measured
   not to subscribe again after its connection came back (a publish after a Redis restart reached nobody) and to give up
   after twenty tries, so the link owns reconnection: a lost connection is replaced by a *new* client after a wait that
   doubles from 250 ms to 15 s with jitter, for ever (starting over only once a connection has held for ten seconds, so
   a Redis that accepts and drops is backed off from), and every channel is subscribed again on it. A command never waits
   for a connection (offline it fails at once, connected it fails after two seconds and ends that connection), a
   connection that goes silent without closing is found by a ping every five seconds, and nothing is left unhandled.
3. **The bus is one Redis channel for the cluster, filtered in the node.** A publisher never fans out itself: it publishes
   and hears its own frame back, as every node does, so a frame is delivered once on each node, in the order Redis took
   it, and a channel's frames are in one order everywhere. The replay and changes-feed logic (D-82, D-190, D-194) is not
   touched. **While Redis is away** a node delivers to its own sockets (the people on it still hear each other); with only
   the subscription down, it also publishes for the others and delivers directly, since its echo will not come. **When the
   subscription is made again, frames were missed**, so the node closes its sockets with `RESTARTING` and they replay from
   their cursors: what a deploy does (D-72), by the code that already exists. **A frame that never reached Redis** from a
   node whose own connection was away leaves the other nodes' subscriptions up and nothing to tell them: each frame
   carries its publisher's name and a count, and a node that hears a hole in a count treats it as a gap, the same way.
4. **The limiters that are keyed beyond one connection are shared; the per-connection one is not.** A token bucket in one
   Lua script on Redis's clock — read, refill, spend and write in one step, so two nodes cannot both spend the same
   tokens — named per budget (a user's writes and a user's costly reads never share a bucket) and expiring by itself when
   it would have refilled. The user's write bucket (D-81, D-198's ten a second, burst sixty, charged by HTTP and the
   socket alike), sign-in and setup by address, the webhook and GitHub-call buckets are shared. The **socket's frame
   budget stays in process**: a socket lives on one node, so no node can grant it twice, and a Redis round trip per frame
   would sit on the hottest path for nothing.
5. **A Redis that does not answer: the limiter uses a bucket of its own node's.** Not closed (every write and every
   sign-in refused: the product is down because a cache blinked) and not open (no limit while the shared state is away).
   For as long as Redis is away the quota is the in-process one, N times on N nodes, which is what the product always
   had; the line says so at `warn` while connected and at `debug` while the link has already said it is down.
6. **Typing is one key per person and channel**, the in-memory rule on Redis's clock (tell the room when there is no window
   or it is half spent); unreachable, this node's own window answers — a frame too many per node, never a wrong answer (D-25).
7. **Who is online is a claim per node.** A hash per person holds each node's claim with the time it lapses and the version of
   the last change; a node renews its claims every ten seconds and they lapse in thirty, so **a node that dies leaves nobody
   online for longer than that**: read as offline by every snapshot, and **told by whichever node finds them first** — an
   index of when each person's last claim lapses is swept at every renewal, and the version is given once. A node that
   stops gives its claims up, so a deploy is told within a renewal; a person held elsewhere is not. A join or leave is given a version only when it changes whether the person is online *anywhere*:
   the first socket on a second node, and the last on one of two, tell nobody. Versions come from Redis's clock and only
   grow, so two nodes with clocks apart still agree which change is later, and a snapshot's version is smaller than every
   change after it. Calls for one person are made in order on a node. Unreachable: a person is online here whatever the
   record says (told, at a version larger than any the record gave), a leave is not told (the claim lapses and is swept),
   and a read is answered from the node's own sockets.
8. **Readiness.** A node that has **never** reached Redis since it started is not ready (a wrong address is found by the
   deploy, not by a user); a node that has, and loses it, stays ready and says so in its log. Every node refusing traffic
   because the shared piece blinked would be the outage; `/health/ready` still says a word and the log the reason.
9. **Tests.** Unit, against a fake link (what is asked, what is done on a failure); and against a real Redis, behind the
   existing integration conventions (`*.redis.integration.test.ts`, refusing without `REDIS_URL`, left out of `test:all`
   behind a banner where there is none, required in CI): one quota under two hundred concurrent calls across two nodes, a
   dead node's claim lapsing, one order across three nodes publishing at once, a link whose connection is cut and made
   again, and two whole applications — hubs, sockets, database — sharing one Redis (a message, a sign-out, presence, typing,
   the write quota, a node that loses Redis and sends its sockets back to replay). `docker-compose.yml` has a `redis`
   service for it, started by `bun run db:up:redis` and, in CI, beside the database; `bun run db:up` does not start it.

**Rejected.**
- *A Redis channel per topic.* The hub subscribes and then replays from the database (D-82); the bus interface's `subscribe`
  is synchronous, so a frame published between the call and Redis's acknowledgement would be lost for good. Every node
  hearing every frame is a few kilobytes a second at D-25's ceiling and has no such window. Reverses if that traffic is
  measured to matter: then an acknowledged subscribe, awaited before the replay, is the change.
- *Redis Streams.* Order and replay are already the database's (D-190); a stream would be a second log to trim and read.
- *`LISTEN`/`NOTIFY` on PostgreSQL.* It would make the bus depend on the connection pool's headroom and cap a payload at
  8,000 bytes; Redis is wanted for the limiter and presence in any case.
- *A client library* (`ioredis`, `redis`). Bun's covers what is used; the one gap found is the reconnection, which is the
  link's.
- *Failing the limiter closed or open* (5), *failing readiness on any loss of Redis* (8), *sharing the per-socket frame
  budget* (4), *a presence record without lapse* (a dead node would hold people online for ever).

**Accepted.**
- Each node hears every frame published anywhere and drops those it has no socket for.
- A publish that times out *after* Redis took it is delivered twice to the node that fell back to direct delivery, and
  after later frames; a frame is idempotent on its id and version, a client keeps the larger, and the sockets replay.
- A dead node's people read as online, and are told so, for up to thirty seconds and one renewal after it died. While Redis is away the quota is N times; presence is each
  node's own, and the sockets of a node that missed frames replay on its return — a reconnection storm the size of a deploy.
- The scripts are sent whole with each call (`EVAL`, not `EVALSHA`): a few hundred bytes a call, no `NOSCRIPT` to handle.
- One Redis with one primary. Redis Cluster is not supported: the presence read is one script over many keys.
- Sticky load balancing is not configured here; it is documented in `ARCHITECTURE.md` §11 and remains #115's.

**Reverses if** the cloud's measured bus traffic makes every node hearing every frame a cost (per-topic channels with an
acknowledged subscribe), or a loss of Redis is found to leave sockets silent that this entry says are not.

### D-202. The database can be restored to a moment, by an archive the operator switches on, and the claim is rehearsed — builds on D-44, D-95, D-185; closes #118

**Context.** D-44 promised point-in-time recovery, a stated RPO and RTO, and a restore tested on a schedule; D-95
built the third and named the first as "not covered". The nightly dump restores the database as it was at 01:00, so
the worst case is a day of messages, and a deletion at 14:00 is recoverable only to the previous night. On
2026-10-27 the host's backup cron was also found to have stopped finding its script after a deploy moved the code to
`releases/<commit>`, and to have said so only in a log: a backup that is not running is indistinguishable from one
that is, until somebody needs it.

**Decided.**
1. **WAL archiving is a switch, `WAL_ARCHIVE=on`, default `off`, on the stack's own compose file.** A small wrapper
   (`docker/postgres-start.sh`) in front of the image's entrypoint adds `archive_mode`, `archive_command` and
   `archive_timeout` only when asked; off adds nothing, which the rehearsal asserts of a running server
   (`archive_mode=off`, `archive_timeout=0`), so a self-hoster with the nightly dump keeps exactly today's behaviour. The
   archive is a directory, a named volume by default or a host path (`WAL_ARCHIVE_PATH`) on another disk or mount.
2. **The archive command is ours, thirty lines of POSIX shell** (`docker/wal-archive.sh`): it compresses to a hidden
   file, checks it reads, and gives it its name by a hard link, so a segment is whole or absent and a name is never
   overwritten; the same segment again is success, a different one under the name is a loud failure; a full or
   missing directory fails. Retention is tied to the base backups, not to a clock: the archive is kept from the
   segment the *oldest base backup on disk* began in (`scripts/prune-wal.sh`, `pg_archivecleanup`), and nothing is
   deleted when no base backup is found.
3. **`backup.sh` takes a base backup when the server says it archives** (`pg_basebackup`, tar, gzip, WAL fetched, from
   inside the database container so its version is the server's), beside the dump, with `base.label` and `base.meta`
   recording the segment it began in and the moment it was complete, in the same `SHA256SUMS`. A bounded wait: the
   backup fails if the archive does not take its last segment.
4. **`scripts/restore-pitr.sh` restores to a named time into a new instance.** The archive is copied into a new
   volume as root and every segment read back whole (the server is a different user from whoever shipped it, and a
   segment it cannot read looks to it like the end of the archive); the base backup is unpacked into another; and a
   new PostgreSQL from the stack's own image replays to `--to` (a time with a zone, or `latest`) in a container with
   **no network** and the copy **read-only**, so it cannot reach the live database or add to the archive. It promotes, is compared with a snapshot (`compare-databases.sh --snapshot` / `--against`) if
   given, and writes a backup-shaped directory that the existing, guarded `restore.sh` applies (staging, rename,
   the old one kept). It refuses, naming why, a time before the base backup was complete (checked by the script, not
   left to PostgreSQL, whose own refusal needs a commit inside the base backup's window), an archive that ends or has a gap before
   the time, an archive without the segment the base backup began in, and a backup with no base backup.
5. **The rehearsal proves it end to end, weekly.** It switches archiving on, takes a base backup, writes, notes a
   time, writes and deletes more, ships the archive off, destroys every volume, recovers to the time from the shipped
   copy, applies it with `restore.sh` and fails unless the comparison finds exactly the rows from before the time.
   It also proves each refusal and that nothing is left running. Its measurements are recorded in the run's summary.
6. **A hook says a night was missed**: `scripts/check-backup.sh` exits non-zero when no whole backup exists, the newest
   is older than 26 hours (by its name's time, never a future one) or does not match its sums, and with `--wal` (which
   declares that archiving is relied on) when archiving is off, the archiver is failing or stalled, or the newest backup
   has no base backup named in its sums. The cron lines in `CONFIG.md` name the paths of the layout `deploy.sh` makes and a
   test builds that layout and runs them as cron would.
7. **The stated numbers**: RPO 60 seconds with archiving on (`WAL_ARCHIVE_TIMEOUT`), 24 hours without; RTO is the
   rehearsal's measurement, recorded, with a design target of an hour for 10 GB that is an extrapolation until measured.
   A test ties the numbers in `CONFIG.md` to the compose default and the script's limit.
8. **Object storage**: the repository states what the bucket must have (versioning, no right to delete a version, a
   lifecycle no shorter than the retention window); it calls no storage service. Garage is believed to keep no versions (untested here; the document says to recheck).

**Rejected.**
- *Logical backups only, more often.* A dump every hour reads the whole database twenty-four times a day for an RPO of
  an hour, and still cannot name 14:03. The dump stays (it is the portable, cross-version restore, and a self-hoster's
  whole story), not as the answer to a point in time.
- *A managed database* (the cloud's PITR is a feature of its provider's service). It does not exist for a self-hoster,
  who is D-1's third audience, and the same claim here would be one the product could not make for the people who
  run it themselves. It remains the better answer for a cloud that has one, and nothing here prevents using it: the
  stack's database is `DATABASE_URL`.
- *pgBackRest or WAL-G.* Better tools, with parallelism, incremental backups, encryption and object-storage targets, and
  the right answer once the database is large. Rejected for now because each is a dependency a self-hoster must install,
  configure and keep in step with PostgreSQL's major version, for a database whose base backup is seconds to minutes;
  this is thirty lines of shell and the tools the image already has, rehearsed. The seam is the base backup and the archive
  directory: a switch to either replaces `backup.sh`'s step and `archive_command`, not the restore's shape.
- *`archive_command` as plain `cp`, or `rsync` to another host directly.* `cp` overwrites and can leave half a file that
  a restore reads; a command that blocks on the network stalls the database's WAL on a network error. The archive is
  local and the copy off the host is a separate, retryable job.
- *Streaming replication to a standby as the recovery.* It is availability, not recovery: a `delete from` replicates in a
  millisecond.
- *Restoring in place over the live database.* The restore is into a new instance and then through the guarded
  `restore.sh`, so a wrong time costs nothing and the live database is only replaced by something that was compared.
- *Pausing at the target (`recovery_target_action=pause`) for inspection.* A recovery that waits for a person is a
  recovery the weekly rehearsal cannot run; the result is compared and then applied or not.

**Accepted.**
- **The archive on the database's own disk dies with the server.** The default is a volume beside the database,
  because a default that needs a second disk is a default nobody gets; the document says so and gives the
  copy-off-host line, and a failing archive (full or unmounted) fills the data disk's `pg_wal` until the database stops,
  which `check-backup.sh --wal` and a separate disk are the defences against, not the stack.
- **Archiving costs disk and a little write time**: a compressed segment per `archive_timeout` of activity, and every
  backup now also reads the whole database a second time (the base backup beside the dump). A backup waits on the
  archive for its last segment, so a broken archive fails the backup after `BASE_BACKUP_TIMEOUT` (half an hour), and
  with it a deploy, which takes one first, until the archive is mended or switched off.
- **The archive holds everything in the clear and an erasure does not reach it** until the base backups that need it are
  rotated out (`DATA.md`); the shipping job runs as root because the segments are the postgres user's, `0600`.
- **Changing the switch restarts the database**, once.
- **After a recovery a new archive must begin**; the old one belongs to the previous history and the command refuses
  to mix them.
- **The bucket is not point-in-time**: attachments are recovered to the backup's moment, and versioning against a
  store that has it is the operator's to set; no script recovers an object as of a time.
- **The RTO is measured on a small database**; on a large one it is an extrapolation, and the operator's own rehearsal is
  the number.

**Reverses if** the base backup's cost (a second read of the database nightly) is found to matter on a deployment, or
one needs encryption, parallel or incremental backups or a bucket as the archive: then pgBackRest or WAL-G replaces the
two shell steps and this entry says so. Switching archiving off is one variable and a restart, and removes nothing.

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
- ~~**O-4 · Rate limiting — the number.**~~ **Closed by D-198:** ten frames a second with a burst of sixty,
  decided from a synthetic measurement of what a page sends (`bun run measure:frames`) instead of a week of dogfooding;
  the closing line of each socket and `bun run report:frames` stay as the check in use.
- ~~**O-7 · What the command palette is built on.**~~ **Closed by D-98 §7:** a Radix `Dialog`
  holding a hand-written listbox that follows the WAI-ARIA combobox pattern, held by `axe` and a
  keyboard-path test; `cmdk` is not adopted.
- ~~**O-6 · The two markdown packages D-36 named as categories.**~~ **Closed by D-101:** one
  engine, `mdast-util-from-markdown` with four GFM extensions, on both sides, narrowed to what the
  product renders and bounded so a body past the bounds is shown as typed.
- ~~**O-5 · Scroll virtualization.**~~ **Closed by D-199:** not adopted — measured on a 2,000-message channel of heavy
  rows, the window of fifty switches in 52 ms; what broke the budget was the older pages a channel kept after it was
  left (2.1 s to come back), so a channel out of view now keeps its newest page only. `purlay:channel-switch` stays
  in the page (`apps/web/src/app/switch-timing.ts`) for anyone who wants their own numbers.

### D-203. The required `verify` check is a fail-closed verdict over the static checks and the one run of every test — amends D-47; closes #791

**Context.** The `verify` job ran the unit tests alone (129 s of the 271 s job on run 40642437751, 2026-10-28), and
`schema` ran the same tests again, with the integration tests and coverage, 7 min 16 s. The first run proved nothing
the second did not, and paid for a runner to do it on every push. `schema` also started PostgreSQL and then Redis,
one after the other (20 s and 8 s). Branch protection requires a check named `verify` (and `schema`), and D-47's
promise — the merge is blocked unless the checks pass — rests on that name meaning what it says.

**Decided.**
1. **The job of steps becomes `static`**: every check that needs no service, unchanged, without the unit-only test
   step. **`schema` is the one run of the suite**, `test:all` with coverage, as before; its floors, discovery, budgets
   and timeout are untouched.
2. **`verify` is a job that needs `[static, schema]`, runs `if: always()`, and passes only when each succeeded**
   (`scripts/ci-gate.ts`, `bun run ci:gate`, reading `toJSON(needs)`). A failure, a cancellation, a skip, a missing
   result, a job the gate judges but was not handed, and a needed job the gate does not judge are each a refusal,
   naming the job. `always()` is load-bearing: a job whose dependency failed is skipped by default, and branch
   protection counts a skipped required check as passed. A test binds the job's `needs:` to the gate's list.
3. **The test services start together**, `bun run db:up:tests` (`docker compose up -d --wait postgres redis`), each
   waited on by its compose health check. `test:all` still refuses in CI when either is missing; that refusal now has
   tests of its own and mutations that prove they fail.
4. **What it saves is runner time, not the pipeline's length.** About two minutes of runner time a run (the 129 s step,
   less the gate job's few seconds, plus the overlapped service start); the run still ends when `schema` and the
   browser jobs do, and `verify` now reports after `schema` rather than beside it.

**Rejected.**
- *Keeping the unit run in `static` for a faster first signal.* It is the two-minute duplicate the change removes; a
  failing unit test still fails `schema`, and a developer has `bun run test` locally.
- *Making `static` and `schema` the required checks and dropping `verify`.* It changes the repository's protection
  rules outside the repository, and every workflow and document that names `verify` with it; the name stays, and
  means more.
- *Caching dependencies or the browser binary.* `bun install` took under five seconds, and Playwright advises against
  caching its browsers. A cache is a moving part for a saving nobody measured.

**Accepted.** The unit suite no longer runs in CI *without* services: `schema` sets `DATABASE_URL` and `REDIS_URL`
for the job, so a unit test that quietly needs a database passes there and fails on a developer's database-free
`bun run test`. That failure is loud, local and costs nothing in production; a guard against it would be the same
two-minute run this removes. `verify`'s job, its steps and the jobs it judges may not `continue-on-error`, which a
test holds.

`bun run check:cla` and `check:pr` (D-145, D-74) run in `static`, which `verify` requires, so "the `verify` job" in
those decisions still holds a merge.

**Research sources (2026-10-28).** [GitHub's dependency-caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
explains cache scoping and why cached contents must be treated as untrusted.
[Playwright's CI guidance](https://playwright.dev/docs/ci#caching-browsers) advises against caching
browser binaries: restoration can cost as much as downloading, and Linux system dependencies still
need installing. [GitHub's job-dependency guidance](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs)
explains why the final verdict needs `always()` after failed or skipped dependencies. These support
the choices above; they do not establish a measured reduction in the whole pipeline's duration.

### D-204. Questions keep their answers and decisions; search finds them

**Context.** On 2026-10-28 the owner approved research proposals 1–3: accepted answers and decision notes, unanswered questions with ownership, and advanced search with saved searches. This explicitly expands the current phase (D-4); GitHub issue creation is planned separately.

**Decision.** A root may be explicitly marked as a question before it has replies. Existing unresolved threads remain listed. Questions may name a channel member as owner; unanswered and assigned filters and oldest-first pagination expose waiting work. Assignment never sends a notification.

A root may select one live reply from its own thread as its answer, and carry a short plain-text decision note and an optional HTTP(S) reference. Selecting an answer and resolving remain separate explicit actions. A versioned metadata write prevents two editors overwriting each other; an identical retry succeeds. Any current channel member may edit, as with resolution. Deleted roots expose none of these fields; a deleted selected answer exposes no copied content. Notes are included in workspace export and cleared with a root's deletion; operator content erasure also clears notes last written by the erased person.

Search retains literal, case-folded matching and adds resolution/question, date, code/file, and repository filters. It also searches root decision notes and their live selected answers. Saved searches are personal, bounded, server-stored filters, never cached results, and every reuse applies current channel visibility. Dates are inclusive from/exclusive until UTC instants; before remains the UUID page cursor. Repository filters match owner/repo boundaries in GitHub links and repository events.

Contracts expand additively: optional knowledge in ThreadSummary, defaulted message columns, new versioned metadata and saved-search endpoints. Existing resolve routes and old rows remain valid. Metadata updates advance message state_version and changed_at and publish THREAD_UPDATED after commit. No new runtime dependency, notification class, scheduler, AI, or task tracker.

**Rejected.** Inferring questions from punctuation would classify ordinary conversation and miss questions without question marks. Implicitly resolving on answer selection would close discussion without the reader asking. Saving search results would outlive access revocation. Replacing the existing unresolved list would hide old work.

**Reversal.** Revert application changes and retain additive columns/table; do not discard stored decisions or saved filters. The first three capabilities are delivered together as requested; later GitHub integration is a separate scope decision.

### D-205. Quote and code formatting preserve the source

**Context.** On 2026-10-29 the owner requested improvements to quoting and sharing code. Quote formatting removed list markers; fence counting disagreed with the renderer and could send unfinished code. Automatic paste formatting nested fences and its Undo replaced the entire draft.

**Decision.** Quote formatting adds or removes one outer quote, retaining lists, nested quotes and quoted blank lines. Selections ending at a line start exclude that next line. Code formatting uses a fence longer than those in the source, including indented fences, and retains trailing blank lines. Automatic formatting only applies to long pastes outside existing code; already fenced pasted code stays as supplied. Inserted fences occupy their own lines.

Undo removes the automatic formatting, keeping the pasted content and later surrounding edits. It only replaces an unchanged, unique insertion; otherwise it leaves the draft intact and explains that the block changed. A newer automatic paste replaces the previous Undo action; sending or leaving the composer dismisses it.

The shared Markdown engine reports whether the caret ends inside an open fenced block by observing its actual fence tokens (D-101). No second grammar decides Enter in the composer or message editor. The nesting guard also applies here; ordinary text without fence characters skips parsing. Locally measured median block-read times were 0.32 ms for a short snippet, 9.06 ms for 15,004 characters of code and 22.46 ms for 10,012 characters of table rows. Long language labels truncate before copy and wrap controls, including inside quotes on narrow screens; copying still uses the complete raw source.

**Rejected.** Restoring the pre-paste draft loses both pasted content and later edits. Counting delimiter lines cannot distinguish a shorter fence or invalid closing line. Adding a rich-text editor would replace the existing plain-text workflow to solve formatting bugs.

**Reversal.** Revert the client helpers and rendering classes; messages remain plain Markdown strings and require no data migration or contract change.

### D-206. The workspace is drawn once, at the head of the sidebar; the dark theme is layered greys, not black — amends D-110, D-184

**Decided (the owner, 2026-10-30).** Signed in, the workspace was drawn twice a hand's width apart: its tile at
the top of the rail and its tile and name at the top of the sidebar, two doors to the same menu. A person is
in one workspace at a time (`UX.md` §2), so the rail's tile was never a column of workspaces to choose from,
only an echo. And the dark theme's rail was pure black (`#000000`) beside a near-black sidebar and content,
which the owner found too black.

- **One door.** The workspace's mark (its initials on the accent), its name and the chevron head the sidebar
  and open the workspace menu, as before; the rail no longer holds the workspace. The rail is the places —
  channels, inbox, open questions, search, saved — and Settings at its foot, its first place level with the
  sidebar's header row. The button is heard as the name and then what it does (*Acme Switch workspace*), so
  what is seen starts what is heard. The prerendered frame drops the rail's accent square with it.
- **Dark is layered dark greys** (in the manner of Apple's elevated dark surfaces and of VS Code's and
  Discord's dark themes): window `#0e0e10`, rail `#131315`, sidebar `#171719`, content `#1a1a1d`, a hovered
  message `#222225`, a hovered row or input `#29292d`, code `#131315`, hairlines `#2e2e33`, navigation hover
  `#26262a` and hairline `#2a2a2e`. Each step is one visible layer: the navigation recedes, the conversation
  comes forward, and no large surface is pure black, which smears on OLED panels and makes light text halo.
  Text, accent and status colours are unchanged; every contrast pair still passes. Midnight and Light are
  unchanged.

**Considered and rejected.** Keeping both doors with different menus, as Slack does — it still draws the
workspace twice for someone in one; removing the name from the sidebar instead — the column would have no
title and the mark alone does not say which workspace; lifting only the rail — a grey rail beside a black
sidebar and content is the two-palette mismatch D-183 removed.

**Cost of reversing.** The tile's markup in `workspace-menu.tsx` and its place in `rail.tsx`, the skeleton's
square, and ten dark values in `tokens.json`; generated files follow.

### D-207. The account door reads as a menu, the menu opens with who you are, and "you are here" has one tone — amends D-124

**Decided (the owner, 2026-10-30).** Measured against the account switchers of Linear, Vercel, GitHub and
Slack, the sidebar's foot fell short in three ways, and the place you are was drawn two ways:

- **The door.** Its trailing glyph was the sliders — the same glyph as **Sidebar options** beside the
  workspace's name — so it read as a setting, not a menu. It is the up-and-down chevron the workspace's door
  has, and the avatar carries your own online dot (D-136), as your row in People does; *online* is said to a
  screen reader after the name.
- **Who you are.** The menu opens with a card — the avatar, the name, the handle — as every one of those
  apps does, so the menu says whose it is before what it offers.
- **Deep Work's whiles are a submenu.** Four of the menu's seven items were the whiles; they are one item,
  **Deep Work ▸**, which opens them (ArrowRight or Enter). While it is on, how long is left and **End Deep
  Work** stay in the menu itself, one step away. The palette still offers every while directly.
- **One selected tone.** The channel you are in was filled with the accent, the rail's current place with
  the hover's grey, Settings' current section with the accent again. All three are now `nav-selected` — a
  quiet tint of the accent's family, distinct from hover in every theme — with the text in `nav-ink` and
  the glyph in `accent-text`. The loudest mark in the column is now a mention's badge, which is what needs
  you, not the row you already know you are in. The light theme's `accent-subtle` was not reused: on the
  light navigation it cannot be told from the column (1.02:1). Every pair drawn on it is in the contrast
  gate (`pairs.ts`).

- **The composer's edge.** Focused, the composer was framed in the focus ring's colour, which in the dark
  themes is the bright `accent-text` — held for as long as somebody types, it was the brightest thing on
  the screen. It has its own token, `composer-edge`: the focus ring's blue in the light theme, a calm
  slate-blue in Dark and an indigo in Midnight, each in the contrast gate as a control's boundary. The
  focus ring itself is unchanged everywhere else.

**Considered and rejected.** Keeping the accent fill (Slack's) — it competes with the badges and, in the dark
themes, is the brightest thing on the screen; the hover's grey for selection — hover and selection then
cannot be told apart; a separate Deep Work button beside the account — one more control in the corner for
something the palette and the menu both reach.

**Cost of reversing.** One token in `tokens.json` and `pairs.ts`; four class strings (`channel-row.tsx`,
`rail-item.tsx`, `settings-nav.tsx`, `group-face.tsx`); the trigger and the submenu in `account-menu.tsx`
and `MenuSub` in `ui/menu.tsx`.

### D-208. The inbox has categories and a panel, and reading in it is never painted back — builds on D-106, D-153, D-162

**Decided (the owner, 2026-10-30).** The inbox was a page only, with All and Unread. The owner asked for
the notifications to be split into categories, for a bounded view with a way to all of it, and for the
live path to be hardened.

- **Categories**, as server queries (D-153: never a filter over loaded pages): **All**, **Mentions**
  (`mention`), **Direct** (`direct_message`), **Threads** (`thread_reply` and `thread_resolved`). They
  are sent as the `types` the API already takes (D-106 #787), so no endpoint or schema changed. A
  channel's every message (D-107) is the weakest reason and stays in All. The page keeps the category in
  its address (`?category=`), so a reload, Back and the panel's See all agree.
- **The panel.** The rail's Inbox opens, on a wide window, a popover of the newest ten of a category
  (`PANEL_LIMIT`), and **See all** opens the page on the same category. It has no count (D-110). It is a
  new UI primitive's first use: `@radix-ui/react-popover`, the Radix family the app already uses; every
  package it needs was already in the lockfile at the same versions, so it adds only its own code.
  Narrow, the rail lives in the navigation's overlay and the Inbox stays the link to the page.
- **Live, and cheap.** The panel reads one page, so a `NOTIFICATIONS_UPDATED` frame costs one request of
  ten rows while it is open and none while it is closed, where the page's infinite list reads every
  page it has loaded again.
- **Reading, hardened.** One module (`read.ts`) reads for the page and the panel and paints every cached
  view of the inbox, both shapes. An answer already on its way when the person reads is cancelled before
  the paint, and the paint is laid again when the server answers, so a frame's read-again that landed on
  the server's old state cannot draw the row unread under the pointer. Reading by ids is sent in chunks
  of the server's page limit, so a thread that gathered more replies than that is not refused. In a
  category, Mark all read reads the rows shown, never "up to the newest", which is the whole inbox's.

**Considered and rejected.** Counting per category (a second badge, D-110); filtering the loaded pages
by type in the client (D-153); a panel on narrow windows (a popover over an overlay); a keyboard shortcut
for the page (`Ctrl+Shift+I` opens the browser's developer tools on Windows and Linux).

**Accepted, not yet.** The late-commit window D-106 accepted is unchanged: ordering the inbox by commit
order needs a server key, not a client change.

**Cost of reversing.** `inbox-panel.tsx` and the Inbox link's two shapes; the categories module and
its strings; `useNotificationsPanel` and the keys' category segment; two size tokens. `read.ts` is worth
keeping either way.

### D-209. Reactions are soft pills, and the workspace's door is a card over a vertical list — amends D-150, D-206

**Decided (the owner, 2026-10-30).** Two surfaces the owner found plain or hard-edged:

- **Reactions.** A chip was a near-square box with a hairline frame, and yours a bright accent frame. It is a
  pill, as Slack's, Discord's and Linear's are: no frame at rest, the surface's raised fill; under the
  pointer the accent's tint — what a click would make it; yours in that tint, in the accent's text and the
  heavier weight. The tooltip that says who is unchanged (D-150).
- **The workspace's door** (D-206) is a card at the head of the sidebar: framed in the navigation's
  hairline and lifted with the card's shadow, the workspace's mark, its name, and under it who the person
  is in it and how many are — *Owner · 4 members* — seen and not heard, so the button's name stays the
  workspace and what it does. Under the pointer its fill takes `nav-selected`, the accent's family; open,
  its frame is the accent. That is the edges' grammar (D-188): hover changes the fill, never the line,
  and an edge that says *selected* is the accent. The count is the People list's query, so no request is
  added.
- **The workspace menu lists the workspaces as radios** — each with its mark, the one the person is in
  checked and in the accent, the others in their own tint — so a screen reader says which is current,
  not only the eye.

**Considered and rejected.** A coloured frame that changes on hover (D-188 refuses a line that changes
with the pointer); opacity colours (`accent-text/40`) for the edge and the chip's ring — they build to a
raw `color-mix`, outside the token vocabulary; a column of workspace tiles on the rail (D-206: a person is
in one workspace at a time).

**Cost of reversing.** Two class strings in `reactions.tsx`; the card and the radios in
`workspace-menu.tsx`, and one string.

### D-210. What a paste becomes, a table from the row, numbered code, and text files read in place — builds on D-110, D-133, D-181, D-188, D-205

**Decided (the owner, 2026-10-30).** The owner asked for Markdown, CSV and styled code to be sent in the
right shape, and for the editor to match the best of its peers. The box stays a plain textarea of markdown
(D-110, D-181; WYSIWYG stays rejected, by the owner's choice): every change below is markdown the renderer
already draws, put where the caret is.

- **What a paste becomes** (`composer/paste.ts`, pure). Rows a spreadsheet copied (tabs) or a CSV (commas,
  or semicolons where the comma is the decimal mark; quoted cells per RFC 4180) become a GFM table — same
  width on every row, at least two columns and a header and a row, at most 200 rows, and comma cells short,
  so prose with commas stays prose. A comma or semicolon that ends or starts a line is punctuation, not a
  column (no header cell is blank), and words recognisably code are never a table — a paste of statements
  ending in `;` became a two-column table before this was said. Formatted text (`text/html`) keeps its emphasis, links (web and mail
  only), lists, headings (three levels, D-101), quotes, code and tables; an image is its alt text; Google
  Docs' all-wrapping `<b style="font-weight:normal">` is not bold; an editor's coloured code has nothing to
  keep and stays plain. The HTML is parsed into a document that is read, never shown, and a paste over
  200 kB of HTML is taken as its plain words. A long paste of code is a block named in its language when
  the language is clear (JSON by parsing, then what only that language looks like), so it is coloured and
  a diff is drawn as one (D-133).
- **One step back.** A table or formatting is a guess about what was meant: the toast offers **Paste as
  text**. `Cmd/Ctrl+Shift+V` pastes the words as they are. A code block keeps its Undo. Both follow D-205,
  which was decided alongside: the action finds the block it put in and puts the pasted words in its place,
  keeping what was written after it, and leaves a block that was itself edited; a newer paste's toast
  replaces the older one. Inside an open fence nothing is converted at all, and a paste that already is one
  fenced block is kept as supplied.
- **A block starts on its own line.** A long paste after words on the same line produced
  ```` before ``` ```` — not a fence, so the code ran into the paragraph and an empty block followed it.
  Blocks are now placed on lines of their own (`placeBlock`).
- **A table from the formatting row**: two columns and a row to fill in, its first heading selected.
- **Numbered code** from five lines on: each line beside its number, in a column not heard
  (`aria-hidden`) and not selected (`select-none`), so a hand selection copies the code alone; Copy still
  copies the raw text.
- **Text files read in place.** A CSV, Markdown or code file (by extension) up to 512 kB has **Preview**
  beside its download. It is read only when asked (`attachmentText`, with the session, cached for the
  page — an attachment never changes) and drawn through the renderer: a CSV's first fifty rows as a table
  and how many more, Markdown formatted, code coloured, the start of a long text with a note that the
  file goes on.

**Considered and rejected.** A WYSIWYG editor (the owner chose to stay with markdown); converting a paste
without a way back; previewing every file as the feed loads (a feed of files would be a feed of
downloads); rendering a file's HTML.

**Cost of reversing.** `paste.ts` and its call in the composer; one kind and one button; the numbered
lines in `code-block.tsx`; `attachment-preview.ts`, the preview in `attachments.tsx`, `Http.text` and
`attachmentText`; one size token and the strings.

### D-211. What opens from a control grows out of it, and leaves faster than it came — amends UX §9

**Decided (the owner, 2026-10-30).** The owner asked for smooth, well-made transitions in the right places,
without overdoing it. UX §9 keeps motion quiet and only the palette animated as it opened; menus, the
inbox panel, tips and dialogs appeared and vanished in one frame, which read as abrupt beside the
palette's open.

- **A menu, a submenu, the inbox panel and a tip** open with `pop-in` — from 0.96 with a fade, in
  `duration-overlay` (150ms) — from the origin Radix computes for the side they opened on, so each grows
  out of the control that opened it; they close with `pop-out` in a new, shorter `duration-exit` (100ms):
  what leaves does not need the eye.
- **A dialog** opens as the palette does (`overlay-in`) over a backdrop that fades; both leave in
  `duration-exit`.
- **A toast** rises a little into its corner (`rise-in`): it arrives where the eye is not.
- **Unchanged:** no message entry animation; hover and focus stay 120ms colour transitions.
- **Reduced motion** sets every duration token to 0ms, the new one included, so each of these is
  instant without any component remembering to check; Radix waits for a closing animation before it
  removes the element, and a zero-length one ends at once.

**Considered and rejected.** Animating message arrival, list reordering or the feed (reads as lag, and
moves content under the reader, UX §1); springs and longer durations (more motion than a working tool
wants); a motion library (CSS keyframes and the tokens already do it, with no runtime cost).

**Cost of reversing.** Four keyframe pairs in `index.css`, one duration token, and the classes on the
menu, tip, dialog, toast and panel.

### D-212. "Mark unread from here" — the one way the read position moves backwards — amends D-99 §4

**Decided (the owner, 2026-10-30).** The owner asked for the core features of Slack, Teams and Discord
the product lacked; marking a message unread is the first. The read position only ever moved forward
(D-99 §4), which is right for reading and leaves a person no way to say "come back to this".

- **`PUT /api/channels/:channelId/unread` `{ fromMessageId }`**, a member's only. The position moves
  back to the newest message before it, or to none; a reply marks its thread's root, since the position
  reads the feed (D-147). Both counters are recounted from the rows in the same locked turn as a read's
  (`markUnread` beside `markRead`), so they cannot disagree with them. Already unread from there or
  earlier, nothing moves and no version is spent. The caller's devices are told by `CHANNEL_STATE`.
- **Notifications are not touched.** What the inbox has read stays read there (D-106); the badge counts
  what still waits, as it always has.
- **The open channel is held.** Looking at a channel reads it (`use-mark-read.ts`), and the next message
  to arrive at the bottom would read it straight past the mark. A channel marked unread is held for the
  rest of the visit — nothing is sent at the bottom or on leaving — and reads as before when opened again.
  The hold is set before the request, so a read already waiting for its pause cannot slip in; refused,
  the hold is lifted and a toast says why.

**Considered and rejected.** Letting `PUT …/read` move backwards (a stale device behind the others would
then undo their reading: forward-only is what makes that request safe to repeat); re-opening the
notifications of the messages marked (the inbox and the feed are read apart, D-106).

**Cost of reversing.** One endpoint and `markUnread`; the menu item and the hold in `use-mark-read.ts`.

### D-213. Quote reply: the words, whose they are and a link back — never a mention

**Decided (the owner, 2026-10-30).** Second of the core features the owner asked for (Teams' and Discord's
reply with a quote).

- **More → Quote reply**, for a member: the part of the message the person had selected — read as the
  menu opens, before choosing an item can move it — or all of it, into the composer it answers in: a
  reply's thread, a root's channel. Every line behind `> `, then a line with the author's name and a
  link to the message, then the
  caret, focused once the menu has closed (`onCloseAutoFocus`; while open, or closing, it holds focus).
- **Named, not mentioned.** The author is their display name, never `@username`: quoting somebody is not
  calling them (D-12), and the link is how the reader finds the original.
- **Bounded** to its first thousand characters, ended at a line: a quote points at the original.
- **No new server surface**: the quote is markdown, sent as any message is. A composer is reached by its
  key (`composerKey`), so the message's menu needs no handle on whichever composer is open; a reply whose
  thread is closed has none, and a toast says to open it.

**Considered and rejected.** A structured "reply to" reference stored with the message (a schema and a
contract for what a markdown quote and a link already say); mentioning the author (a notification for
being quoted).

**Cost of reversing.** `quote.ts`, the composer's inbox, the menu item.

### D-214. Slash commands, as doors to what the product already does

**Decided (the owner, 2026-10-30).** Third of the core features the owner asked for (Slack's, Mattermost's
and Discord's slash commands).

- **The commands**: `/me`, `/shrug`, `/topic`, `/mute`, `/unmute`, `/star`, `/unstar`, `/invite @name`,
  `/leave`, `/deepwork 30m|1h|2h|tomorrow|off`, `/search`. Each runs through what already does it — the
  channel's edit, the header's level and star hooks, the Deep Work controls, the search address — so it
  paints, is refused and is put back exactly as its button, and the server checks what it always checked.
  No endpoint was added.
- **The list** opens on a `/` at the very start and narrows as letters are typed; Tab, or Enter until the
  command is whole, writes it out; Esc closes it. It is a listbox the box points at
  (`aria-activedescendant`), as the mentions list is.
- **Typos are not sent.** An unknown `/word` is far more often a slip than a message: it is refused under
  the box, naming the commands. `//` at the start sends a slash as words; a line with files attached is
  words, never a command.
- **`/me` and `/shrug` write markdown**, escaped so the words stay words: `/me` in italics with its
  underscores kept, `/shrug`'s backslash and underscores so the arm survives the renderer.

**Considered and rejected.** Server-side commands or an integration registry (an app platform is a
non-goal, PRD §6); sending an unknown command as text (a typo in a channel); commands with side effects
the product does not otherwise have.

**Cost of reversing.** `slash.ts`, `slash-run.ts`, the list in the composer, and the strings; two hooks
take a channel that may not be known yet.

### D-215. Drafts and sent: a place for what was started, and what went

**Decided (the owner, 2026-10-30).** Fourth of the core features the owner asked for (Slack's "Drafts &
sent").

- **A place on the rail**, after Saved, and a view in the palette: two tabs over one column, in the shape
  the list screens share (D-158).
- **Drafts** are this device's: what the composers already keep in `localStorage` (D-41), listed from
  the entries' names (`listDrafts`), so nothing is stored beside them; only this person's — the key
  carries the user, so another person on the same browser is never listed (#694). Each says its channel
  and whether it is a thread's, opens its composer (which reads it back), and is deleted with Undo. A
  draft written in another tab arrives through the browser's `storage` event. One in a channel the person
  can no longer see is left out: there is nowhere to open it.
- **Sent** is search narrowed to the person — `senderId`, no words, which search already takes as a filter
  that stands alone (D-105) — so what is listed is exactly what they may still see, by the server's one
  rule, newest first, a page at a time. **No endpoint was added.**

**Considered and rejected.** Keeping drafts on the server (a sync and a table for what is a convenience of
one device, D-41); a new "my messages" endpoint (search already answers it, with the visibility it must
have).

**Cost of reversing.** `listDrafts`, the screen and its link, a route, a palette entry and the strings.

### D-216. All unreads: what is new, everywhere, read only as far as it was seen

**Decided (the owner, 2026-10-30).** Fifth of the core features the owner asked for (Slack's "Unreads").

- **One screen** (`/w/:slug/unreads`), reached from a row at the head of the sidebar's lists — there only
  while a channel waits, with no count of its own (D-110) — and from the palette.
- **Which channels**: joined, unread, and not set to tell nothing (D-107: a quiet channel is not asking to
  be caught up on), in the sidebar's order. The state is the channels' cache, so reading one anywhere
  takes it off this screen.
- **What is shown**: each channel's roots after its read position, oldest first — the feed's own `after`
  page (D-8), twenty at a time, with "More in #channel" when more waits; a channel never read shows its
  newest page. Mentions are drawn as the feed draws them.
- **Mark read reads what was shown**, up to its newest root, and no further: nothing the person did not see
  is marked read. Found end to end: a channel whose unread are replies — unread by D-147 although the feed
  is read past them — showed a count and nothing under it; it now says the replies wait in their threads,
  and opens the channel, since a reply is read in its thread.
- **No endpoint was added.**

**Considered and rejected.** Reading the whole channel from here (it would mark read what was not shown);
listing muted channels; a numeric badge on the row (D-110).

**Cost of reversing.** The screen, its row and the rule in `waiting.ts`, a route, a palette entry, a cache
key and the strings.

### D-217. Forwarding is a link, and a link to a message is a card only for whoever may read it

**Decided (the owner, 2026-10-30).** Sixth of the core features the owner asked for (Slack's "Share message",
Teams' forward).

- **`GET /api/messages/:messageId`** returns one message, found by the rule every route that names a message
  uses (`requireMessageById`): deleted, never sent, or in a channel the caller cannot see is the one
  `404 MESSAGE_NOT_FOUND` (D-34), with nothing of the message in it. Covered by the cross-tenant suite.
- **Forward…** sends, through the engine as the composer does, a message of the person's own: their note,
  then the original's link on a line of its own. Nothing new is stored — no "forwarded from" column, no copy
  of the words.
- **A link to a message of this workspace** (this origin, `/w/<slug>/c/<channel>?message=` or `?thread=`) is
  drawn as a card under the words — author, channel, time, the start of it — asked of that endpoint as the
  reader. Whoever may not see the original sees *This message is not available to you* and nothing else, so
  a private message forwarded into a public channel shares a link, never its words; checked end to end, in
  the page and in the network answer. At most three cards; a card is a decoration of a link already there.

**Considered and rejected.** Copying the words into the forward (it would leak a private channel to whoever
can read the destination, and go stale when the original is edited or deleted); a stored reference with a
schema of its own (a link and the visibility rule already say it).

**Cost of reversing.** One endpoint and its handler; `message-cards.tsx`, `forward-dialog.tsx`, the menu
item and the strings.

### D-218. A channel keeps its links at hand, under its header

**Decided (the owner, 2026-10-31).** Eighth of the core features the owner asked for (Slack's channel
bookmarks, Teams' tabs).

- **`channel_bookmarks`** (migration 0062): a link and its name, per channel, in the channel's workspace by
  the composite key (I-4). The same address in a channel is one bookmark (`UNIQUE (channel_id, url)`): added
  again, the first stays, by whom and as named, and nothing is published — a double click or a retry is not
  a second chip. At most `BOOKMARKS_MAX` (20), counted under the channel's row lock (`FOR NO KEY UPDATE`, the
  lock a send's own write takes), so two members adding the last one cannot both get in. `added_by` outlives
  its person as null: the bookmark is the channel's. The workspace export carries them.
- **Read by whoever can see the channel, changed by its members** — the rule pins have (D-130): a visible
  non-member is `403 NOT_A_CHANNEL_MEMBER`; one in another channel, never there, or not a UUID is the one
  `404 BOOKMARK_NOT_FOUND` (D-34). Both suites cover the routes.
- **Only the web.** An address is `http:` or `https:` by the contract's pattern and parsed as a URL by the
  service, so nothing a browser would run (`javascript:`, `data:`) is ever kept; the client reads a bare
  domain as `https://`, as an address bar does, and names an unnamed bookmark after its site.
- **`BOOKMARKS_UPDATED`** on the channel's topic, after commit and only when something changed; it carries
  no bookmark and clients read the list again, as for pins. A removal changes nobody's sight of a channel,
  so it is not in the revocation table (D-85).
- **The bar** sits under the channel's header: chips that open in a new tab without the referrer, × on hover
  or focus for a member, *Add a bookmark* at the end. A removal is taken off at once, with **Undo** in the
  toast (the same address and name added back), and put back as the server has it if refused. For someone
  who may not change it and has nothing to read, there is no row at all.

**Considered and rejected.** Bookmarks as pinned messages (a link would need a message to live in, and
lose its place to retention); folders and reordering (a row of twenty does not need them yet); fetching a
title or icon from the site (an outbound request on every add, with its own SSRF guard — it belongs with
link previews, not here).

**Cost of reversing.** Migration 0062 (drop the table), the module and its three routes, one frame, the
bar and its strings.

### D-219. Dependabot opens no pull requests; updates are the owner's — amends D-20, D-86, D-91

**Decided (the owner, 2026-10-31).** Dependabot opened pull requests on a schedule of its own and showed
up among the repository's contributors; the owner wants every pull request to be one a person chose to
open. So `.github/dependabot.yml` is removed — no version updates for Bun packages, the Docker bases or
the actions — and the repository's automated security fixes are switched off. Its **alerts** stay on: they
open nothing, and say only that an advisory touches a dependency.

What it watched is now watched by a person, and each place that said "the bot proposes it" means that:

- **The TypeScript 7 trigger (D-20)** — `typescript-eslint` supporting TypeScript ≥ 7.1 — is checked by
  hand when the toolchain is updated.
- **Image digests (D-86)** move only when the owner moves them; `scripts/environment.test.ts` still holds the
  tag, the digest's version and `packageManager` equal, so a half-done bump fails.
- **Action SHAs (D-91)** stay pinned and checked by `scripts/workflow-pins.test.ts`; a new release arrives
  as an ordinary pull request, not a bot's.
- **Advisories** are still found without a commit: `bun run audit:gate` runs weekly and blocks at high
  severity, and CodeQL runs weekly with new queries.

The `dependabot/` branch prefix and the bot's exemptions in `check-pull-request.ts` and
`contributor-agreement.ts` stay while a pull request it opened is still open (#785), so that one can still
be finished; they go with the last of them.

**Amended 2026-10-31.** #785, the last, merged; the prefix and both exemptions are gone, and a pull request
from the bot would now fail `check:pr`, `check:cla` and `check:branch` like anybody's without an issue,
a signature or a named branch.

**Considered and rejected.** Keeping the actions and Docker ecosystems monthly (still a bot's pull
requests, which is what was asked against); keeping security-fix pull requests only (the same). Rewriting
history to take the bot out of the contributors list (its eight commits are on main, and a force push to
main is not worth a name in a list).

**Cost of reversing.** Put `.github/dependabot.yml` back from history and switch automated security fixes
on again.

### D-220. Test files have their own globals

**Context.** Bun 1.4.4 corrects coverage for previously unexercised branches. The runtime upgrade exposed missing failure/default-path tests, which are now exercised without lowering coverage floors. Full-suite runs also attributed another file's presence timers to the settings-swap leak probe and intermittently stalled a server-startup probe; those probes passed alone.

**Decision.** The unit, integration, full-suite and mutation commands use Bun's native `--isolate`: each file receives fresh globals and module state, and leftover handles are closed between files. Tests remain sequential. Existing leak assertions, coverage floors and timeouts stay intact. The environment-policy test and `tests-share-file-globals` mutation enforce the full-suite runner's flag. Package scripts put roots before the flag so Knip can still discover the tests.

**Rejected.** Shared globals let one file's browser adapters or asynchronous cleanup affect another file's assertions. A bespoke subprocess for the leak probe would isolate just one symptom and duplicate the runner's lifecycle support.

**Reversal.** Remove the isolation flags and their policy check/mutation together; no production data, contracts or configuration change. Reproduce the full suite before reverting, since standalone test success does not establish independence.

[Bun's isolation reference](https://bun.com/docs/test/parallel) describes the fresh-global lifecycle; [the 1.4.4 release notes](https://bun.com/blog/bun-v1.4.4#bun-test) describe the corrected coverage instrumentation.

### D-221. A Prometheus page for the operator, off until it has a token — amends D-44

**Decided (the owner, 2026-10-31).** D-44 said *no metrics stack yet*: logs, health checks and error tracking
answer *is it up* and *what broke*, and nobody was asking *how is it trending*. Self-hosters now are, and they
already run Prometheus beside everything else they host. So the API answers `GET /metrics` in Prometheus's text
format (0.0.4) — and nothing about D-44's other half changes: **nothing leaves a self-hosted server**. The page is
pulled by a scraper the operator runs; nobody is sent anything.

- **Off by default, and absent to a stranger.** Without `METRICS_TOKEN` the page does not exist. With it, a request
  must carry `Authorization: Bearer <token>`, compared in constant time over SHA-256 of both sides, so neither where
  they differ nor the token's length can be timed. No token, a wrong one, another scheme: each is the `404
  ROUTE_NOT_FOUND` of a path nothing serves, byte for byte, as the server's administration answers everybody but its
  administrator and a resource in another workspace is `404` (`CONTRIBUTING.md` §1.2). A `401` would tell a stranger
  that the page is there and worth guessing at. `/metrics` is one of the API's own prefixes, so with the client
  served a path under it is still that `404`, never the client's shell. The operator is told of a refused scrape in
  the log, at `info`, without what was sent. The token is at least 32 characters of a token's alphabet, refused at
  boot otherwise and never quoted; no rate limit is put on the route, since a `429` there would itself say the
  page exists.
- **Defence in depth.** The production proxy answers `/metrics` and anything under it `404` itself
  (`docker/Caddyfile`; measured: `/METRICS`, `/%6Detrics` and `//metrics` too), so a token that leaked is still no
  use from the internet; a Prometheus on the stack's network scrapes `api:3001` (`CONFIG.md`, *Metrics for
  Prometheus*).
- **No dependency.** The format is a page of rules: HELP and TYPE, three escapes, `+Inf`/`-Inf`/`NaN`, cumulative
  buckets. It is written in `platform/exposition.ts` and held by a strict reader in the tests that refuses what the
  format does not allow.
- **What is counted is what the code can see honestly, per process.** Uptime and resident memory; sockets open on
  this process (several nodes are several targets, which Prometheus adds up — D-201 does not change that); each HTTP
  request as one histogram by method, route **as registered** and status class, whose `_count` is the request
  counter, so a second counter would be the same number twice; refusals for the rate at each door; pushes that did
  not reach their service, by why (`refused`, `not_taken`, `error`, `dropped`); letters the relay did not take. Each
  counter's series exist from the start at zero, so the first failure is a rate and not a new series.
- **The jobs are read, not counted.** They run in the scheduler's container, one process per run, so nothing the API
  holds in memory would ever see one. Their record is `job_runs`, what `jobs:status` reads: each planned job's last
  success and its failures since are read per scrape, within two seconds. A record that cannot be read leaves the
  rest of the page and says `purlay_jobs_status_readable 0`, logged once until it reads again. A count of every run
  ever is kept nowhere, so the page does not invent one.
- **No label is a person's.** Label values are words the code spells: a method (anything unregistered is `OTHER`),
  a route as registered (`/*` for the catch-all, `(edge)` for a request refused before routing, `(unmatched)` for a
  method no route takes), a status class, a door, a reason, a job's planned name. A thousand paths with ids,
  addresses and names in them are one series and none of their words; a test signs a person in, has them write, and
  finds none of their name, address, ids, workspace or words on the page.
- **One registry per process**, made by the composition root and handed in like every other dependency
  (`platform/metrics.ts`); a module is handed a `Counter`, never the registry. A name declared twice, a name or label
  Prometheus could not read, a counter going down or an observation that is not a number is a defect, thrown.

**Considered and rejected.** `prom-client` (a dependency and its own global default registry for a page of format);
a `401` for a wrong token (it confirms the page to anybody who asks); serving the page on a second port (a second
listener to configure and expose correctly, where one path, one token and the proxy's refusal already keep it in);
counting job runs in the API (they are not the API's to see); the database pool's in-use and idle connections
(`@purlay/db` hands out Kysely and keeps the pool inside it; widening that package's surface for two gauges is left
for when somebody needs them); per-workspace or per-user series (cardinality, and a list of who is active).

**Cost of reversing.** Remove the route, `METRICS_TOKEN` from the loader, the compose file and the example env file,
the three new files and their tests, the counters handed to the push sender, the mail ledger and the socket, and the
proxy's two lines. No data, contract or migration is involved; an operator's scraper starts seeing `404`.

### D-222. The audit log is narrowed on the server and taken away as a file; each entry is also a log line — builds on D-26

**Decided (the owner, 2026-10-31).** The Audit log page was a newest-first list with nothing to narrow it
and no way to take it away; an owner answering "who removed that member in March" scrolled.

- **Filters**: who acted (`actorId`), one action of `AUDIT_ACTIONS` (`action`), and a window, `from`
  inclusive and `to` exclusive (`AuditQuery`, `GET …/audit`). Applied by the server inside the keyset:
  `nextCursor` pages within the filter, never over pages a client happens to hold (as D-153). **The window
  is instants, and only instants**: the client turns the days a person picked in their own zone into the
  instants those days begin (the last day's end is the next day's start), the address keeps the days, and
  the server compares UTC instants and nothing else. An instant is a range of ids, since an entry's id is
  made from the instant that is its `created_at` — so a window stays on `idx_audit_log_workspace` however
  long the trail. A window that is empty or backwards, or a moment the calendar does not have (`02-31`,
  `24:00`, which `Date.parse` would roll forward), is `400 VALIDATION_FAILED` on its field.
- **The filter lives in the page's address** (`?actor=&action=&from=&to=`), so a reload, Back and a
  shared link come back to it; only its own vocabulary is read back.
- **Download** (`GET …/audit/export?format=csv|ndjson` and the same filter): every entry the filter keeps,
  as an attachment, **streamed** five hundred rows a query by keyset, each page read only when the reader
  has taken the last — no upper bound on rows, one page of memory, no connection held between pages.
  What is written while it is read is not in it. The first page is read before the answer, so a database
  that fails at once is `500 INTERNAL`; one that fails later cuts the download off (a browser shows a
  failed download), logged by where — never a file that ends as if whole.
- **Who**: whoever reads the trail — an owner or an admin (§7.4), one rule (`requireTrailReader`) for both
  routes. **The download is on the trail** as `audit.exported`, with the format and the filter, written
  before the first byte: an export cut off was still an export; a refused one is refused before it is
  recorded.
- **CSV that a spreadsheet cannot run**: a cell starting with `=`, `+`, `-`, `@`, a tab or a carriage
  return is prefixed with `'`; cells are quoted as RFC 4180 says; UTF-8 with a byte-order mark, so `ğüşİ`
  open as themselves; CRLF. The columns are the NDJSON line's keys (`AuditExportLine`,
  `AUDIT_EXPORT_COLUMNS`), so the two files cannot say different things; the actor is named there as well
  as by id, since a file is read away from the people list.
- **Every entry of either trail is also one line of the process's structured log** (`audit entry
  recorded`): the trail, the entry, the action, who acted, the workspace, the target and the related ids
  of its metadata, and when — ids and fixed words only, never a name, an address or what anybody wrote,
  so the log stays free of personal data (`ARCHITECTURE.md` §10). Written as the row is, inside its
  transaction: a line whose request then failed is a row rolled back, and the request id joins them.
  Each process that opens the database hands its logger over as it starts; a test holds that each does,
  or says why not (the break-glass password command, whose output is one line by contract, and the
  demo's two).

**Considered and rejected.** Filtering in the browser over the pages loaded (it answers about what was
loaded, not about the trail). Filtering on `created_at` (a second index for what the id already orders).
Taking the reader's zone on the server (a second time-zone authority; the page already formats in the
reader's own). A cap on the rows a download holds (a trail longer than the cap would be cut where nobody
can see; streaming bounds memory instead). Building the file in the background like a workspace export
(D-140: a trail is small and its own owner's, and a queue is a moving part for what one request does).
Copying the metadata into the log line (it holds workspace and channel names), and writing the line after
commit (no hook for it exists; the request id already joins a line to its outcome). D-26's rejection of a
trail kept only in logs stands: the row is the record, the line a copy for watching.

**Cost of reversing.** The two query shapes fall back to `OlderPageQuery` (a client sending a filter
would be refused); the export route, its module and the `audit.exported` action (rows of it stay, said by
their name); `lines.ts` and the calls that hand it a logger; the page's filter card and its strings.

### D-223. A code reference is a link into the channel's repository — its one GitHub feed's

**Decided (the owner, 2026-10-31).** A path with a line (`src/retry.ts:14`) or a commit's SHA in a stack
trace or a "see foo.ts:14" should be one click from the code. Which repository it means is the channel's
GitHub feed's (D-134): with exactly one feed, that repository; with none, or several, no file is linked —
choosing among several would be a guess. No new setting and no migration.

- **Drawn, not stored.** The reference is found as the words are drawn (`codeLinksIn`, `@purlay/markdown`,
  called by `render-content.tsx` in prose and inline code), from `Channel.codeRepository` — an additive field
  of the channel the client already holds, read in the channel list's one statement by a scalar subquery on
  the feeds' `(channel, repository)` key, null for a direct message. It is told to whoever can see the
  channel, who already reads that feed's events in it. Nothing goes into the message's metadata: the
  repository is the channel's now, not when the words were sent. The feed list (`GET …/github-feeds`) stays
  an owner's or an admin's.
- **What is a reference.** A path ending in a known source extension (`ts`, `py`, `go`, `md`, `yml`, …),
  with an optional line: `:14`, `:14:7`, `:10-20`, `#L14`, `#L10-L20` and the compiler's `(14,5)`; a leading
  `./` is dropped. It starts where nothing path-like precedes it — a letter, digit, `.`, `/`, `\`, `@`, `#`,
  `:`, `~`, `$`, `%`, `+`, `-` or an invisible format character — so an absolute path, a URL's path, an
  address and the tail of a longer word are never cut into a shorter reference; a first directory with a dot
  in it is a host (`github.com/…`), and `node_modules` is not the repository's. A bare file name with no
  directory is a reference with a line, or inside inline code; in prose alone (`Node.js`) it is a word. A
  commit is 7–40 lower-case hex with at least one letter and one digit, standing alone: not a number, not
  `decade`, not `#a1b2c3`, not a piece of a UUID or of a longer hash, not `owner/repo@sha`. A version
  (`1.2.3:4`) and a time (`10:30`) have no extension. Covered case by case, Turkish text and punctuation
  around a reference included, in `code-references.test.ts`, and timed linear over 16,000 characters.
- **Where it goes.** A path opens `https://github.com/<owner>/<repo>/blob/HEAD/<path>#L<n>[-L<m>]`: GitHub
  serves `HEAD` as the repository's default branch (checked on 2026-10-31: `blob/HEAD/README` answers `200`),
  which the client cannot know without asking. It is the file as it is now, so a line written against an
  older commit may have moved; a branch name would be as much a guess, and the commit is not known. A bare
  name, whose directory is not known, opens GitHub's code search in the repository (`repo:<owner>/<repo>
  path:<name>`), and loses its line. A SHA opens `/commit/<sha>`. A link to a full GitHub address, and
  `owner/repo@sha`, are what they were.
- **Never in a fenced block.** A fence is code to read and copy, numbered and coloured token by token; a link
  inside it would take a click meant to select, and a trace pasted in one mostly holds absolute paths that
  would link to the wrong place. Never inside a link's label either.
- **Built, never taken.** The address is made from the repository, checked against
  `GITHUB_REPOSITORY_PATTERN` (anything else links nothing), and the path, each segment encoded on its own;
  a `.` or `..` segment never matches, so it cannot step out of the repository, and what is built must pass
  `SafeHref.of` and be https on github.com under the repository, or it is a defect, thrown, and the body is
  shown as typed. Nothing is fetched to check a reference: a link that ends at GitHub's 404 costs a click,
  a request on render would cost every reader and tell GitHub who reads what.
- **Drawn as a link** (`UX.md` §3, §9): underlined, not colour alone, in either theme; a new tab without the
  referrer, said to a screen reader; a stop for the keyboard among the row's controls (D-168).
- **When the feed changes.** The admin who connects or disconnects one reads the channel list again, and
  their references follow at once; everybody else's follow the next time their channel list is read. A feed
  changes rarely, and until then a reference opens the repository the channel had.

**Considered and rejected.** Finding references on the server and storing them in the message's metadata
(stale as soon as the feed changes, and a derivation every old row would lack); asking GitHub whether a file
or commit exists (a request per reference per reader, under GitHub's limits); a per-channel repository
setting (the owner chose the feed, which already says it); the first of several feeds (a guess); linking
inside fenced code (above); a bare word with an extension in prose, and upper-case SHAs (too many words and
numbers). One false positive is accepted: a repository named like a file in prose (`vercel/next.js`) is
linked into the channel's repository, where GitHub answers 404.

**Cost of reversing.** `code-references.ts` and its call in `render-content.tsx`, the hook beside
`useChannels`, the line in `github-feeds.tsx`, and the field: `codeRepository` is additive, so removing it is
a contract change an installed client may rely on — stop drawing first, then deprecate the field.

### D-224. Search operators are typed filters, read on the client into the criteria search already takes — amends D-204

**Decided (the owner, 2026-10-31).** Search had controls (Where, From, Advanced filters) and nothing could be
typed; `/search` (D-214) took words only. Now `in:#api from:@alice has:code deploy` works from the keyboard.

- **The operators are the existing filters, typed.** `in:#channel` (or `in:@person` for a direct message),
  `from:@person` (or `from:me`), `has:code`, `has:file`, `is:open`, `is:resolved`, `is:question`,
  `repo:owner/name`, `on:`, `before:` and `after:` a `YYYY-MM-DD` day. Each sets the field of `SearchCriteria`
  its control sets; **no server filter and no endpoint were added**, and the server checks what it always
  checked.
- **Read on the client, into the structured request** (`features/search/operators.ts`, pure). The address,
  the request and a saved search keep criteria and the words left, never the line typed, so a saved search
  is still a filter that reapplies current visibility (D-204) and an old one still opens. Names resolve
  against what the client already holds — the channel list, the workspace's people, the signed-in person —
  folded as the `@` list folds them (#702). One reader serves the search field, `/search` and the palette.
- **What is an operator.** A known key, a colon and a value, as one token; keys ignore case, every Turkish
  i included (`İN:`). Anything else is words: `foo:bar`, a link, `10:30`. A phrase between two quotes is
  words without its quotes, so `"is:open"` is searched for as written; a quote with no partner is a
  character. The last operator of a kind wins, and what is typed wins over a control changed with it.
- **Nothing typed vanishes.** An operator that cannot be read — a channel or person nobody here is called, a
  value no filter takes, an empty value (`from:`) — stays in the words where it was typed, is searched for
  as words, and is said under the field (a polite status), from the address alone, so a reload says it too.
  It is not blocking: the search runs.
- **When it is read.** On Enter, and on any change of a control, which searches with what the field holds;
  the field then keeps the remaining words, an operator it still holds quoted so Enter again asks the same
  thing. Too few characters, more than `SEARCH_QUERY_MAX`, or an end that does not follow the start are said
  in the field (or under the composer, for `/search`) and not asked.
- **Days are the viewer's.** `on:D` is D's start to the next day's, in the viewer's time zone, sent as UTC
  instants; `before:D` ends at D's start; `after:D` starts at the next day's (as Slack reads it). A midnight
  a clock change skips begins at the first moment of that day. **This amends D-204's UI**: the date
  controls were UTC days and are now the viewer's, so a typed day and a picked one agree; the contract was
  always instants and is unchanged.
- **Discoverable** from a *Search operators* disclosure under the field — a native `<details>`, in both
  languages.

**Considered and rejected.** Parsing on the server (`q` would carry syntax, a saved search would store a
string whose meaning changes with a rename, and names would be resolved twice); dropping an operator that
cannot be read (the search would quietly widen); blocking the search on one (a typo should not stop the
rest); turning operators into chips inside the field (a second editor for what the controls already show);
UTC days for typed dates (`on:2026-10-31` in Istanbul would start at 03:00).

**Cost of reversing.** `operators.ts`, `use-operators.ts`, the help and the notice, the three callers and
the strings; the date controls back to UTC midnights. Nothing stored changes.

### D-225. A channel may keep its history longer than its workspace, never shorter — amends D-27 §1, D-139

**Decided (the owner, 2026-10-31).** Retention stays the workspace's window (D-27 §1), and a channel may
keep its own history **longer** — a window past the workspace's, or forever — **never shorter**. So no
setting here can cause more deletion than the workspace's window alone already would, and the tenet's
default (D-2) is untouched: a workspace that keeps everything keeps everything in every channel.

- **Stored as a floor, in two columns** (migration 0063): `channels.min_retention_days` — at least this
  many whole days, `NULL` for none of its own — and `channels.retain_forever`. `channels_retention_sane`
  holds the workspace's own floor of 30, never both at once, and neither on a direct message (which
  nobody configures, D-123). `NULL`/`false`, every channel before this, is "as the workspace".
- **What is kept is the longer of the two windows, computed by the purge on every batch**, never a stored
  "effective" number: the candidate reads join each message's channel and leave out a channel kept
  forever and what is inside a channel's floor, beside the workspace's `created_at < cutoff`. A workspace
  window lengthened past a channel's floor afterwards wins; one shortened leaves the channel's; one set to
  forever is not read at all. Days are 86,400 seconds, as `DAY_MS` counts the workspace's, so a clock
  change does not move the edge. I-10 says this now.
- **Only an owner sets it**, `PUT /api/channels/:channelId/retention` (`{ keepsAtLeast: null | "forever"
  | days }`), and reads it — the rule the workspace's window has (D-139 §4): keeping a team's history past
  the policy is the policy owner's call, and an admin who could not shorten it does not lengthen it
  either. A floor shorter than the workspace keeps now, or any number while it keeps everything, is
  `409 RETENTION_TOO_SHORT`, checked under the workspace row's `KEY SHARE` lock so its window cannot move
  between the check and the commit. The same setting again is answered as set and writes nothing — even
  after the workspace moved past it, so a retry of a change that succeeded succeeds (D-33). Every change is
  on the trail as `channel.retention_changed`, `from`/`to` as `workspace`, `forever` or days, named to a
  reader only when they can see the channel (#691). No frame: only an owner reads it.
- **The workspace's setting counts the channels that keep longer** (`channelsKeptLonger`), archived and
  private ones included, and Data & retention says so. A count, never which: listing them would return
  channels to an owner who may not see them (D-34).
- **Archived channels keep their setting**, and the purge still applies it; the export carries both
  columns (D-140); content erasure (D-139 §7) is untouched — it tombstones whatever is kept.
- **Concurrency and failure.** The setter shares no lock with the purge (the purge never locks a channel
  row), so a change is answered at once and is the rule from the purge's next batch: a batch that already
  read the old rule finishes by it, as if the change had come a moment later — and the only change that
  could make that batch delete what the new rule keeps is a lengthening, whose worst case is the night it
  was about to purge anyway. A batch that fails writes nothing; the trail says `incomplete`, and the next
  run finishes by the same rule.
- **Measured, no index added.** On 1,000,000 messages (10 workspaces of 20 channels, one kept forever and
  one with a year's floor each), the roots' candidate read stays a range of `idx_messages_workspace_age`
  with each row's channel found by its primary key: 1.5 ms for a batch with nothing kept ahead of it, and
  21 ms with 9,082 kept rows older than the window ahead of it. **The dimension that grows** is the number
  of messages older than the workspace's window that a channel keeps, times the batches in a night: a read
  walks past them on each batch, linearly (about 2 s a batch at a million). A cursor carried from batch to
  batch is the fix when a night's `job_runs` duration says so; not before.

**Considered and rejected.** A sentinel for forever (`0` or `-1` days — a number meaning its opposite); one
enum column with the days beside it (three states where two columns and a check do); storing the effective
window (it would be wrong the moment the workspace's changed); shorter channel windows (the owner's rule:
nothing here may delete more); an admin's call (D-139 §4 keeps the window an owner's); listing the channels
that keep longer on the workspace's page (a workspace-wide read of channels the owner may not see); a frame
on change (nobody but an owner reads it); a per-channel purge loop (one pass per channel is a query per
channel; the join keeps it one read per batch).

**Cost of reversing.** A migration dropping the two columns, the join in the purge's two candidate reads,
the module and its two routes, the count, the section in channel details, its strings and the code. Undone,
the next night purges every channel by the workspace's window: a channel set to keep longer loses what is
past it, so reversing is a decision about data, not a cleanup.

### D-226. `verify` judges the browser jobs too, and lets them skip only for a change they cannot see — amends D-203

**Decided (the owner, 2026-10-31).** #821 merged with all four browser jobs red: the required checks were
`verify`, `schema` and the rest, and the browser jobs were none of them, so auto-merge took the change and the
deploy (D-185) put a dialog with two buttons named Save on the server for 25 minutes, until #823. The browser
jobs are now part of the required verdict.

- **`verify` needs `[static, schema, changes, browser]`** and judges each, as D-203 judges the first two: a failure,
  a cancellation, a missing result or a missing job is a refusal, naming the job.
- **A skip of the browser jobs passes only when `changes` succeeded and said `browser=false`**: a change they cannot
  see (`bun run ci:changes`: documents, tooling) still merges without a browser run. A skip for any other reason —
  `changes` failed, gave no answer, or said the change needs them — is a refusal, so the gate stays fail-closed.
- **The matrix is one result.** `needs.browser.result` is the matrix's: one red project is a red `browser`.
- **Branch protection is unchanged**: it already requires `verify`. A test binds the job's `needs:` to the gate's
  list, and mutations prove each new rule is tested.

**Considered and rejected.** *Requiring the four `browser (…)` checks in branch protection.* A job skipped by its
`if:` reports one check named `browser`, not its matrix names, so every change the browser jobs rightly skip would
wait forever for checks that never come. *Running the browser jobs on every change.* Four runners and some
eight minutes for changes to documents, for nothing they could see.

**Cost of reversing.** `needs:` back to `[static, schema]`, the list and the skip rule in `scripts/ci-gate.ts`, and
their tests and mutations.

### D-227. A budget regression is measured alone, and must happen twice — amends D-49

**Decided (the owner, 2026-10-31).** Since D-226 the browser jobs are part of the required verdict, so a noisy
budget now blocks a merge, and both noisy budgets were failing on noise. On main, identical code measured the
browser's cold load anywhere from 86 to 178 ms across runs, and a re-run of a failed job on the same commit gave
110.9 ms and passed; the API's fan-out p95 failed at 23.6 ms against 15.6 ms on a change that touched only the
client's search. Two causes, two fixes:

- **The browser measurements are taken alone.** `performance.e2e.ts` and `feed-scale.e2e.ts` — the files that
  write what `budget:browser` judges — ran inside the fully parallel suite, so another test's worker competed for
  the runner's two cores while they measured. `PURLAY_E2E_PERFORMANCE` (`playwright.config.ts`) now takes `skip`
  (every other file) or `only` (those two); unset, everything runs as before, and any other value refuses to run.
  Each project is two jobs side by side (`matrix.part`): the suite with `skip`, and on a runner of its own the
  measurements with `only` on one worker, then the budget. Only the measuring part reads, judges and keeps it.
- **A regression must happen twice.** A real slowdown shows again on an immediate re-measurement; a runner's bad
  minute does not. `budget:browser -- --remeasure` (CI passes it) measures a regression again — the measuring
  tests alone, one worker — and fails only if that regresses too; measuring again that exits non-zero or measures
  nothing is a failure, never a pass, and the first run's files are removed first so they cannot be read twice.
  `budget:latency` runs three more trials after a regression and judges them the same way. Each says both
  judgements ("first measurement regressed; measured again…"). Only a passing run is kept — the second, when the
  first regressed; `--record` keeps the run judged last, so the record and the verdict are the same measurement.
  An interrupted trial is still an error, in either set.
- **The budgets are not loosened** (D-48): the factor (1.5×, 2× under three runs), the 20 ms floor, the five-run
  history and the lines the tests hold on a developer's machine are unchanged. A regression that repeats fails as
  before; nothing is adopted that did not pass. This is not D-49's "retry until a pass": there is one more
  measurement, never a loop, and both are printed.
- **The cost is runner minutes, not the run's length.** The measurements run beside the suite on a runner of their
  own: alone, on one worker, a wide project's took 3.6 minutes on a laptop (the two-thousand-message channel is 3.1
  of them; the narrow projects do not run it), under the suite's own length, and the suite no longer carries them.
  Four more runners a run, and a regression spends its part's minutes again; the 20-minute ceiling has room for both.

**Considered and rejected.** *Widening the factor* — it would let a real 2× slowdown through to stop noise that a
quieter measurement removes at its source. *More samples per run only* — the cold load is already a median of five
and the latency a median of three processes; a bad minute on the runner moves every sample in it together, and
more of them cost every run, where measuring again costs only a run that regressed. *Dropping the gate, or taking
the browser jobs back out of `verify`* — D-49 and D-226: a budget nobody enforces is a hope. *Measuring every run
twice* — it doubles the minutes of every run to settle the few that regressed. *Measuring after the suite, in the same job* — quiet,
but it lengthened every wide project's job by the measurements' minutes. *Measuring again until a pass* — D-49's
re-run habit, automated: with enough tries noise passes anything. One more measurement, after a regression only, is
the bound: a slowdown real enough to repeat still fails.

**Cost of reversing.** The switch in `playwright.config.ts`, the second test step and `--remeasure` in `ci.yml`,
the re-measure in both commands, and their tests and mutations. Reversed, the measurements share the runner again
and a noisy run blocks a merge until somebody re-runs it.

### D-228. The whole suite runs two files at a time — amends D-220

**Decided (the owner, 2026-10-31).** `schema` was the pipeline's long pole: 742 s of a 12½-minute run on
2026-10-31, 686 s of it the one run of every test, file after file. D-220 kept the files sequential because Bun had
no parallel runner yet; Bun 1.4.4 has one, `--parallel=N`, which runs files in worker processes and implies
`--isolate`, so D-220's guarantee holds: each file has globals of its own.

- **`bun run test:all` passes `--isolate --parallel=2`** (`WORKERS` in `scripts/test-all.ts`). Measured on the same
  tree, coverage included: 256–269 s on six runs, two of them from no template at all as CI starts, against
  about 475 s sequential, every test passing; on CI `schema` took 460 s against 742.
- **Two, not one a core.** Four workers ran the suite in 148–155 s, but four files cloning the integration template
  at once wait on each other in PostgreSQL past the five seconds a hook is given, and the harness's own cost test
  failed with them. Two leave the database and Redis room on a four-core runner and failed nothing.
- **The coverage floor still holds.** Bun judges `bunfig.toml`'s per-file floor on the merged report: a run that
  passes every test but leaves a file under the floor still exits 1, checked in both modes before this change.
- **What running side by side exposed was fixed where it was, not waited out** (D-48: no floor, budget or rule
  moved):
  - a sidebar menu test read the menu one turn after the right click; Radix opens it a little later under load,
    so the first look in each case now waits for it;
  - the Redis bus tests published before every node's SUBSCRIBE had reached Redis, and Redis keeps nothing for a
    subscriber not there yet: nodes now trade probes in rounds until each hears every other;
  - the bus order walk and the reconnection walk, whose own waits allow ten seconds and whose reconnection doubles
    a 250 ms backoff, had the five seconds every test is given; they have thirty, with the reason beside them;
  - every worker runs the preload, so on a fresh database two built the integration template at once and one
    failed on a duplicate name, and a clone could start while another process was connected to the template:
    building and cloning now hold an advisory lock on the template's name (`testing.ts`, tested by building one
    new template twice at once);
  - four files that clone a database a test drop up to forty-six in one `afterAll`, which fitted a hook's five
    seconds only alone (#797): they have sixty, as migrate-on-start's cleanup already had;
  - Playwright reads the `JEST_WORKER_ID` each worker is given as being inside Jest and lists nothing, so the
    listing test leaves the worker's marks out of what Playwright inherits.
- `environment.test.ts` holds both flags and the number.

**Considered and rejected.** *One worker a core*: above. *Sharding `schema` over several runners* (`--shard`): the
per-file floor needs the merged report, and merging coverage across jobs is machinery this does not need while one
runner's cores are idle. *Running the integration files apart from the unit files*: the same merge problem.

**Cost of reversing.** Drop `--parallel=…` and `WORKERS` from `scripts/test-all.ts` and their test; the test fixes
stay, being right either way.

### D-229. A commit deploys only after its own `ci` and `image` runs have both succeeded — amends D-185; closes #798

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** `deploy` started on a successful `image`
run alone, and `image` does not wait for `ci`. On 2026-10-28 commit `8283c4a6` was live at 09:12 while its `ci`
failed at 09:19: the server ran a commit the gate later refused. Merging is not the proof either; branch protection
judges the pull request's head, and a rebased merge is a new commit that the push's own `ci` run judges.

- **`deploy` listens to both workflows.** A new `gate` job asks GitHub for the commit's push run on `main` of
  `ci.yml` and `image.yml`, newest first. Both completed and successful: the server job runs. One still running: the
  gate succeeds with nothing to do, and that run's own completion starts the workflow again. Anything else — failed,
  cancelled, timed out, or no run at all — fails the gate and the server is not touched.
- **The gate runs on GitHub's runner, not the server's.** Reading runs needs `actions: read` and nothing the server
  holds; the server's runner is reached only through `needs: gate`.
- **A hand-started deploy is judged the same way and cannot wait.** A rollback names a commit that was a push's tip
  and passed; a commit inside a rebased merge has no runs of its own and is refused, because it was never tested.

**Considered and rejected.** Making `image` depend on `ci` (`image` must run on pull requests as a required check of
its own, D-87, and chaining would lengthen every merge's road to the server by the image build). A `workflow_run` on
`ci` alone (the image could still be building, and its digest is what the server pulls). Polling in the deploy job
until both finish (it would hold the server's runner for minutes, and a wait loop is a timeout to tune).

**Cost of the choice.** When both finish within the same few seconds, both completions find the other done and the
commit deploys twice; `concurrency: deploy` runs them one after the other and a second deploy of the running commit
is a backup and a restart, which `deploy.sh` already handles. **Cost of reversing.** Set `workflows: [image]` back
and remove the `gate` job.

### D-230. Purlay installs as an application: a manifest, pictures drawn from the favicon, and no offline copy — builds on D-51, D-126, D-148; closes #89

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** D-51 made mobile an installable web
application, and iOS delivers Web Push only to a site added to the Home Screen (16.4+). Purlay had no manifest, so
an iPhone could not install it and with Purlay closed heard nothing, whatever the person turned on.

- **`public/manifest.webmanifest`** opens the whole origin (`/`) as a standalone application. Its colours are the
  dark theme's `surface-100`, which the shell starts in; `index.html` also gives the browser's bar `surface-100`
  for each colour scheme.
- **The pictures are the favicon, drawn again.** `bun run icons` (`apps/web/scripts/app-icons.ts`) renders
  `favicon.svg` at 192 and 512 as it is, and full-bleed at 512 (maskable) and 180 (`apple-touch-icon`), where the
  launcher cuts its own shape; the glyph already lies inside the maskable safe zone. `src/app-icons.test.ts`
  decodes each PNG and holds its colours to the accent tokens and its sizes to the manifest, so a changed favicon
  or accent fails until they are drawn again.
- **iOS's Safari outside the Home Screen says what to do.** Where the browser has no push and `navigator.standalone`
  is `false` (iOS's alone), the notifications page says to add Purlay to the Home Screen instead of "this browser
  cannot show notifications", which there is not the whole truth.
- **No offline copy and no fetch handler.** The push worker (D-126) stays registered only when somebody turns
  notifications on; installation needs neither in current Chrome and Safari (Chrome's installability check on the
  built client reports no errors). A chat client with a stale cache shows a conversation that is not true.

**Considered and rejected.** A service worker that caches the shell for offline use (a second copy of the client
whose staleness must then be managed, for a product that is useless without the server). Hand-drawn PNG icons
(a second source of the brand that drifts). `apple-mobile-web-app-capable` and the other pre-manifest iOS meta tags
(iOS 16.4+ reads the manifest's `display`). An in-page install prompt (`beforeinstallprompt` is Chromium's alone,
and the browser's own menu already offers it).

**Cost of reversing.** Remove the manifest, the four PNGs and the two `<link>`s; the push worker is untouched.

### D-231. Three gaps an audit found: a replayed delivery, a sign-in lockout, a year-long cached file — amends D-109, D-134, D-138

**Decided (the owner, 2026-10-31).** Three low-severity findings, each closed where it was, none by a new
moving part.

1. **A delivery is posted once by its body as well as by its id** (amends D-134 §5). `X-GitHub-Delivery` is
   not signed — the HMAC covers the body alone — so anybody who saw one signed delivery could send its body and
   signature again under an id made up, and the channel got the event twice. D-134 §5 had accepted that; it is
   closed now because closing it costs one column. `github_deliveries.body_digest` is the SHA-256 of the body as
   sent, written in the transaction that posts it, unique per feed (migration 0064, `SCHEMA.md` §8.3); the insert
   does nothing on either key, so the same id again and the same body under another id are both `duplicate`, and
   two at once wait on each other's row as D-134 §5's id already did. Per feed, since the secret is: the same
   bytes to another feed are that feed's. Remembered as long as the ids are — `GITHUB_DELIVERIES_KEPT_DAYS`, by
   the same sweep — so a replay older than that posts again, as a redelivery that old would; GitHub redelivers
   only three days back. Two genuine deliveries with byte-identical bodies are not a case GitHub makes: every
   event carries what changed (a push's `after`, an issue's `updated_at`), and a redelivery has its first id.
   The digest, never the body: a copy of the database holds no event that was not posted.
2. **The sign-in link limit is per address *and client*, under a per-address ceiling** (amends D-138 §7). Five
   links an hour per address, whoever asked, let anybody send six requests for somebody's address each hour and
   keep them out of signing in by email. Now: twenty requests an hour from a client, as before; **five links an
   hour for an address from one client** — a stranger spends their own five, never the owner's, as a wrong
   password does (D-179 §4, `password-attempts.ts`), a client being its network (`limitKeyFor`); and **twenty
   for an address from every client**, so a mailbox is still not flooded. The ceiling is counted only past the
   client's five, so one client spends at most five of it. Still `202` whatever is decided, and nothing in the
   answer or its time says which limit held (D-138 §1). The counters are `rate_limits` rows under the address's
   digest — `…:address:<digest>` and `…:address:<digest>:client:<digest>` (`SCHEMA.md` §3.2) — and an erasure
   deletes them all by that prefix. Residual, accepted: someone with four networks can still spend an address's
   ceiling for the hour; that is a bar raised from one client to several, and the price of bounding a mailbox at
   all. Provisional with the rest of O-4.
3. **An attachment is the browser's to keep and the server's to allow, every time** (amends D-109 §6). A year's
   `immutable` let a member removed from a channel — or from the workspace — open every file of it their browser
   had kept. Downloads and thumbnails are now `Cache-Control: private, no-cache` with a tag (`"<id>-<variant>"`):
   the browser keeps the copy and asks before using it; the server checks the session and the reader's access as
   for any download, and only then answers `304` with nothing read from the store, or `404`. The bytes behind an id
   never change, so the tag needs nothing stored. The cost is a round trip per use of a kept copy — one session
   lookup and the one guarding query, no bytes — where there was none. **The image proxy keeps its day** (`private, max-age=86400`): its bytes are an
   image public where it lives, there is no access to withdraw from it, and asking again would mean fetching it
   from its server again through four slots a node.

**Considered and rejected.** *Signing the delivery id ourselves*, or *GitHub's timestamp*: GitHub signs neither,
and only the body is the sender's word. *Keeping deliveries' bodies*: the digest decides the same thing and holds
nothing. *A per-address limit with a challenge (CAPTCHA) past it*: a new dependency and a page D-138 does not have.
*A higher per-address limit alone*: it trades a lockout for a flood and fixes neither. *A short `max-age` on
attachments*: a window in which a removed member still opens the file — shorter, still there — for a saving the
`304` already makes. *`no-store`*: every view would download the bytes again, a cost the tag avoids. *The same
policy on the image proxy*: above.

**Cost of reversing.** §1: migration 0064 dropped in a new one and the insert's conflict narrowed back to the id.
§2: the client's key dropped from the address's count. §3: the header and the `304` branch in
`ingress/http/attachments.ts`. Each has its tests and mutations.

### D-232. An archived channel can be brought back, by an owner or an admin, as it was — amends D-123; closes #846

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** D-123 made archiving a soft delete that
keeps a channel's messages and memberships, but nothing could undo it: an archive by mistake — the common case —
left the history unreachable except through an export. The data was always there; only the way back was missing.

- **Who.** An owner or an admin, as archiving is. A member is `403`.
- **What they see.** `GET /api/workspaces/:workspaceId/archived-channels` answers name, type and when, the most
  recently archived first, at most `ARCHIVED_CHANNELS_MAX`: every public channel, and a private one only to a member
  of it. A private channel stays unseen by those outside it, archived or not (D-104); to them, restoring it is
  `404`, as any channel they cannot see.
- **What it does.** `POST /api/channels/:channelId/restore` clears `deleted_at` under the row's lock: messages,
  memberships, settings and feeds return as they were. Each member is sent `CHANNELS_UPDATED`, so it rejoins their
  sidebars without a reload. It is on the trail as `channel.restored`, with the name.
- **A name taken since is refused, not changed.** Archiving frees the name (`idx_channels_unique_name` holds live
  channels), so another channel may hold it now; that is `409 CHANNEL_NAME_TAKEN`, and the admin renames one of the
  two first. A restore that picked a new name on its own would bring back a channel nobody recognises.
- **Where.** A card on General, the page owners and admins already have, rather than a page of its own.

**Considered and rejected.** Restore under a new name in the same request (a second form for a rare case; renaming
the other channel first is one step). Listing archived private channels to every admin (it would tell them names
D-104 keeps from them; the audit trail's names are D-104's own, older trade). A time limit after which an archive
cannot be restored (retention already decides what an archived channel keeps).

**Cost of reversing.** Remove the two routes and the card; archived channels stay archived.

### D-233. The server's administrator suspends an account, and lifts it — builds on D-139 §5, D-179 §4.8, D-193; closes #848

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** When somebody left, the only ways to keep
them out were erasing their account (which tombstones their name in every conversation, D-139 §5) or removing them
from each workspace, which left them signed in to the server with every session they had. A security review named it;
a team offboarding a person needs it on the day they leave.

- **The server's administrator's, on Administration → Server → Accounts.** Accounts are found by name, username or
  address (words, never a pattern), at most `SERVER_ACCOUNTS_MAX`. A workspace's owner is not offered it: an account
  is the server's, not a workspace's (D-179 §4.8).
- **Suspended is `users.suspended_at`.** Set, every session of the account is deleted in the same transaction and
  each socket is sent `SESSION_ENDED` after the commit. A suspended account starts no session by any way in — the
  library's one session hook refuses it for GitHub, a password, a link and single sign-on alike — and the session
  seam refuses one that slipped past; the native application's handoff refuses it too. Memberships, messages and the
  name stay, so lifting it is the person as they were.
- **Never an administrator.** The caller's own account and another administrator's are `403`: a server whose
  administration suspended itself has no way back but the break-glass command. Demoting an administrator stays the
  operator's.
- **On the server's trail with whose account** (`server.account_suspended`, `server.account_restored`, in the new
  `server_audit_log.target_user_id`). Suspending a suspended account, or lifting one that is not, writes nothing.
- **A sign-in refused for a suspension says what any refused sign-in says.** Saying "suspended" would tell whoever
  holds a password that it is right.

**Considered and rejected.** The sign-in library's admin plugin and its ban (a second model of who administers the
server beside `is_server_admin`, and its ban expiry and reason fields are features nobody asked for). Suspension per
workspace (removing a member already exists; what was missing is keeping the person off the server). A reason or
an expiry on the suspension (YAGNI: lifting it is one click). Suspending from the Members page (a workspace's page,
for an act on the whole server).

**Cost of reversing.** Drop the column in a new migration — which lifts every suspension at once — and remove the card
and the three routes.

### D-234. Quiet hours: Deep Work every week, by itself, on the person's own clock — builds on D-15, D-108, D-131, D-148; closes #851

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** Deep Work (D-15) is started by hand and ends
by itself within hours; nothing kept the evenings and weekends quiet without starting it every day. A person who
installs Purlay on a phone (D-230) is then woken by what arrives at 23:00.

- **A window and its days.** `from` and `to` are minutes after midnight; `from` later than `to` runs past midnight,
  and the night belongs to the day it began — Friday's evening holds through Saturday's morning; a Saturday chosen
  for nothing starts no night. One pure function, `isQuietAt` in `@purlay/types`, decides it for the server and the
  client alike.
- **On the profile's clock.** The time zone a person set on their profile (D-131) is the one fact about where their
  day is; quiet hours are read on it, and refused without one, never guessed from the server's clock. Changing the
  profile's zone moves the window with it.
- **Held back as Deep Work holds it.** `inDeepWork` answers yes for a person in either, so a notification is written
  and counted as ever and marked `suppressed_by_deep_work`: no push reaches a device (D-126). The open page goes quiet
  as Deep Work makes it — no notice, no count in the tab (D-148) — re-read at each minute's turn.
- **Per person, not per workspace.** An evening is the person's in every workspace they are in; Deep Work stays per
  workspace as D-15 made it.

**Considered and rejected.** Several windows a day (a second form for a rare need; one window and Deep Work cover
lunch and evenings). A window per workspace (an evening does not change with the workspace). Ending a window early
from the menu (turn the setting off; Deep Work already has its own end). Treating quiet hours as a non-goal's
"reminder" or "scheduling" (D-4): nothing is sent later; what arrives is held back exactly as Deep Work holds it.

**Cost of reversing.** Drop the three columns in a new migration, the card and the two routes; `inDeepWork` returns to
the membership's flag alone.

### D-235. A name is the person's own to set, where it is not GitHub's — amends D-131; closes #853

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** D-131 kept the name and the picture as
GitHub's, shown and never edited — written when every account came from GitHub. Since D-138 and D-200 an account
can be made by an emailed link, by single sign-on or by the setup with a password; its name is made from its address
(`ada-lovelace`) and nothing let the person change it, so a team of such accounts read each other by handles.

- **Whose name it is.** An account GitHub made, and never connected otherwise (`github_id` set,
  `github_connected_at` null), takes GitHub's name at every sign-in (`recordGitHubSignIn`), so its name stays
  GitHub's: `GET /api/me` says `nameFromGitHub`, the profile shows the name and offers nothing to change, and a
  different `displayName` is `400` on that field. A client that sends the name it was shown changes nothing and is
  not refused. Every other account's name is its own: `displayName` on `PATCH /api/me/profile`, trimmed, held to the
  `name` format and `DISPLAY_NAME_MAX` like any name, never empty.
- **Heard as any profile change is** (D-131 §4): `WORKSPACE_UPDATED` to each workspace the person is in.
- **The picture is not part of it.** An account without GitHub's picture is drawn from its name, as before; a
  picture upload is a separate question about storage and moderation.

**Considered and rejected.** Letting GitHub accounts edit too (the next sign-in would write GitHub's back, so the
edit would last until then — a change that silently undoes itself). Stopping GitHub from writing the name (an account
whose name GitHub changed would drift from it with nothing said). A separate route for the name (the profile's route
already carries what the person says about themselves, and its frame).

**Cost of reversing.** Drop `displayName` from the request and `nameFromGitHub` from `GET /api/me` — an additive field
a client ignores — and remove the row from Profile; names already set stay.

