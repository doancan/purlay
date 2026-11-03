# Purlay — Changelog

What changed, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape (D-185). **Unreleased** is
what has merged since the last release; `bun run release -- <patch|minor|major>` moves it into
`docs/changelog/v{x.y.z}.md` and a merge of that pull request is the release. What came before the first
release is kept as it was written in [`pre-0.1.0.md`](pre-0.1.0.md).

**How to write an entry**, in the pull request that makes the change:

- Put it under one category, in this order: **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**,
  **Security**. A category with nothing in it is left out.
- One bullet, one line (two at most): `- **Area** — what a person can now do, or what the system now does (D-123)`.
  The area is a product word (Messages, Channels, Sign-in, Operations), the sentence is plain language, and
  the decision that explains it is named in parentheses.
- Write what is different, not what was typed: no issue numbers, no refactors, nothing only a test or a build
  would notice. A feature reworked in the same release is one bullet in its final state.
- Hardening of who may do what, what is limited, and what is kept secret is **Security**, not Changed.

A test holds the shape (`scripts/changelog.test.ts`), and `bun run release` refuses an Unreleased that does not
have it.

---

## Unreleased

### Added

- **Operations** — Nodes of a cluster that run different `MODULES` say so in their logs and keep serving, so a new set can roll out node by node (D-250)
- **Sign-in** — Sign in with Google, beside GitHub, once an administrator connects it (D-251)
- **Messages** — Schedule a message, with its files, to be sent later; the server sends it at its time even with every app closed (D-30)
- **Messages** — Ask to be reminded of a message; the reminder arrives in the inbox when it is due (D-128)
- **Messages** — Delete a message for yourself alone; everybody else keeps it as it was (D-103)
- **Messages** — A face typed as text, like `:D` or `<3`, becomes its emoji at the next space; Backspace straight after takes it back (D-253)

### Changed

- **Email** — Every email the server sends is a short letter with one button, instead of plain text with the link in it (D-252)
- **Performance** — The first page load fetches about a sixth less JavaScript, because the channel and message screens load beside the session answer rather than inside the first file (D-250)

### Fixed

- **Operations** — A fresh install started with `MODULES=none` can erase an account, purge a deleted workspace, export and run its nightly jobs; they failed on tables only chat's own migrations make (D-250)

### Security

- **Messages** — One person can put at most three different reactions on a message; taking one back makes room for another (D-249)

---
