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

### Featured

- **Editor** — Paste what you copied and the composer understands it: a spreadsheet range becomes a table, a command or a few lines of code are formatted, Markdown stays Markdown, and a very long text can be sent as a file (D-259)
- **Release notes** — This window now leads with what a release is about on a light blue block, lists everything else plainly by what it is, and greets a new version with a few seconds of fireworks (D-261)

### Added

- **Editor** — Markdown blocks and Markdown files have a Source and a Preview view, and a checklist button joins the formatting row (D-259)
- **Editor** — A text of 500 lines or more, or a table of more than 200 rows, is offered as a file instead of being left too long to send (D-259)

### Changed

- **Operations** — `docker-compose.dockhand.yml` no longer runs Caddy: it publishes the API on `PURLAY_HTTP_PORT` for Nginx Proxy Manager to forward to, as purlay.app runs, and no longer needs `PROXY_NETWORK` (D-258)
- **Operations** — a workspace export and a person's export now carry which message and channel a file was sent with in `message_attachments.ndjson`, and `attachments.ndjson` no longer has `message_id` and `channel_id` (D-250)
- **Operations** — the upgrade drops `attachments.message_id` and `attachments.channel_id`, and stops with a count, changing nothing, if a sent file's link is missing from chat's table; restore the backup and fix the data before deploying again (D-250)
- **Operations** — The metrics page and the logs now say which module a request or a scheduled job is for: the request histogram and the job series carry a `module` label (`core`, `chat`, `issues`, or `none`), and a module's request lines, failed requests and every scheduled job's lines name it, so an operator can tell which module is slow or failing (D-250, D-221)
- **Sidebar** — Channel and conversation rows have room between them, so a hovered row no longer touches the next (D-259)
- **Messages** — The image viewer opens with a fade and draws the picture on a shadow, and a thumbnail shows a zoom hint (D-259)

### Fixed

- **Messages** — Opening the preview of a Markdown file no longer scrolls the page away from the button that opened it (D-259)
- **Editor** — Pasting a very long single line no longer freezes the box for seconds (D-259)

### Security

- **Accounts** — Erasing an account now also revokes its GitHub App authorization at GitHub when the saved access token has expired, by renewing it with the saved refresh token first, so the grant no longer stays behind (D-246, D-256)

---
