# Purlay — Product Requirements (`PRD.md`)

> Authority: `DECISIONS.md` records *why* and is binding. This file records *what we are
> building and for whom*. `ARCHITECTURE.md` and `SCHEMA.md` record *how*.
> **Status:** Phase 0 not started.

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
| **S-1** | The owner's own team | The team stops opening Slack for internal discussion, and stays off it for 30 consecutive days. | People keep a Slack tab open "for the important stuff." |
| **S-2** | Self-hosting community | A stranger deploys it from the README without opening an issue, and comes back a week later. | Every deployment needs hand-holding. |
| **S-3** | Cloud customers | A team pays for a workspace, stays a second month, and never files a ticket that a self-hoster could not have solved from the README. | Revenue arrives with a support load that consumes the engineering budget. |
| **S-4** | Portfolio | A reviewer can trace any feature from `PRD.md` → `DECISIONS.md` → schema → code in under five minutes. | The code is fine but nobody can tell what was decided or why. |

**S-1 is the only gate on Phase 1.** If the owner's team will not switch, no amount of community
interest or revenue makes the product real — and **no cloud work begins until S-1 has been met**
(D-1).

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

Everything the owner's team needs to abandon Slack.

**4.1 · Messaging**
Resolvable threads · GitHub Flavored Markdown · fenced code blocks with language badge,
line count, copy-raw and clamping above 12 lines · emoji reactions · message edit and delete
(tombstoned) · typing indicators (ephemeral, D-7, D-114)

**4.2 · Threads — the wedge**
A thread opens in a **panel on the right of the feed**, and its root stays in the feed with the
thread's live status, so a conversation never becomes a footnote nobody sees (D-122, which replaced
threads expanding inline). A thread has a `Resolved` state, borrowed from GitHub PR review.
Resolving closes it and keeps it searchable. A workspace-wide "open questions" view lists
unresolved threads.

**4.3 · Channels & DMs**
Public and private channels · DMs, workspace-scoped (D-6) · a DM to yourself, which is also the
scratchpad · invites and roles (owner/admin/member) · per-channel notification level

**4.4 · Attachments** (D-16)
Paste-to-upload for images · file size capped by the `attachment_size_limit` constraint
(`SCHEMA.md` §7.2, currently 25 MiB) · image thumbnails · per-workspace storage quota

**4.5 · Noise control** (D-12, D-15, D-29)
`@username` mentions · **thread participation** — a reply notifies the root author and everyone
who has already replied in that thread (D-29) · in-app notification inbox · unread and
unread-mention counts · Deep Work mode, which suppresses **server-side delivery** and expires
automatically

`@here` and `@channel` stay rejected by the parser. Participation is not broadcast: an answer to
a question you asked is the thing you were waiting for, not an interruption.

**4.6 · Navigation & search** (D-10)
`Cmd/Ctrl+K` command palette over channels, DMs, people and settings · substring search scoped
to a workspace, optionally to a channel, keyset-paginated

**4.7 · Administration** (D-26)
An append-only audit log of administrative actions — role changes, membership changes,
integration credentials, workspace and channel settings. Never message content.

**4.8 · GitHub**
Pasting a PR or Issue URL renders a card: title, state (`open`/`closed`/`merged`), author, CI
status, review decision. Cached in PostgreSQL (D-23). Workspace-level credential.

> **Stated plainly:** Phase 1 notifies **in-app only**. With the tab closed, Purlay is silent —
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
channels (D-125)

### Phase 2.5 — Cloud (v0.4.0)

Gates on S-3, and **cannot start before S-1 is met**. (D-1)

Multi-node deployment behind a sticky load balancer with the shared `EventBus`, `PresenceRegistry`
and `RateLimiter` adapters (D-7, D-25) · per-workspace subscription billing through a merchant of
record (D-43) · transactional email · point-in-time recovery with a tested restore · error
tracking, uptime monitoring and a status page (D-44) · the data processing agreement and
subprocessor list (D-28) · retention as a plan attribute (D-27)

> **Nothing here is a feature self-hosters do not get.** The cloud sells operation, not
> capability (D-1).

### Phase 3 — Polish

Tauri desktop shell (D-14) · **mobile as an installable progressive web application** — one
client in a shell, not a second codebase (D-51) · multi-node scale-out via a Redis-backed event
bus (D-7, D-25) · **OIDC single sign-on, gated on demand** (D-31)

> **Native Swift clients are not planned** — not deferred (D-51). The bar for desktop and mobile is
> polish, not platform nativeness, which is the trade every interface exemplar we measure against
> has also made.

---

## 5. Quality Requirements

Measured, not asserted. Every figure below is CI-enforceable. (D-17)

| Metric | Budget |
|---|---|
| Keystroke → own message painted | < 16 ms — one frame, never awaits the network |
| Server ACK round-trip, p95, same region | < 120 ms |
| Fan-out to other connected clients, p95 | < 200 ms |
| Cold load to interactive channel, warm cache | < 1.5 s |
| Initial JS bundle, gzipped | < 250 KB — the empty shell already spends ~60 KB of it, measured (`docs/spikes/web-client.md`) |
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
> become an internal contradiction. It is now **OIDC, Phase 3, gated on demand** (D-31). SAML
> itself stays permanently refused — XML signature handling for the same outcome at ten times the
> cost. A non-goal that another decision contradicts teaches readers the whole list is
> negotiable, which is why this is stated plainly rather than quietly reworded.

**Cut from earlier drafts, with reasons in D-5:** cross-workspace DMs · a separate scratchpad
entity · magic-link auth in MVP · GitHub webhook feeds in MVP · Tauri in MVP · Redis in MVP.

---

## 7. Open Questions

Four questions are deliberately unresolved — O-3 was closed by D-27. None blocks Phase 0. Each
is recorded with its context, its candidate answers and the phase it must be decided in.

> **Single source of truth:** `DECISIONS.md` Part D. Summarised here only as a pointer —
> ~~O-1 message editing~~ (closed by D-103) · ~~O-2 invitations~~ (closed by D-115) · ~~O-3 retention & export~~ (closed by D-27) ·
> O-4 rate limiting · O-5 list virtualization.

A task that runs into one of these has found a decision to be made, not a gap to be filled
quietly. Stop and decide it, then record it as a numbered decision.
