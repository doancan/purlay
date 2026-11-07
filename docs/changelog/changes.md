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

- **Messages** — Shared public web links show a compact title, destination and optional image beside the conversation, while unavailable previews leave the original link usable (D-293)
- **Conversations** — Return to conversations you started, answered or followed, filter waiting replies and choose which threads to keep following (D-290)
- **Operations** — A server administrator can grant a workspace a module or withhold it (`POST /api/server/workspaces/:workspaceId/modules`), for good or until a time, and take the word back; a workspace that is not granted a module answers its paths as a module that is not run, loses its rail place, search results and inbox lines for it, and keeps all of its data, exported, erased and purged as before. `WORKSPACE_MODULES` says what a workspace with no word of its own has: `open` (every module the server runs, the default) or `managed` (only what is granted). Every change is on the server's trail; the administrator's workspace list shows what each workspace has been granted, and a restriction is refused while a node of a cluster does not yet read grants, so a rollout cannot be believed finished too soon; renewed capability records remove expired entries left by crashed nodes (D-289, D-292)
- **Issues** — Assigning an issue to somebody else now tells them in the core's inbox, in the same step as the assignment (D-286)
- **Inbox** — A new Updates section beside Mentions, Direct and Threads lists what the workspace's other parts, issues for now, told you, and the inbox's dot lights while one waits unread (D-286)
- **Notifications** — Being assigned an issue also sends a push to your devices, held while you are in Deep Work or your quiet hours and sent when they end, and never saying the issue's title (D-286)
- **Messages** — Read PDF attachments inside the conversation, browse pages, zoom and select their text, with the original download available throughout (D-287)
- **Channel groups** — Organize your channels under personal headings across devices, rename or fold groups, and move a channel from its menu; deleting a group preserves its channels and conversations (D-284)
- **Search** — A workspace-wide find answers a group of hits for each source, the messages a person may read and the workspace's issues, and says which source it skipped and why (off, slow or failed), so a slow module cannot hold the others up; it works with chat turned off (D-285)
- **Inbox** — A new `GET` and `POST` of `/api/workspaces/:workspaceId/inbox` list and read the notices modules write to a person, from the modules the server runs, and their other tabs are told with `INBOX_UPDATED`; `purlay_inbox_entries_total` counts them by module and kind (D-286)
- **Operations** — The core keeps an inbox table for what modules tell a person, swept daily by `sweep:inbox` (read notices after 30 days, all after 180) and included in a person's own export as `inbox_entries.ndjson`; nothing writes to it yet (D-286)
- **Operations** — The core keeps an outbox table for the facts one module tells another, one row for each module that consumes it, written in the publisher's transaction and gone with it if that is rolled back; a fact whose consumer is off is dropped or held for up to 14 days as it declares, and a deleted workspace's rows go with its purge; nothing publishes yet (D-288)

### Fixed

- **Notifications** — Writing a notice and erasing its reader use the same lock order, so concurrent actions finish without a deadlock; an earlier context cannot notify a deleted workspace

- **Unread conversations** — Catch up from the oldest unread messages, read only the page shown, and open waiting threads at their first unread reply; joining a channel keeps its old history read and thread reads leave other conversations waiting (D-282)

---
