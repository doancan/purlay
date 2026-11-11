# Purlay

**Team chat for small businesses and corporate teams. Searchable conversations, direct messages and
shared files, with optional modules. Self-host it or use our cloud.**

Purlay is open source (AGPL-3.0) and ships two ways: **run it yourself for free**, or let us run it
for a flat price per workspace. Both are the same code, with no features held back from
self-hosters. **Adding a teammate never costs more**, on either one.

> **Status: pre-1.0.** See [releases](https://github.com/doancan/purlay/releases) for the current
> version. The API and schema still change between releases; read
> [What is not built yet](#status-and-what-is-not-built-yet) before depending on it.

---

## What it is

Purlay centers everyday work on team chat. Its **core** and optional **modules** let a small
business or a corporate department use the parts it needs without a development workflow.

The core owns what every workspace needs whatever else it runs: workspaces and members, sign-in,
a personal inbox, search, a transactional outbox for facts between modules, editions and
entitlements, and an administrator's console. The core knows no module by name.

Modules are the things people do in a workspace. Two exist today:

- **Chat** — channels, direct messages and threads that end in an answer.
- **Issues** — a workspace's issues, assignable, with their own list and search.

A third, **tasks**, is the next one planned and is not built yet. Which modules a process runs is a
setting (`MODULES`), and which a workspace may use is an entitlement; the data of a module that is
off is kept, exported and erased like any other.

## Features

- **Chat.** Channels and DMs with GitHub Flavored Markdown, fenced code with a language badge, and
  GitHub PR and issue links rendered as live cards. A thread opens in a panel beside its question,
  which stays in the feed with a status and can be marked **Resolved**; resolved threads stay
  searchable. PDF attachments read inside the conversation, and channels can be grouped under
  personal headings.
- **Issues.** A module of its own over the same core; assigning an issue tells the assignee in the
  inbox and by push, in the same step as the assignment.
- **Realtime.** Messages and updates arrive over a socket and survive an API restart; every action
  paints first and reconciles after, and a failed send shows as failed with a retry.
- **Search.** One workspace-wide find that answers a group of hits per source (messages a person
  may read, the workspace's issues) and says which source it skipped and why, so a slow module
  cannot hold the others up. It works with chat turned off.
- **Notifications and inbox.** Quiet by default: a direct `@username`, a DM, or a reply in a thread
  you joined. `@here` and `@channel` do not exist. The inbox lists Mentions, Direct, Threads and
  *Updates* (what modules told you). Push is held by Deep Work and quiet hours on the server, not
  just hidden on your screen.
- **Editions and entitlements.** A server administrator grants a workspace a module or withholds
  it, for good or until a time, with `WORKSPACE_MODULES=open|managed` as the default and
  `bun run entitlements:apply` to apply a file of editions. Every change is on the audit trail.
- **Administration.** An admin console for the server and its workspaces, a browser-based first-run
  setup, module stop and resume (`bun run module:suspend` / `module:resume`), workspace export
  (`bun run export:workspace`) and content erasure (`bun run erase:content`).
- **Sign-in.** GitHub and/or email, and OIDC single sign-on.

## Architecture in brief

One build, one process (or several nodes of the same build), and PostgreSQL. The self-hosted path
needs no Redis, no message broker and no ORM. The stack (Bun, ElysiaJS, PostgreSQL with Kysely,
React with Vite and Tailwind) and the reasons for it are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2.

Every module declares a **manifest**, and that is the whole of how it joins the product. Modules do
not import one another; they talk through four contracts the core owns:

| To do this | A module uses | If the partner module is absent |
|---|---|---|
| Tell a person something | A notice written to the core's **inbox** through the `NotificationSink` port, in the module's own transaction | The sink refuses a kind that no running module declares |
| Be found | A **search source** the core's find calls, with a time limit | The find skips it and says so |
| Tell another module something | A **fact** published through the **transactional outbox** (written in the publisher's transaction, delivered later, once per consumer) | The fact's declared `absent` policy: dropped, or held for up to 14 days |
| Read something another module owns | A **port** it `use`s, or a link that is a view | The port is `undefined`, and the module says in code what it does instead |

A module declares how it degrades without each optional partner (`degrades`), and tests compose the
build without the partner to prove it. The rules, and the checklist a reviewer holds a module to,
are [`docs/MODULES.md`](docs/MODULES.md).

## Quick start (development)

You need [Bun](https://bun.sh) and Docker with the compose plugin.

```bash
bun install
cp .env.example .env             # what the dev servers read
cp .env.test.example .env.test   # the tests' database address
bun run db:up                    # PostgreSQL and object storage, waits until healthy
bun run db:migrate
bun run dev                      # API and web
```

Without `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env`, `bun run dev` starts a seeded demo
on the same port, with people to sign in as; set both and it signs in through GitHub.
`bun run config:example` regenerates the `.env.example` template. The full set of commands, and
how the two environment files differ, is [`CONTRIBUTING.md`](CONTRIBUTING.md) §2. `bun run verify`
is the gate every change passes.

There is no Docker-free installation guide: the documents describe PostgreSQL and object storage
through the repository's compose files only.

## Self-hosting

On a Linux server with Docker, the Compose plugin and a public name whose ports 80 and 443 reach
it, follow [`docs/DEPLOY.md`](docs/DEPLOY.md): GitHub Actions publishes the image and the server
pulls it, so nothing is built on the server. The database migrates as the API starts, the
certificate is issued, and the rest is a page: open `/setup` with the one-time code from the log
and set up the administrator, sign-in, the first workspace and the first invitations. Every
environment variable, with backups, restores and upgrades, is in
[`docs/CONFIG.md`](docs/CONFIG.md). What personal data an instance holds, and how to erase it, is
[`docs/DATA.md`](docs/DATA.md). `MODULES` picks the modules a process runs; unset runs all of them.

## Writing a module

`bun run module:new <id>` generates a module that compiles and passes the guards: manifest, routes,
a migration, wire types and the registrations. [`docs/MODULE-GUIDE.md`](docs/MODULE-GUIDE.md) says
what to run and write, task by task; [`docs/MODULES.md`](docs/MODULES.md) is the design and the
checklist.

**Modules are built in this repository.** Out-of-tree and third-party modules are not supported, by
design: there is no plugin API and no marketplace (a permanent non-goal), so a module is code
reviewed and released with the core.

## What Purlay is not

No audio, video or screen sharing. No app marketplace or plugin directory. No workflow builder. No
AI summaries. No SAML. **No open core, and no per-seat pricing.** These are permanent non-goals,
not a roadmap; the full list is in [`docs/PRD.md`](docs/PRD.md) §6. OIDC single sign-on is built.

If [Zulip](https://zulip.com) already suits you, it has a better threading model and a decade of
work behind it. Purlay differs by being light to operate, modular, and treating GitHub as native.

## Documentation

The design is specified before it is implemented. `DECISIONS.md` wins any conflict between
documents.

| Document | Answers |
|---|---|
| [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | Start here: orientation and how the documents relate |
| [`docs/PRD.md`](docs/PRD.md) | Who it is for, what problem it solves, what ships when, non-goals |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | **Why** — 305 decisions, each with its rejected alternatives |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, transport, protocol, tenant isolation |
| [`docs/MODULES.md`](docs/MODULES.md) | How a module is declared, loaded, kept apart and removed |
| [`docs/MODULE-GUIDE.md`](docs/MODULE-GUIDE.md) | What to run and write to add a module |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | Tables, indexes, invariants, migration order |
| [`docs/UX.md`](docs/UX.md) | Layout, thread interaction, keyboard model, required states |
| [`docs/API.md`](docs/API.md) | HTTP endpoint contract |
| [`docs/CONFIG.md`](docs/CONFIG.md) | Environment variables |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Installing and updating a server |
| [`docs/DATA.md`](docs/DATA.md) | For an operator: personal data, retention and erasure |
| [Issues and board](https://github.com/doancan/purlay/issues) | The ordered task list |
| [`docs/changelog/`](docs/changelog) | What each release changed |

## Status and what is not built yet

Version 0.5.0 (see [`docs/changelog/v0.5.0.md`](docs/changelog/v0.5.0.md)). Where each phase stands
is the milestone of the same number on the issue board, and `bun run queue` prints what is
startable now. The honest gaps, kept current in [`docs/MODULES.md`](docs/MODULES.md) §10:

- No module of the product publishes a fact yet; the outbox is built and proved with fake modules.
- The web does not yet draw the search groups; the route answers them.
- A new module's web feature is written by hand; `module:new` generates the server side only.
- The tasks module, a desktop app and mobile are not started.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first; it applies to human and AI contributors alike.
Outside contributions are under the contributor licence agreement ([`CLA.md`](CLA.md)), signed by
adding yourself to `.github/cla-signatures.json` in your first pull request. Because the API and
schema still move, open an issue before starting anything large.

## License

**[AGPL-3.0](LICENSE)**: run it, fork it, modify it. If you run a modified version as a network
service, publish your changes. Running it inside your own company creates no obligation at all.
The CLA lets the project keep offering a commercial licence to teams whose policies do not permit
AGPL (D-24, D-145 in [`docs/DECISIONS.md`](docs/DECISIONS.md)).
