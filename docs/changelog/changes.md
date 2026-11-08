# Purlay — Changelog

What changed, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape (D-185). **Unreleased** is
what has merged since the last release; `bun run release -- <patch|minor|major>` moves it into
`docs/changelog/v{x.y.z}.md` and a merge of that pull request is the release. What came before the first
release is kept as it was written in [`pre-0.1.0.md`](pre-0.1.0.md).

**How to write an entry**, in the pull request that makes the change:

- Put it under one category, in this order: **Featured**, **Added**, **Changed**, **Deprecated**, **Removed**,
  **Fixed**, **Security**. A category with nothing in it is left out. **Featured** is only for what a release is
  *about* — the one to three things a person would tell a colleague — and is drawn as cards above the rest; a
  fourth is refused. A big feature is told once in **Featured**, and its details may follow under **Added**.
- One bullet, one line (two at most): `- **Area** — what a person can now do, or what the system now does (D-123)`.
  The area is a product word (Messages, Channels, Sign-in, Operations), the sentence is plain language, and
  the decision that explains it is named in parentheses.
- Write what is different, not what was typed: no issue numbers, no refactors, nothing only a test or a build
  would notice. A feature reworked in the same release is one bullet in its final state.
- Hardening of who may do what, what is limited, and what is kept secret is **Security**, not Changed.
- Start each bullet with its area in bold and a dash: it is shown as a label above the sentence. In **Featured**
  the area is the card's title, so make it a name a person would say (`**Editor** — …`).

A test holds the shape (`scripts/changelog.test.ts`), and `bun run release` refuses an Unreleased that does not
have it.

---

## Unreleased

### Added

- **Operations** — One workspace can no longer bury the others' facts between modules: a workspace may have `OUTBOX_PENDING_MAX` (5000 unless set) facts waiting for one module, a publish past it is refused with `FactBacklogFull` and ends the publisher's transaction, and `purlay_outbox_refused_total` counts it by module and fact (D-288)

### Changed

- **Operations** — A cluster whose nodes read `WORKSPACE_MODULES` differently now says so in each node's log, once and again when they agree, as it does for nodes that run different modules; the metrics table, the edition file and the command to apply it are in the operator documents (D-289, D-292). During the rolling deploy that brings this, a node of the older release logs the different set once
- **Operations** — A module's facts are delivered by turns across workspaces: a workspace with a long backlog has one place in each batch of 20 while others have facts waiting, so one tenant can no longer delay everyone else's by hours (D-288)
- **Notifications** — The setting for emailing you about what you missed is part of chat: on a server that does not run chat, `/api/me/missed-mail` answers like any unknown path, and where chat runs nothing is different (D-280)

### Fixed

- **Operations** — `bun run entitlements:apply --help` and `bun run module:new --help` print their usage and succeed; the first used to stop with a configuration error before reading its arguments (D-292, D-294)
- **Operations** — A server that starts now joins its cluster's record within about a second instead of ten, so a restriction of a workspace's modules is not written beside a server that does not read grants and has only just started (D-292)

---
