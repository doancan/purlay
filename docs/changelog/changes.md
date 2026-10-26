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

- **Native app** — A person signs in to the macOS application in their browser and authorises it with one click; it gets a session of its own (D-191)
- **Native app** — The server says which client versions it still serves and where to get a newer one, and refuses an older one with a clear answer (D-190)
- **Operations** — Every release carries the contract bundle a non-browser client is generated from, with its digest (D-192)

### Changed

- **Sign-in** — An emailed sign-in link can carry the application's pending sign-in into the browser that opens it (D-191)

### Fixed

- **Messages** — A history, thread, open-questions or search request with a query it does not know, a repeated parameter or a `limit` such as `0x10` is refused instead of answered as the first page
- **Messages** — A download's file name is encoded whole, so a name holding `'`, `(`, `)` or `*` reads back as it was
- **Operations** — A request turned away at the edge (too large, wrong type, cross-site, client too old) is written to the log under its request id, and a sign-in library answer is logged with the status it went out with

### Security

- **Native app** — A device name can no longer hold zero-width or directional characters, so a session cannot be made to read as another device's in the sessions list (D-191)
- **Native app** — A wrong sign-in verifier or a burnt code is a warning in the server's log with its reason, and nothing in the log can open a session (D-191)
- **Client version** — A client header with an empty pre-release identifier is no longer taken for a version (D-190)

---
