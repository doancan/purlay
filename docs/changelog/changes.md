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

- **Administration** — the server's administrator can stop a module for every workspace and let it run again from the console, with the reason, what stops with it and a confirmation before chat is stopped (D-323)
- **Send later** — a scheduled message can be sent at once with *Send now* in the Scheduled list, and is sent exactly once even if its time comes at the same moment (D-324)
- **Operations** — an operator who cannot sign in can requeue or discard dead facts between modules with `bun run outbox:requeue` and `outbox:discard`, with a reason and on the server's trail, as the console does (D-325)
- **Operations** — `/metrics` times each source of the workspace find and counts the ones it answered without and why, and a ready-made alert rule warns when a source keeps being skipped (D-326)

### Changed

- **Notifications** — a toast (Link copied, Scheduled message cancelled…) rises above the sidebar's account row instead of covering the person's name (D-322)
- **Messages** — a mention of you is a pale tint behind the accent text instead of a solid blue chip, so a feed with several of them is no longer led by them (D-321)
- **Search** — the results say how many were found ("2 results", or "20 results so far" while there is more), announced to a screen reader (D-320)
- **Reminders and Send later** — the menus that offer "In 20 minutes", "In 1 hour" and "In 3 hours" now say the clock time each comes to, as "Tomorrow at 09:00" already did (D-319)
- **Profile** — an empty Time zone field shows the zone this device would fill in, so the button beside it says what it does

### Fixed

- **Channels** — while other people are writing, the channel list is no longer asked for again at every unread count it hears while it loads; it loads once and is read once more, so a reloaded channel no longer waits on it

---
