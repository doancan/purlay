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

- **Operations** — set a minimum iOS app version and wire contract independently of macOS, with an optional HTTPS update address (D-339)

- **Messages** — a message in a direct message, or one that names somebody, can be sent as Important or Urgent, and says so under its words (D-337)
- **Operations** — an operator can limit how many deliveries between modules one workspace may queue in a minute, and move its issues limit, with `bun run quota:set` (a reason is kept, `quota:show` and `quota:clear` read and undo it); a workspace over its limit is told to slow down (`429`), and each change is on the workspace's audit log (D-334)
- **Operations** — an operator can keep a ledger of which fact was delivered to which module and when (`OUTBOX_LEDGER_DAYS`, off by default, ids and times only, never a payload) and read it with `bun run outbox:ledger`, to prove a delivery after the transient table has forgotten it (D-335)
- **Operations** — an operator can send traces of requests, scheduled jobs and the delivery of facts between modules to an OTLP collector (`OTEL_EXPORTER_OTLP_ENDPOINT`, off by default, a share of new traces recorded, never a path with its ids, a query, a body, a payload, a person or a workspace), so a request and what it set going are one picture; the trace of an incoming `traceparent` is joined (D-336)

### Fixed

- **Operations** — the update check finds the latest release again: Purlay now lives in the `purlay` organisation, and GitHub answers the old repository address with a redirect that the check, by design, does not follow
- **Sign-in** — a session made by the iOS application is listed as Purlay for iOS with its version, not as the Mac application (D-191)
- **Workspaces** — on the front door, *Keep* a workspace that is being deleted no longer misses its button when the creation form finishes loading under it

---
