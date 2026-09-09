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
- **License & model:** open source, self-hosted. Not a SaaS. (D-1)
- **One-line positioning:** *Team chat for engineers who self-host — nothing is thrown away,
  nothing interrupts you by default.*

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
5. **The operator owns the data.** Self-hosted, with a portable export. This is our answer to
   privacy — not client-side encryption, which would make search impossible. (D-4)

---

## 3. Success Criteria

Three audiences, three tests. Ordered: the first can kill a feature, the third cannot. (D-1)

| # | Audience | Success is | Failure looks like |
|---|---|---|---|
| **S-1** | The owner's own team | The team stops opening Slack for internal discussion, and stays off it for 30 consecutive days. | People keep a Slack tab open "for the important stuff." |
| **S-2** | Self-hosting community | A stranger deploys it from the README without opening an issue, and comes back a week later. | Every deployment needs hand-holding. |
| **S-3** | Portfolio | A reviewer can trace any feature from `PRD.md` → `DECISIONS.md` → schema → code in under five minutes. | The code is fine but nobody can tell what was decided or why. |

**S-1 is the only gate on Phase 1.** If the owner's team will not switch, no amount of
community interest makes the product real.

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
Inline resolvable threads · GitHub Flavored Markdown · fenced code blocks with language badge,
line count, copy-raw and clamping above 12 lines · emoji reactions · message edit and delete
(tombstoned) · typing indicators and presence (ephemeral, D-7)

**4.2 · Threads — the wedge**
Threads expand and collapse **inline, underneath the parent, in the main feed**. No right-hand
drawer: a drawer makes a conversation feel like a footnote, which is exactly how knowledge gets
lost. A thread has a `Resolved` state, borrowed from GitHub PR review. Resolving auto-collapses
it and keeps it searchable. A workspace-wide "open questions" view lists unresolved threads.

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

**4.6b · Administration** (D-26)
An append-only audit log of administrative actions — role changes, membership changes,
integration credentials, workspace and channel settings. Never message content.

**4.7 · GitHub**
Pasting a PR or Issue URL renders a card: title, state (`open`/`closed`/`merged`), author, CI
status, review decision. Cached in PostgreSQL (D-23). Workspace-level credential.

> **Stated plainly:** Phase 1 notifies **in-app only**. With the tab closed, Purlay is silent.
> Web Push is Phase 2. Hiding this would fail dogfooding on day one. (D-12)

### Phase 2 — Community-ready (gates on S-2)

`docker compose up` self-host path and operator documentation · GitHub webhook repo feeds ·
Web Push notifications · unified/split diff viewer for ` ```diff ` blocks · magic-link auth
(D-11) · message edit history · **retention policy, account erasure and workspace export**
(D-27) · **operator compliance documentation** — data map, retention and erasure runbooks (D-28)

### Phase 3 — Polish

Tauri desktop shell (D-14) · multi-node scale-out via a Redis-backed event bus (D-7, D-25) ·
**OIDC single sign-on, gated on demand** (D-31) · mobile client

---

## 5. Quality Requirements

Measured, not asserted. Every figure below is CI-enforceable. (D-17)

| Metric | Budget |
|---|---|
| Keystroke → own message painted | < 16 ms — one frame, never awaits the network |
| Server ACK round-trip, p95, same region | < 120 ms |
| Fan-out to other connected clients, p95 | < 200 ms |
| Cold load to interactive channel, warm cache | < 1.5 s |
| Initial JS bundle, gzipped | < 250 KB |
| Channel switch, 50 cached messages | < 100 ms |
| API idle RSS, single node | < 120 MB |

**Capacity.** These budgets are measured at the Phase 0–2 build target — 300 concurrent sockets,
20 messages/second peak, one API process. The multi-node ceiling and the numeric triggers that
open Phase 3 live in `DECISIONS.md` D-25, which owns that fact.

**Accessibility:** full keyboard navigation, visible focus, WCAG AA contrast, screen-reader
labels on interactive controls. A tool this keyboard-driven has no excuse.

**Reliability:** a dropped socket reconnects with exponential backoff and replays missed
messages by keyset cursor. Unacknowledged sends surface as `failed` with a retry action after
3 s, and are never silently dropped.

---

## 6. Non-Goals

Refusing these **is** the product. Each is permanent, not deferred. (D-4)

Audio / video / WebRTC · screen sharing · an app marketplace or plugin directory · a visual
workflow or automation builder · AI summarization · end-to-end zero-knowledge encryption
(incompatible with server-side search; self-hosting is our privacy answer) · custom emoji
management UI · Slack import fidelity · per-seat billing · message scheduling · polls ·
reminders · status emoji · SAML · a SOC 2 / ISO certification programme (D-28)

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
> O-1 message editing · O-2 invitations · ~~O-3 retention & export~~ (closed by D-27) ·
> O-4 rate limiting · O-5 list virtualization.

A task that runs into one of these has found a decision to be made, not a gap to be filled
quietly. Stop and decide it, then record it as a numbered decision.
