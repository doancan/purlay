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

- **Invitations** — Track each email recipient and mail-server response after reopening Settings, search addresses and filter by invitation status across all pages, inspect send history that updates as sends finish, resend a separate link or revoke it. Approved accounts continue to their invitation automatically; mail-server acceptance is distinguished from inbox delivery (D-279).

- **Server administration** — Administrators can open a console without a workspace, browse paginated accounts, workspaces and server audit entries, approve selected pending accounts with a separate result for each, manage quotas and administrator access, end account sessions, review maintenance jobs, test saved mail configuration, configure server identity and account admission, and review backup evidence (D-278).

- **Operations** — The contract a native client is generated from now lists the server's modules and says which module owns each endpoint, socket event and operation, and `GET /api/me` types its module list, so an app can follow the module structure and ignore a module it does not know (D-273)
- **Operations** — A release's image is also tagged `release` and its version, so a Dockhand server can follow releases on its own; the Dockhand stack backs the database up every hour (D-262)
- **Editor** — Markdown blocks and Markdown files have a Source and a Preview view, and a checklist button joins the formatting row (D-259)
- **Editor** — A text of 500 lines or more, or a table of more than 200 rows, is offered as a file instead of being left too long to send (D-259)

### Changed

- **Audit log** — The action filter offers only the actions of the modules the server runs, so a server without issues no longer lists issue actions (D-265)
- **Operations** — a scheduled job of a module now runs in the module's share of the database and is stopped, and recorded as a failed run, when it runs past ten minutes (a module may declare another time), so one that hangs no longer holds the jobs behind it (D-274)
- **Operations** — `bun run release` with no kind prepares a patch release (`0.3.0` → `0.3.1`); `minor`, `major` or an exact version are asked for by name (D-263)
- **Operations** — `docker-compose.dockhand.yml` no longer runs Caddy: it publishes the API on `PURLAY_HTTP_PORT` for Nginx Proxy Manager to forward to, as purlay.app runs, and no longer needs `PROXY_NETWORK` (D-258)
- **Operations** — a workspace export and a person's export now carry which message and channel a file was sent with in `message_attachments.ndjson`, and `attachments.ndjson` no longer has `message_id` and `channel_id` (D-250)
- **Operations** — the upgrade drops `attachments.message_id` and `attachments.channel_id`, and stops with a count, changing nothing, if a sent file's link is missing from chat's table; restore the backup and fix the data before deploying again (D-250)
- **Operations** — The metrics page and the logs now say which module a request or a scheduled job is for: the request histogram and the job series carry a `module` label (`core`, `chat`, `issues`, or `none`), and a module's request lines, failed requests and every scheduled job's lines name it, so an operator can tell which module is slow or failing (D-250, D-221)
- **Operations** — A module's share of the database now holds every query of its routes, reads as well as writes, and a query that runs past its limit is answered `503` for the client to retry instead of `500` (D-266)
- **Operations** — the counters of requests and socket frames refused for the rate, of pushes that did not reach their service and of letters the mail relay did not accept now carry a `module` label (`core`, `chat`, `issues`, or `none` for a frame that names no operation), so a dashboard can say which module is being refused or failing (D-250)
- **Operations** — Chat now has a share of the database pool like issues, and the core keeps a reserve the modules cannot take, so signing in and reading a session are not queued behind a busy chat (D-269)
- **Operations** — A request or socket frame of a module that runs past its deadline (20 seconds, 8 for issues) is now answered `504` with the error envelope instead of hanging, and the database is told to cancel what it was running (D-270)
- **Sidebar** — Channel and conversation rows have room between them, so a hovered row no longer touches the next (D-259)
- **Messages** — The image viewer opens with a fade and draws the picture on a shadow, and a thumbnail shows a zoom hint (D-259)

### Fixed

- **Server audit** — Read actions in English or Turkish, find and select a person instead of copying account ids, and download the matching entries as CSV or NDJSON (D-278, D-222).

- **Server settings** — Accepted provider and workspace-creator changes survive a failed refresh; cancelled forms forget credentials, disconnect confirmations start afresh, and connection-form actions wrap on narrow screens (D-179)
- **Settings** — Confirmed member and GitHub changes remain visible after a failed refresh; export links distinguish activation from a confirmed download and ignore context-menu clicks. General hides chat controls when chat is off, and long archived names remain readable on narrow screens. Saves hold their fields and related actions, quiet hours recover from failed reads and follow profile time-zone changes, and policy refresh failures remain visible (D-146, D-234)
- **Invitations** — Send email invitations directly from Settings, load older open links, and make another link without leaving; revoking a link removes its copy field and shows progress (D-146, D-179)
- **Sidebar** — The workspace menu, opened while a workspace is still loading, is no longer closed when the first channel opens (D-250)
- **Channels** — A channel that was archived, left or taken from you while your connection was down now says so when the connection returns, instead of "not found"; somebody who was never in it is still told nothing (D-264)
- **Realtime** — A change made to your own workspaces, Deep Work, inbox or saved messages while a page was loading, before its live connection opened, now shows without a reload (D-268)
- **Messages** — Opening the preview of a Markdown file no longer scrolls the page away from the button that opened it (D-259)
- **Editor** — Pasting a very long single line no longer freezes the box for seconds (D-259)

### Security

- **Accounts** — Erasing an account now also revokes its GitHub App authorization at GitHub when the saved access token has expired, by renewing it with the saved refresh token first, so the grant no longer stays behind (D-246, D-256)

---
