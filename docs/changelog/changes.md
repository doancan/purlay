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

- **Operations** — A hosted deployment of several nodes shares one Redis, set with `REDIS_URL`: a message, a sign-out, who is online and who is typing reach every node, and a person's write limit is one limit across them. A Redis that goes away is degraded service, not an outage. Without `REDIS_URL` nothing changes and nothing connects (D-201)
- **Operations** — An operator can switch on point-in-time recovery for the database (`WAL_ARCHIVE=on`, off by default) and restore it to a named moment into a new instance without touching the live one, with the archive's retention tied to the base backups, a stated RPO and RTO, and the restore rehearsed weekly (D-202)
- **Operations** — `scripts/check-backup.sh` exits non-zero when the newest backup is older than 26 hours or the archive is failing, so a backup that stopped is noticed, and the documented cron lines are held to the layout a deploy leaves (D-202)
- **Sign-in** — A server can be connected to the organisation's OpenID Connect provider (Okta, Entra ID, Keycloak and the like) in Administration → Server or by `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: people sign in with it beside GitHub and email, and it is linked to an existing account only when both the provider and that account's address are verified (D-200)
- **Native app** — A person signs in to the macOS application in their browser and authorises it with one click; it gets a session of its own (D-191)
- **Native app** — The server says which client versions it still serves and where to get a newer one, and refuses an older one with a clear answer (D-190)
- **Operations** — Every release carries the contract bundle a non-browser client is generated from, with its digest (D-192)
- **Sign-in** — A person sees where they are signed in, by device name and when it was last used, and ends one place without ending the rest (D-193)
- **Messages** — A client that was away asks what happened to a channel's messages since it last heard — edits, deletions, reactions taken back, replies, and messages that arrived late — and is answered by the messages themselves (D-194)
- **Sidebar** — A person folds each section by its heading (what is unread, what mentions them and the open row stay listed), and arranges the column from one menu: only what is unread, channels by name or by recent activity, Conversations and People switched off, muted channels left out, and a reset; the choices are kept per person and workspace (D-195)

### Changed

- **Dependencies** — The toolchain and runtime libraries move to their newest patch releases; the three deprecations they flagged are removed (`dns` lookup order, the build's `rolldownOptions`, the account-linking option the library now makes unconditional); `knip` is held at 6.41 until it reads the entry points again
- **Operations** — `CONFIG.md` says how to set up SPF, DKIM and DMARC for the sign-in mail, and why bounces are not handled by the server
- **Performance** — Going back to a channel after reading far back through its history opens it as fast as any other: a channel that is left keeps its newest messages and reads the older ones again as they are scrolled to, instead of drawing them all at once (2.1 s for 2,000 messages before); the feed is not virtualized (D-199)
- **Process** — Phase 1 ends on what is built and verified end to end, not on a team staying off another product for thirty days; the cloud no longer waits on that count (D-197)
- **Performance** — The first-load JavaScript gate is a backstop at 400 KB gzipped, no longer a ceiling a feature is cut or deferred to fit; the time budgets are unchanged (D-196)
- **Sidebar** — The workspace's name at the head of the column has its tile and sits inset and rounded like the rows, so its hover and focus no longer touch the rail and the hairline; the jump field lines up with the rows (D-195)
- **Sign-in** — An emailed sign-in link can carry the application's pending sign-in into the browser that opens it (D-191)
- **Messages** — A person back from a long disconnect has every unsent message sent, up to the fifty a client keeps, where the server used to refuse all but the first eighteen: the burst a connection or a person's writes may spend at once is sixty frames, the rate still ten a second (D-198)

### Fixed

- **Operations** — The browser budget no longer blocks on the keystroke with 2,000 messages loaded, which the feed decision accepts and a hosted runner measures at twice its neighbour (D-199)
- **Workspace** — A newly invited member appears in already-open member lists and can be added to a channel without reloading (D-115, D-124)
- **Files** — A ready attachment enables Send even with no message text, including on touch-only devices (D-109)

- **Messages** — A history, thread, open-questions or search request with a query it does not know, a repeated parameter or a `limit` such as `0x10` is refused instead of answered as the first page
- **Messages** — A download's file name is encoded whole, so a name holding `'`, `(`, `)` or `*` reads back as it was
- **Operations** — A request turned away at the edge (too large, wrong type, cross-site, client too old) is written to the log under its request id, and a sign-in library answer is logged with the status it went out with
- **Operations** — The documented nightly backup line names `current/` and the env file, so it keeps working once `scripts/deploy.sh` has replaced a flat checkout with releases

### Security

- **Native app** — A device name can no longer hold zero-width or directional characters, so a session cannot be made to read as another device's in the sessions list (D-191)
- **Native app** — A wrong sign-in verifier or a burnt code is a warning in the server's log with its reason, and nothing in the log can open a session (D-191)
- **Client version** — A client header with an empty pre-release identifier is no longer taken for a version (D-190)

---
