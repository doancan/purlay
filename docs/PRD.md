# Purlay — Product Requirements (`PRD.md`)

> Authority: `DECISIONS.md` records *why* and is binding. This file records *what we are
> building and for whom*. `ARCHITECTURE.md` and `SCHEMA.md` record *how*.
> **Status:** Phase 1 — MVP, ends on what is built and verified (D-197). What is done is `bun run queue`, not a line here
> (`OVERVIEW.md`, Current status).

---

## 1. The Problem

A 5–30 person engineering team on Slack's free plan loses every message older than 90 days.
The answer to "why is the retry backoff 4 seconds?" was written down — in a thread, by someone
who has since left — and it is gone. The team's options are to pay per seat, forever, for
software whose feature surface they use maybe a fifth of, or to keep losing the answers.

Meanwhile the tool itself is heavy: hundreds of megabytes of RAM for a chat window, a sidebar
full of features nobody on the team has ever opened, and a notification model whose default is
to interrupt.

**Purlay exists to be sufficient for that team, self-hosted, at zero per-seat cost, with
nothing thrown away.**

### 1.1. Who this is for

**Primary — "the team lead who self-hosts."** Runs a 5–30 person engineering team. Comfortable
with `docker compose`. Already self-hosts something (Gitea, Plausible, an internal wiki).
Resents the Slack bill more than the Slack UI. Wants the team's knowledge on disks they
control.

**Also primary — "the same lead, who would rather not."** Identical in every respect except that
they do not want to be woken up by a database. They pay us to run it, and they can stop paying and
take the export with them — which is the only thing that makes this persona and the one above the
same product rather than two. (D-1, D-43)

**Secondary — "the engineer who lives in threads."** Asks a design question, gets three
answers, and wants the thread to end in a decision that stays findable. Pastes stack traces and
PR links all day.

**Not for:** enterprises needing SAML and third-party compliance attestations · non-technical
organizations · communities (that is Discord's job) · anyone who needs calls or screen sharing.

### 1.2. Why not the tools that already exist

Recorded honestly, because a differentiator we cannot defend is a differentiator that will not
survive contact with a real user. Full analysis in `DECISIONS.md` D-2.

- **Zulip** has a better threading model than ours and a decade of work behind it. We do not
  claim to beat it. We differ by being lighter to operate and by treating GitHub as native
  rather than as a bot. A team happy in Zulip is not our user.
- **Mattermost / Rocket.Chat** are self-hostable but chased enterprise parity and inherited
  Slack's complexity. Our differentiator is what we refuse to build (§6).
- **Discord** is free and already full of developers, but it cannot be self-hosted and is
  hostile to async work.

---

## 2. Product Identity

- **Name:** Purlay · **Domain:** `purlay.app` (project site and documentation)
- **License & model:** open source under **AGPL-3.0** (D-24), shipped two ways — self-hosted for
  free, or a cloud we operate for teams who would rather not (D-1). **No open core:** the cloud
  runs the same code, with nothing held back.
- **One-line positioning:** *Team chat for engineers — nothing is thrown away, nothing interrupts
  you by default. Run it yourself, or let us run it.*

### 2.1. Tenets

Each tenet is falsifiable. A feature that violates one is rejected regardless of how useful it
looks in isolation.

1. **Subtract before adding.** Every feature must displace a Slack feature the target team
   actually uses. Parity is not a reason. (D-2)
2. **The network is never in the way.** Typing and sending render immediately; the network
   reconciles afterwards. (D-17)
3. **Quiet by default.** Only a direct `@username` or a DM may interrupt. `@here` and
   `@channel` do not exist — they are rejected by the parser, not merely discouraged. (D-12)
4. **Nothing is thrown away.** No history limit. Deleted content is tombstoned, not erased.
   Resolved threads stay searchable. (D-9)
5. **The operator owns the data.** Self-hosted, with a portable export, and the export works
   identically in the cloud — leaving is a supported operation, not a support ticket. This is our
   answer to privacy, not client-side encryption, which would make search impossible. (D-4, D-27)

---

## 3. Success Criteria

Four audiences, four tests. Ordered: the first can kill a feature, the last cannot. (D-1)

| # | Audience | Success is | Failure looks like |
|---|---|---|---|
| **S-1** | Product quality | Every Phase 1 capability works end to end in a browser at both widths and themes, `bun run verify` passes, and the deployed build is the newest commit (D-197). | A capability that is listed but fails on a real screen, or a green build that nobody has looked at. |
| **S-2** | Self-hosting community | A stranger deploys it from the README without opening an issue, and comes back a week later. | Every deployment needs hand-holding. |
| **S-3** | Cloud customers | A team pays for a workspace, stays a second month, and never files a ticket that a self-hoster could not have solved from the README. | Revenue arrives with a support load that consumes the engineering budget. |
| **S-4** | Portfolio | A reviewer can trace any feature from `PRD.md` → `DECISIONS.md` → schema → code in under five minutes. | The code is fine but nobody can tell what was decided or why. |

**S-1 is the only gate on Phase 1**, and it is a check that can be run, not a habit to wait for
(D-197). **No cloud work begins until S-1 has been met and the self-host path (S-2) is real** (D-1).

---

## 4. Scope by Phase

Phase definitions are binding. A feature not listed in the current phase does not get built,
however small it seems. (D-4)

### Phase 0 — Walking Skeleton

**Exit criterion:** two browser tabs, signed in as two different GitHub users, exchange a
message in real time — and the message is still there after the API restarts.

- Monorepo, shared types package, migrations, local dev environment
- GitHub OAuth sign-in, database-backed sessions (D-11)
- One workspace, public channels, channel list
- Send and receive over WebSocket, with optimistic dispatch and ACK reconciliation
- Message history with keyset pagination (D-8)
- Minimal but real UI — not a placeholder

Nothing else. No threads, no markdown rendering, no uploads.

### Phase 1 — MVP (gates on S-1)

Everything a team needs to work in Purlay instead of a general-purpose chat product.

**4.1 · Messaging**
Resolvable threads · GitHub Flavored Markdown · fenced code blocks with language badge,
line count, copy-raw and clamping above 12 lines · emoji reactions · message edit and delete
(tombstoned) · typing indicators (ephemeral, D-7, D-114)

**4.2 · Threads — the wedge**
A thread opens in a **panel on the right of the feed**, and its root stays in the feed with the
thread's live status, so a conversation never becomes a footnote nobody sees (D-122, which replaced
threads expanding inline). A thread has a `Resolved` state, borrowed from GitHub PR review.
Resolving closes it and keeps it searchable. A workspace-wide "open questions" view lists
unresolved threads. Explicitly marked questions appear before the first answer; owners, unanswered filters and oldest-first ordering expose waiting questions. A thread can keep a selected answer, decision note and reference, with versioned editing (D-204).

**4.3 · Channels & DMs**
Public and private channels · DMs, workspace-scoped (D-6) · a DM to yourself, which is also the
scratchpad · invites and roles (owner/admin/member) · bringing people into a channel and taking
them out (D-104, D-172) · per-channel notification level

**4.4 · Attachments** (D-16)
Paste-to-upload for images · file size capped by the `attachment_size_limit` constraint
(`SCHEMA.md` §7.2, currently 25 MiB) · image thumbnails · per-workspace storage quota, shown
to owners and set by the operator (D-173)

**4.5 · Noise control** (D-12, D-15, D-29)
`@username` mentions · **thread participation** — a reply notifies the root author and everyone
who has already replied in that thread (D-29), and a person can follow a thread or let it go
(D-161) · in-app notification inbox · unread and
unread-mention counts · Deep Work mode, which suppresses **server-side delivery** and expires
automatically

`@here` and `@channel` stay rejected by the parser. Participation is not broadcast: an answer to
a question you asked is the thing you were waiting for, not an interruption.

**4.6 · Navigation & search** (D-10)
`Cmd/Ctrl+K` command palette over channels, DMs, people and settings · substring search scoped
to a workspace, optionally to a channel and to who wrote it (D-166), keyset-paginated. Status, question, date, code/file and repository filters, selected-answer/decision text matching, and personal saved searches extend this (D-204)

**4.7 · Administration** (D-26)
An append-only audit log of administrative actions — role changes, membership changes,
integration credentials, workspace and channel settings. Never message content.

**4.8 · GitHub**
Pasting a PR or Issue URL renders a card: title, state (`open`/`closed`/`merged`), author, CI
status, review decision. Cached in PostgreSQL (D-23). Workspace-level credential.

> **Stated plainly:** Phase 1 notifies **from the open page only**. A tab open in the background says
> what needs the person with its title, a dot on its icon and — with notifications on for that
> device — a notice from the browser (D-148). With the tab closed, Purlay is silent —
> unless the server has Web Push keys and the person turned notifications on for that device, which
> is Phase 2's, started early (D-125, D-126): then what needs them, and only that, reaches the
> device. Hiding this would fail dogfooding on day one. (D-12)

**Where it is dogfooded.** On the team's own server, provisionally — an internal deployment of the
same single-node shape a self-hoster runs, built so moving it is a move and not a rewrite. The
public self-host path and its documentation stay in Phase 2. (D-73)

### Phase 2 — Community-ready (gates on S-2)

`docker compose up` self-host path and operator documentation · GitHub webhook repo feeds ·
Web Push notifications · unified/split diff viewer for ` ```diff ` blocks · magic-link auth
(D-11) · message edit history · **retention policy, account erasure and workspace export**
(D-27) · **operator compliance documentation** — data map, retention and erasure runbooks (D-28) ·
online presence (ephemeral, D-7, D-120) · group conversations · saved items · pinned messages and a
channel's files · profiles with a title, a time zone and a status · starred channels · incident
channels (D-125) · every channel marked read at once (D-238) · a sign-in policy: two-step
verification required of a password, password sign-in off where GitHub or single sign-on serves (D-239) ·
opt-in email about direct messages and mentions left unread, at most one an hour (D-240) ·
a person's export of their own data (D-241) ·
GitHub issues from conversations, built in the order below — connecting the GitHub App, making an issue from a thread with the write recoverable, and linking and following existing issues and pull requests, are built (D-246)

**Next proposal: GitHub issues from conversations (D-246; built).** Build on the
existing workspace credential, link previews, signed webhooks and delivery deduplication. The
delivery order after questions, decisions and saved search is:

1. **Connect a GitHub App.** An owner connects an installation and chooses repositories. Request
   Issues write for issue creation and Pull requests read only when PR tracking is introduced.
   A person's write uses an App user access token, limited to repositories both that person and
   the App can access. Keep shared previews under the existing workspace visibility rule; never
   use personal tokens to populate shared cards. Record this distinction from D-11 before
   implementation. Seal refresh credentials, handle revocation and installation removal, and
   retain existing read-only integrations during rollout.
2. **Review and create an issue from a thread.** Offer a repository, editable title and body,
   selected answer, decision note and Purlay source link. Show the exact text and destination
   before the person presses Create; copying private-channel text is an explicit choice. Check
   channel membership and GitHub access again at submission. Start with title/body; labels and
   assignees follow once their additional user permissions have been handled. A successful issue
   is linked back to the root. Selecting or creating an issue does not resolve the question.
3. **Keep linked work current.** Link an existing issue or PR too. Route signed issue/PR events
   into that thread, deduplicate delivery ids and coalesce repeated state updates. Show open,
   closed and merged state, while keeping question resolution an explicit Purlay action. Respect
   the existing notification preference and Deep Work behavior.
4. **Make writes recoverable before enabling them.** Add shared contracts for connection status,
   allowed repositories, create/link requests and pending/created/unknown/refused outcomes.
   Persist workspace installations, sealed user authorizations, root-to-GitHub links and a
   bounded operation record keyed by workspace, actor and client request id. Reusing an id with
   different content is a conflict. After an ambiguous POST timeout, reconcile a unique operation
   marker through GitHub reads/webhooks; do not blindly repeat creation. Obey Retry-After and
   bound retries. Audit actor, repository and issue identifiers without bodies or secrets.

Acceptance covers tenant/private-channel isolation, revoked access, simultaneous clicks, a lost
create response, duplicate/out-of-order webhooks, rate limits and English/Turkish browser flows.
Use API doubles and disposable test repositories. Roll out behind an installation capability;
disabling writes preserves existing issue links and the read-only integration. This proposal
creates no GitHub application, credentials or issues by itself.

Permission and API behavior were checked on 2026-10-28 against GitHub's
[App user token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[create issue contract](https://docs.github.com/en/rest/issues/issues#create-an-issue),
[REST API guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
and [webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
The delivery sequence and reconciliation protocol above are Purlay design proposals.

### Phase 2.5 — Cloud (v0.4.0)

Gates on S-3, and **cannot start before S-1 is met and S-2 is real**. (D-1)

Multi-node deployment behind a sticky load balancer with the shared `EventBus`, `PresenceRegistry`
and `RateLimiter` adapters (D-7, D-25) · per-workspace subscription billing through a merchant of
record (D-43) · transactional email · point-in-time recovery with a tested restore · error
tracking, uptime monitoring and a status page (D-44) · the data processing agreement and
subprocessor list (D-28) · retention as a plan attribute (D-27)

> **Nothing here is a feature self-hosters do not get.** The cloud sells operation, not
> capability (D-1).

### Phase 3 — Polish

**native macOS client in Swift, in its own repository** (D-186) · **mobile as an installable
progressive web application** — one client, not a second codebase (D-51), installable since D-230 · multi-node scale-out via a Redis-backed event
bus (D-7, D-25) · **OIDC single sign-on, built** (D-31, D-200)

> **Native Swift exists for macOS only** (D-186, which supersedes D-51 here). Mobile stays an
> installable web application, Windows and Linux use the web client, and no native iOS client is
> planned. The macOS client has its own track in its own repository and does not wait for this phase.

---

## 5. Quality Requirements

Measured, not asserted. Every figure below is CI-enforceable. (D-17)

| Metric | Budget |
|---|---|
| Keystroke → own message painted | < 16 ms — one frame, never awaits the network |
| Server ACK round-trip, p95, same region | < 120 ms |
| Fan-out to other connected clients, p95 | < 200 ms |
| Cold load to interactive channel, warm cache | < 1.5 s |
| Initial JS bundle, gzipped | < 400 KB — a backstop against an accident, not a ceiling for features; what a person feels is time, which the rows above budget (D-196). The empty shell already spends ~60 KB of it, measured (`docs/spikes/web-client.md`) |
| Channel switch, 50 cached messages | < 100 ms |
| API idle RSS, single node | < 120 MB |

**Cloud service levels (Phase 2.5).** A published RPO and RTO, an uptime target measured by an
external monitor against `/health/ready`, and a restore rehearsed on a schedule with the result
recorded — an untested backup is a belief, not a backup (D-44). Self-hosted deployments carry no
service level; that is the operator's own business.

**Capacity.** These budgets are measured at the Phase 0–2 build target — 300 concurrent sockets,
20 messages/second peak, one API process. The multi-node ceiling and the numeric triggers that
open Phase 3 live in `DECISIONS.md` D-25, which owns that fact.

**How the budgets are enforced (D-49).** The two that are deterministic — **initial JS bundle**
and **API idle RSS** — are measured on every pull request and **block the merge**. The five that
depend on a running system are recorded per commit and block on a **regression**, not on an
absolute threshold: a p95 measured on a shared runner moves by tens of percent between identical
runs, and a check people learn to re-run stops being a check at all. The bundle budget is the
urgent one, because it is the constraint that decides the markdown renderer, the highlighter and
the i18n approach — all still unchosen.

**Accessibility:** full keyboard navigation, visible focus, WCAG AA contrast, screen-reader
labels on interactive controls. A tool this keyboard-driven has no excuse. **Verified in CI** by
`axe` on every screen and a keyboard-path test per screen — a stated requirement with no check is
not a requirement. (D-52)

**Reliability:** a dropped socket reconnects with exponential backoff and replays missed
messages by keyset cursor. Unacknowledged sends surface as `failed` with a retry action after
3 s, and are never silently dropped.

---

## 6. Non-Goals

Refusing these **is** the product. Each is permanent, not deferred. (D-4)

Audio / video / WebRTC · screen sharing · an app marketplace or plugin directory · a visual
workflow or automation builder · AI summarization · end-to-end zero-knowledge encryption
(incompatible with server-side search; self-hosting is our privacy answer) · custom emoji
management UI · Slack import fidelity · **per-seat billing** · **open core** · message scheduling ·
polls · reminders · status emoji · SAML · a SOC 2 / ISO certification programme until a customer
contractually requires one (D-28)

> **Billing left this list on 2026-09-09; per-seat billing did not.** D-1 added a cloud, so
> subscription billing is now built (D-43) — but charging by seat would contradict the cost axis
> D-2 competes on and the first paragraph of `README.md`. The cloud charges per workspace, so
> adding a teammate never costs more. **Open core joined the list** in the same change: the cloud
> sells operation, never withheld capability.

> **SSO left this list on 2026-09-09.** D-25 set a multi-node capacity ceiling and D-26 added an
> audit log; both describe an organisation that has an identity provider, so "never SSO" had
> become an internal contradiction. It is now **OIDC** (D-31), built by D-200 without the wait for a request. SAML
> itself stays permanently refused — XML signature handling for the same outcome at ten times the
> cost. A non-goal that another decision contradicts teaches readers the whole list is
> negotiable, which is why this is stated plainly rather than quietly reworded.

**Cut from earlier drafts, with reasons in D-5:** cross-workspace DMs · a separate scratchpad
entity · magic-link auth in MVP · GitHub webhook feeds in MVP · Tauri in MVP · Redis in MVP.

---

## 7. Open Questions

One question is deliberately unresolved, O-4; it is closed by measuring Phase 1 under load.
Each is recorded with its context, its candidate answers and the phase it must be decided in.

> **Single source of truth:** `DECISIONS.md` Part D. Summarised here only as a pointer —
> ~~O-1 message editing~~ (closed by D-103) · ~~O-2 invitations~~ (closed by D-115) · ~~O-3 retention & export~~ (closed by D-27) ·
> ~~O-6 the markdown packages~~ (closed by D-101) · ~~O-7 the palette's base~~ (closed by D-98 §7) ·
> ~~O-5 list virtualization~~ (closed by D-199) · O-4 rate limiting.

A task that runs into one of these has found a decision to be made, not a gap to be filled
quietly. Stop and decide it, then record it as a numbered decision.
