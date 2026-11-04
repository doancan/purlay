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

- **Operations** — `REDIS_KEY_PREFIX` names the namespace of every key and of the bus channel in the shared Redis, so two deployments on one Redis no longer hear each other's frames or share presence and rate limits; unset keeps the names as they were (D-201)
- **Operations** — Run Purlay on a server managed with Dockhand, behind Nginx Proxy Manager, from one compose file (`docker-compose.dockhand.yml`, D-258)
- **People** — Somebody who has not used Purlay for five minutes shows as away, and anybody can set themselves away from the account menu (D-257)
- **Operations** — `bun run db:migrate` refuses a `MODULES` selection that leaves out a module another one requires, in the words the API boot uses, instead of migrating a database the API then will not start on (D-250)
- **Issues** — A second module, off or on with `MODULES`: a workspace keeps a list of issues, each with a title, markdown details, open or done and somebody it is given to; any member makes and changes them, and only whoever made one, an owner or an admin deletes it (D-254)
- **Operations** — The log says at boot which modules a process runs and which it leaves out, and `/metrics` has `purlay_modules_info{module="…"}` for each one it runs, so an operator can tell the nodes of a cluster apart (D-250)
- **Operations** — Nodes of a cluster that run different `MODULES` say so in their logs and keep serving, so a new set can roll out node by node (D-250)
- **Sign-in** — Sign in with Google, beside GitHub, once an administrator connects it (D-251)
- **Messages** — Schedule a message, with its files, to be sent later; the server sends it at its time even with every app closed (D-30)
- **Messages** — Ask to be reminded of a message; the reminder arrives in the inbox when it is due (D-128)
- **Messages** — Delete a message for yourself alone; everybody else keeps it as it was (D-103)
- **Messages** — A face typed as text, like `:D` or `<3`, becomes its emoji at the next space; Backspace straight after takes it back (D-253)
- **Operations** — A new migration that updates or deletes every row of a growing table in one statement, adds a constraint without `NOT VALID`, builds an index without `CONCURRENTLY` or changes a column's type now fails the build, so an upgrade of a large instance no longer holds its tables for minutes (D-86)

### Changed

- **Messages** — A device polling a channel for changes when nothing happened is answered from the indexes instead of a scan of the whole channel, so the answer no longer slows as the channel grows (D-194)

- **Email** — Every email the server sends is a short letter with one button, instead of plain text with the link in it (D-252)
- **Performance** — The first page load fetches about a sixth less JavaScript, because the channel and message screens load beside the session answer rather than inside the first file (D-250)

### Fixed

- **Search** — A search no longer reads the whole workspace when the words are rare or nowhere: the words, the decision note and the accepted answer are each looked up on their own index and merged, with the same results in the same order (D-105)
- **Operations** — An upgrade whose migration cannot get a table's lock within ten seconds (a long transaction is using it) now stops with a message saying what to do and tries again at the next start, instead of queueing behind that transaction and holding up every other query on the table (D-86)
- **Operations** — A slow or busy issues list can no longer hold every database connection and make chat's sends wait: issues' requests are held to a third of the pool, and one over it is told the database is busy and retried (D-250)
- **Operations** — An issues request whose query runs past its time limit is answered `503 DATABASE_UNAVAILABLE`, which a client retries, instead of `500` (D-250)
- **Operations** — `bun run db:migrate` reads `MODULES` exactly as the server does: a setting the server refuses (`CHAT`, `chat,calendar`, `none,chat`, `,`) now stops the command with exit 1 and the reason, instead of migrating the wrong set (D-250)
- **Operations** — A fresh install started with `MODULES=none` can erase an account, purge a deleted workspace, export and run its nightly jobs; they failed on tables only chat's own migrations make (D-250)

### Security

- **Issues** — Somebody signed in who is not in a workspace can no longer use up the issues' share of the database and make its members' requests fail as busy: who may ask is settled before a slot is taken (D-250)
- **Messages** — One person can put at most three different reactions on a message; taking one back makes room for another (D-249)
- **Accounts** — Erasing an account now deletes the sealed GitHub App tokens and the GitHub login Purlay kept to write to GitHub as that person; GitHub is then asked to revoke the person's authorization of the App, best effort: if it cannot, the erasure still completes, and a token that has expired can still be revoked by the person in their GitHub settings (D-246)
- **Accounts** — Erasing an account now replaces the GitHub login of an installation of the App on their personal account, which is their own login, with their anonymised name; an organisation's login stays, and so do the audit lines that named the login when the App was connected or disconnected (D-256)

---
