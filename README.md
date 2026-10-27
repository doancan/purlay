# Purlay

**Team chat for small engineering teams. Nothing is thrown away, and nothing interrupts you by
default. Run it yourself, or let us run it.**

Purlay is for a 5–30 person engineering team that resents paying per seat for Slack and loses its
own answers to Slack's 90-day history limit.

It is open source, and it ships two ways: **run it yourself for free, forever**, or **let us run
it** for a flat price per workspace. Both are the same code — there is no paid tier of features
held back from self-hosters, and there never will be. **Adding a teammate never costs more**, on
either one.

> **Status: pre-alpha, and not usable yet.** Work is in Phase 0; how far along it is lives on the
> issue board, not here — see [Project status](#project-status). This README describes what is
> being built, not what runs today.

---

## What makes it different

**Threads that end in an answer.** A thread opens in a panel beside the conversation, while its
question stays in the feed with its status, and can be marked **Resolved**. Resolving closes it and
keeps it fully searchable. A workspace-wide view lists every question still open.

**Quiet by default.** A direct `@username`, a DM, or a reply in a thread you asked in or joined.
`@here` and `@channel` are rejected by the message parser: they do not exist, rather than being
discouraged. Deep Work mode stops delivery on the server, not just the badge on your screen.

**Nothing is thrown away.** Full history, forever, on a server you run. Deleted messages are
tombstoned, not erased. Resolved threads stay searchable. In the cloud, history length is part of
the plan — the disk is ours there — and the export is the same one command either way.

**Developer-native.** GitHub Flavored Markdown, fenced code blocks with a language badge and
line clamping, and GitHub PR/Issue links that render as live cards with CI and review status.

### What Purlay is not

No audio, video or screen sharing. No app marketplace. No workflow builder. No AI summaries. No
SAML. **No open core, and no per-seat pricing.** These are permanent non-goals, not a roadmap —
refusing them is the product. The full list is in [`docs/PRD.md`](docs/PRD.md) §6. (OIDC single
sign-on is gated on demand rather than refused — see D-31.)

**If you are happy with [Zulip](https://zulip.com), stay there.** It has a better threading
model than ours and a decade of work behind it. Purlay differs by being lighter to operate and
by treating GitHub as native rather than as a bot integration. We would rather tell you that
than waste your afternoon.

---

## Project status

| Phase | Goal | Done when |
|---|---|---|
| **0** | Walking skeleton | Two tabs, two GitHub users, a message in real time that survives an API restart |
| **1** | MVP | The maintainer's own team stops opening Slack for 30 days |
| **2** | Community-ready | A stranger self-hosts it from this README without opening an issue |
| **2.5** | Cloud | A team pays for a workspace and stays a second month |
| **3** | Polish | Desktop app, mobile |

Where each phase stands is the milestone of the same number on the issue board, and
`bun run queue` prints what is startable now. Not a column here: a progress line in a document is
wrong the day the next pull request merges — this one said *not started* about a phase whose server
was nearly built.

## Self-hosting

On a server with Docker and the compose plugin, and a public name whose ports 80 and 443 reach it:

1. `cp docker/production.env.example production.env`, and fill in every empty value; each says how to
   make it. Keep the file private.
2. `docker compose -f docker-compose.production.yml --env-file production.env up -d --wait`
3. Read the one-time setup code from the log — `docker compose -f docker-compose.production.yml
   --env-file production.env logs api | grep 'SETUP CODE'` — and open `https://<your name>/setup`.

That is all of the terminal: the database migrates as the API starts, the object store is prepared
on the way, and the certificate is issued. The rest is the page: the code, the administrator (name,
address and password), the sign-up policy, how other people sign in — **GitHub** (an OAuth app of your
own, whose callback address the page shows) and/or **email** (a mail server, tried for real with a
letter to the administrator that also verifies the address) — the first workspace, and the first
invitations. Setup does not finish until at least one way for other people to sign in has been tried
and worked; skipping both is said, not allowed. Everything it asked can be changed afterwards under
*Administration → Server*, and the sign-up policy is *invite-only* unless you choose otherwise.
Nobody else may make a workspace unless `WORKSPACE_CREATORS` names them; everyone else is invited.
Every variable is in [`docs/CONFIG.md`](docs/CONFIG.md), with backups, restores and upgrades
("Production deployment") and the setup code in full; what personal data the instance holds, and how
to erase it, is [`docs/DATA.md`](docs/DATA.md).

---

## Documentation

The design is fully specified before implementation, deliberately. Read in this order:

| Document | Answers |
|---|---|
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | Start here — orientation and how the documents relate |
| [`docs/PRD.md`](docs/PRD.md) | Who it is for, what problem it solves, what ships when |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | **Why** — 194 decisions, each with its rejected alternatives |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, transport, protocol, tenant isolation |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | Tables, indexes, invariants, migration order |
| [`docs/UX.md`](docs/UX.md) | Layout, thread interaction, keyboard model, required states |
| [`docs/API.md`](docs/API.md) | HTTP endpoint contract |
| [`docs/CONFIG.md`](docs/CONFIG.md) | Environment variables |
| [`docs/DATA.md`](docs/DATA.md) | For an operator: the personal data an instance holds, and how to keep a retention window and carry out an erasure |
| [Issues & board](https://github.com/doancan/purlay/issues) | The ordered task list — one issue per task, milestoned by version |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Rules contributors work under |

**`DECISIONS.md` wins any conflict between documents.** If two disagree, the other one is a bug.

---

## Planned stack

Bun + ElysiaJS · PostgreSQL + Kysely · React + Vite + Tailwind · TanStack Query + Zustand ·
S3-compatible object storage. Versions, and the cost accepted for each, live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2 — repeating them here is how one copy goes
stale.

**Self-hosted needs no Redis, no message broker and no ORM.** A single node serving thirty people
needs none of them, and that path stays broker-free permanently. The cloud runs several nodes and
swaps in shared adapters behind the same interfaces — a self-hoster is never made to install
infrastructure so that our hosting can scale. Reasoning and accepted costs:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2.

---

## Contributing

Not open to outside contributions yet — the API and schema will churn heavily through Phase 0, and
the CLA is not in place. Issues and design feedback are welcome now; pull requests from Phase 2.

If you do work in this repository, read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. It applies to human and
AI contributors alike.

---

## License

**[AGPL-3.0](LICENSE)** — run it, fork it, modify it. If you run a modified version as a network
service, publish your changes. Running it inside your own company creates no obligation at all.

Outside contributions require a CLA, so that the project can keep offering a commercial licence to
teams whose policies do not permit AGPL: [`CLA.md`](CLA.md) is the agreement, and you sign it by
adding yourself to `.github/cla-signatures.json` in your first pull request; you keep the copyright
in what you write. Reasoning, and the alternatives rejected, in [`docs/DECISIONS.md`](docs/DECISIONS.md)
D-24 and D-145.
