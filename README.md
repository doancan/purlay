# Purlay

**Self-hosted team chat for small engineering teams. Nothing is thrown away, and nothing
interrupts you by default.**

Purlay is for a 5–30 person engineering team that resents paying per seat for Slack and loses
its own answers to Slack's 90-day history limit. It is open source and self-hosted. There is no
per-seat cost, no message history limit, and no hosted version to upsell you.

> **Status: pre-alpha. No code yet.** The design is complete and documented; Phase 0 has not
> started. See [Project status](#project-status) before investing time. This README describes
> what is being built, not what runs today.

---

## What makes it different

**Threads that end in an answer.** A thread expands inline underneath its parent message — never
in a side drawer — and can be marked **Resolved**. Resolving collapses it and keeps it fully
searchable. A workspace-wide view lists every question still open.

**Quiet by default.** A direct `@username`, a DM, or a reply in a thread you asked in or joined.
`@here` and `@channel` are rejected by the message parser: they do not exist, rather than being
discouraged. Deep Work mode stops delivery on the server, not just the badge on your screen.

**Nothing is thrown away.** Full history, forever. Deleted messages are tombstoned, not erased.
Resolved threads stay searchable.

**Developer-native.** GitHub Flavored Markdown, fenced code blocks with a language badge and
line clamping, and GitHub PR/Issue links that render as live cards with CI and review status.

### What Purlay is not

No audio, video or screen sharing. No app marketplace. No workflow builder. No AI summaries. No
SAML. These are permanent non-goals, not a roadmap — refusing them is the product. The full list
is in [`docs/PRD.md`](docs/PRD.md) §6. (OIDC single sign-on is Phase 3 and gated on demand, not a
non-goal — see D-31.)

**If you are happy with [Zulip](https://zulip.com), stay there.** It has a better threading
model than ours and a decade of work behind it. Purlay differs by being lighter to operate and
by treating GitHub as native rather than as a bot integration. We would rather tell you that
than waste your afternoon.

---

## Project status

| Phase | Goal | Done when | State |
|---|---|---|---|
| **0** | Walking skeleton | Two tabs, two GitHub users, a message in real time that survives an API restart | **Not started** |
| **1** | MVP | The maintainer's own team stops opening Slack for 30 days | Not started |
| **2** | Community-ready | A stranger self-hosts it from this README without opening an issue | Not started |
| **3** | Polish | Desktop app, multi-node, mobile | Not started |

Self-hosting instructions land in Phase 2. Until then there is nothing to deploy.

---

## Documentation

The design is fully specified before implementation, deliberately. Read in this order:

| Document | Answers |
|---|---|
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | Start here — orientation and how the documents relate |
| [`docs/PRD.md`](docs/PRD.md) | Who it is for, what problem it solves, what ships when |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | **Why** — 36 decisions, each with its rejected alternatives |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, transport, protocol, tenant isolation |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | Tables, indexes, invariants, migration order |
| [`docs/UX.md`](docs/UX.md) | Layout, thread interaction, keyboard model, required states |
| [`docs/API.md`](docs/API.md) | HTTP endpoint contract |
| [`docs/CONFIG.md`](docs/CONFIG.md) | Environment variables |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | The ordered task list |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Rules contributors work under |

**`DECISIONS.md` wins any conflict between documents.** If two disagree, the other one is a bug.

---

## Planned stack

Bun + ElysiaJS · PostgreSQL 16 + Kysely · React 19 + Vite + Tailwind · TanStack Query + Zustand ·
S3-compatible object storage.

**No Redis, no message broker, no ORM.** A single node serving thirty people needs none of them,
and the seam to add one later already exists. Reasoning and accepted costs:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2.

---

## Contributing

Not open to outside contributions yet — the API and schema will churn heavily through Phase 0.
Issues and design feedback are welcome now; pull requests from Phase 2.

If you do work in this repository, read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. It applies to human and
AI contributors alike.

---

## License

[MIT](LICENSE) — use it, fork it, run it, sell it. Reasoning in
[`docs/DECISIONS.md`](docs/DECISIONS.md) D-24.
