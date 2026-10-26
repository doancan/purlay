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

- **Messages** — Channels read as a live log with day dividers, the author's name once per run of messages, and times on hover; others' messages sit on the left in bubbles, your own on the right (D-98, D-99, D-119)
- **Messages** — A sent message appears at once and shows its state; a failed one offers Retry and Delete, and a message written offline is sent when the connection returns (D-98)
- **Messages** — The feed keeps the reader's place: new messages and older pages do not move it, a "N new messages" pill shows when scrolled up, and a channel opens at its unread marker (D-98)
- **Messages** — Markdown: emphasis, strikethrough, inline and fenced code, links, quotations, lists, task lists, tables and rules; raw HTML and images in text are not rendered, and a body past the parser's bounds is shown as typed (D-101)
- **Messages** — Code blocks show their language and line count, a Copy button, syntax colouring loaded on first use, a Wrap lines toggle, and a clamp over twelve lines (D-98, D-99)
- **Messages** — A diff block is drawn as a diff with numbered lines, added and removed lines marked in colour and in words, counts, and Unified or Split views (D-133)
- **Messages** — The message box has a formatting row for everything the renderer draws, keys for each, an emoji picker and a preview toggle; Shift+Enter carries a list or quote on (D-110, D-181)
- **Messages** — Typing `@` in a channel or thread box suggests the people a mention would reach, matched by name or handle without regard to case or Turkish accents (D-110)
- **Messages** — The composer says who else is typing in the channel (D-114)
- **Messages** — Edit your own message in place (`E`, or Up in an empty box); an "edited" mark opens the earlier versions, and an author can remove one (D-103, D-135)
- **Messages** — Delete your own message after a confirmation; owners and admins can delete anyone's. A deleted message with replies stays as a tombstone with its thread (D-103, D-9)
- **Messages** — Reactions show who reacted and offer a row of quick reactions that never opens over the composer (D-99, D-150)
- **Messages** — Each message has a bar of React, Reply, Save, Pin and More (Copy text, Edit, Delete) shown on one row at a time (D-150)
- **Messages** — Pin messages in a channel and read them in a Pinned messages panel showing who said and who pinned each (D-130)
- **Messages** — Save for later keeps a message in a Saved view with In progress, Archived and Completed tabs (D-128)
- **Messages** — A link to a GitHub pull request or issue is drawn as a card with its repository, state, title and opener, plus check and review status for pull requests (D-23, D-112)
- **Messages** — An `https` link to a PNG, JPEG, GIF or WebP picture shows the picture below the message, fetched through the server so the picture's host never sees the reader
- **Threads** — Show thread, `T` or Reply opens the thread in a panel beside the feed, with Resolve and a status pill, a reply box with Bold, Code block, Mention and Attach, and Esc to close (D-122, D-164)
- **Threads** — An open-questions view lists unresolved threads with a count in the rail and the channel header, and can be narrowed to one channel
- **Threads** — Follow turns a thread's reply notifications on or off, including in threads you never wrote in (D-161)
- **Channels** — Create public or private channels (names are normalised as typed, Turkish letters folded), browse and join public ones, leave, and archive (D-104, D-123)
- **Channels** — A channel's details open from its name as a wide tabbed dialog (About, Members, Integrations) with name, topic, notification level and a Danger zone for Leave and Archive (D-123, D-154)
- **Channels** — Add people to a channel, and let an owner or admin (or a member of a private channel) remove someone from it (D-104, D-172)
- **Channels** — Star a channel to keep it in a Starred section; after accepting an invitation, pick channels to join with the three busiest preselected (D-132)
- **Channels** — A new workspace starts with a public `general` channel with its creator in it (D-174)
- **Conversations** — Direct messages with up to ten people, started from New message with picked people shown as chips; groups are named by their people (D-127)
- **People** — Profiles with a title, a status line and a time zone, shown beside a conversation with local time (D-131)
- **People** — A dot on the avatar shows who has Purlay open (D-136)
- **Notifications** — An inbox lists mentions, direct messages, answers in your threads and resolved questions, with All and Unread views, Today and Earlier groups and Mark read (D-106, D-153)
- **Notifications** — Mention badges in the sidebar and a count in the browser tab title stay in step across devices (D-106)
- **Notifications** — Each channel's bell chooses Every message, Mentions and replies (the default) or Nothing; a muted channel is marked in the sidebar (D-107)
- **Notifications** — Deep Work, for 30 minutes, an hour, two hours or until tomorrow, silences badges while keeping the counts (D-15, D-108, D-124)
- **Notifications** — A tab in the background shows a browser notice, naming the place and who but never the message, with a dot on the favicon (D-148)
- **Notifications** — Web Push to a person's devices, encrypted and never carrying message text, held while the person is looking at that workspace (D-126, D-143)
- **Search** — Search the channels you can see for words as typed, ignoring case, in replies and resolved threads, narrowed to one channel if wanted; the address keeps the query (D-105)
- **Search** — Search treats I, ı, İ and i as one letter, and results mark where the words were found in an excerpt shown as the message reads
- **Search** — The command palette (`Cmd/Ctrl+K`) finds channels (including unjoined), conversations, inbox, saved items, search and every settings page, and can start Deep Work (D-124, D-157)
- **Attachments** — Attach files by pasting, dropping or picking up to ten per message, up to 25 MB each, with progress, Retry and Remove, and a reason when an upload fails (D-109, D-159)
- **Attachments** — Uploaded images are stored as upright WebP with a thumbnail and camera data removed; other files are downloads (D-109)
- **Attachments** — Pictures open in an image viewer with Download, Open original and arrow-key stepping; a channel's Files panel lists everything shared there (D-129, D-159)
- **Attachments** — Settings → Data & retention shows a workspace's storage against its quota, and quota changes appear on the audit log (D-173)
- **Sign-in** — Sign in with GitHub, with the screen offering only the methods the server has connected (D-38, D-179)
- **Sign-in** — Sign in by an emailed link that works once and shows its address before it is spent; five links an hour per address and twenty per client (D-138, D-179)
- **Sign-in** — The sign-in screen says in English and Turkish why a sign-in failed, and says so when an open tab's session has ended (D-121)
- **Sign-in** — Sign out, or sign out everywhere, from the account menu; Settings → Sessions & account shows how you sign in, and a person can erase their own account (D-124, D-139)
- **Sign-in** — The server's administrator can use a password, held to a length and common-password policy (10 to 128 characters) (D-179)
- **Invitations** — Owners and admins invite by a link valid for seven days, shown once, listed with who made it and revocable; the invited person lands on a page naming the workspace (D-115)
- **Setup** — A fresh server starts in setup mode and a browser wizard, opened with a code from the log, creates the administrator, verifies the address, tries GitHub and mail settings before saving them, and makes the first workspace (D-179)
- **Integrations** — Connect a GitHub repository to a channel from its details to post pushes, pull requests, issues and releases as messages from GitHub; the secret is shown once and deliveries are signed and de-duplicated (D-134)
- **Integrations** — An owner or admin gives the workspace a GitHub token for cards, kept encrypted; `GITHUB_URL` and `GITHUB_API_URL` point at GitHub Enterprise Server (D-11, D-23, D-179)
- **Incidents** — Declare an incident in a channel at SEV1 to SEV4, move it between investigating and mitigating, escalate or lower it, and resolve it, with a timeline of who did what (D-137)
- **Incidents** — An incident shows a banner under the channel header and a mark in the sidebar, lists who is responding, links a runbook and holds a postmortem written in place (D-137)
- **Administration** — Owners and admins manage members and roles in the app, remove members, and read the audit log in words (D-26, D-111)
- **Administration** — Settings is a page with Account and workspace sections; the workspace menu creates and switches workspaces, and owners and admins rename a workspace (D-124, D-146, D-151)
- **Administration** — Anybody may leave a workspace; the last owner may not (D-152)
- **Administration** — Owners choose how long history is kept, from forever (the default) to five years, with a nightly purge and a note on the audit log (D-139)
- **Administration** — Owners export a workspace as one archive with its files, downloadable once and expiring after a day; an operator command exports to a directory (D-140)
- **Administration** — An operator command erases the content a person wrote in a workspace, and an account's erased person shows as "deleted user" (D-139)
- **Administration** — Administration → Server, shown to the server's administrator only, manages GitHub sign-in, mail, who may sign up and who may create workspaces, each tried before it is kept (D-179)
- **Administration** — `bun run admin:reset-password` recovers the administrator's password and ends their sessions (D-179)
- **Appearance** — Three themes: light with a light left menu, black dark, and Midnight (indigo), chosen in Settings → Preferences, following the system until chosen (D-98, D-180, D-183, D-184)
- **Appearance** — A quiet, flat interface: Inter and JetBrains Mono served from the same origin, a rail and sidebar, one check box and radio drawn in the product's tokens (D-110, D-182)
- **Appearance** — English and Turkish from the first screen, including role names (Sahip, Yönetici) (D-41, D-98)
- **Appearance** — Screens work down to a phone width, and a screen that fails to draw shows a short explanation with Reload and Go home, never a blank page (D-96, D-106)
- **Appearance** — A page open across a deployment offers a Reload bar and keeps drafts
- **Accessibility** — Visible focus rings, a skip link and focus that follows navigation, accessible names that contain a control's visible text, and one Escape to close a dialog (D-98)
- **Performance** — The first load stays within a 250 KB budget of JavaScript; channel details, the incident panel, diff viewer, image viewer and Settings load when first opened, and a prerendered shell shows layout at once (D-49, D-50)
- **Performance** — Build budgets check idle API memory, acknowledgement and fan-out latency against the last run on main, and the page's cold load, keystroke and channel switch (D-49)
- **Browsers** — Chrome and Edge 120, Firefox 121, and Safari and iOS Safari 17.2 are supported and checked by the build (D-113)
- **Operations** — The production stack starts with one `docker compose` command: API, PostgreSQL, Garage object storage and Caddy with automatic TLS, with every container bounded in memory and logs (D-94, D-144)
- **Operations** — The API serves the client from one origin and migrates itself on start when `MIGRATE_ON_START` is set; nodes started together take turns (D-61, D-93)
- **Operations** — `backup.sh` and `restore.sh` back up the database and the files, check their sums, restore into a staging database and swap; a weekly rehearsal proves it (D-95)
- **Operations** — Scheduled jobs (sessions, orphans, storage counts, link previews, retention, exports, deletions) run from a `scheduler` container, and `jobs:status` and its health check show an overdue or failing job (D-30)
- **Operations** — Errors are reported to a Sentry-compatible endpoint only when `ERROR_TRACKING_DSN` is set; nothing leaves a self-hosted server otherwise (D-44, D-96)
- **Operations** — A merge to `main` deploys on the server's runner, with a backup, smoke test and rollback; `bun run release -- <patch|minor|major>` opens the version pull request, and merging it tags and publishes the release (D-185)
- **Operations** — `docs/DATA.md` maps the personal data an instance holds, with retention and erasure runbooks (D-28)
- **Operations** — `CONFIG.md` covers running behind a proxy of your own, and what Cloudflare in front of it needs for a sign-in to carry the person's address (D-81, D-185)
- **Operations** — The project is licensed AGPL-3.0-or-later with a contributor licence agreement (D-24, D-145)

### Changed

- **Notifications** — Answering a thread now notifies you of its replies and the question's author learns it was answered; replying once no longer subscribes you for good (D-29, D-161)
- **Sign-in** — Signing in by email link and by GitHub run on the Better Auth library; a GitHub sign-in on a verified address links itself, and no link reaches an account whose address was never verified (D-179)
- **Sign-in** — An unverified local account's address now gets a sentence on the sign-in screen saying to use the emailed link or ask an administrator (D-179)
- **Administration** — GitHub's app, the mail relay, who may sign up and who may create workspaces are server settings in the database, encrypted at rest; the environment is read once on a database's first start (D-179)
- **Administration** — `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are optional, and a rotated `ENCRYPTION_KEY` starts the server in setup mode instead of stopping it (D-179)
- **Administration** — The invitation dialog, members, audit log, GitHub connection and export moved from menu dialogs into Settings pages, and Members is a table with counts, search and a role filter (D-146, D-151)
- **Channels** — Channels in the sidebar are listed by name so a new message never reorders them; people and groups stay newest first (D-160)
- **Messages** — Lists of search results, inbox, saved, pins and open questions show a message's text as it reads, not as typed
- **Operations** — Garage replaces MinIO as the object store, and `MINIO_PORT` and `MINIO_CONSOLE_PORT` became `STORAGE_PORT`
- **Operations** — The proxy holds a request for up to 30 seconds while the API restarts instead of answering 503, and `/health/ready` answers from a check at most a second old
- **Operations** — Upgrading from before the sign-in library: everyone signs in again and nobody is administrator until the operator names one; migration 0055 backfills existing identities (D-179)
- **Operations** — `docs/CONFIG.md` now starts the nightly backup at 01:00 and describes an off-host copy and failure alerts

### Removed

- **Administration** — `WORKSPACE_OPEN_JOIN_SLUG`: signing in no longer joins anybody to a workspace, the setting is refused at startup, and the team is invited by link instead (D-115)
- **Sign-in** — The Connect GitHub button, its routes and `GITHUB_ALREADY_CONNECTED`, replaced by automatic linking on a verified address (D-179)

### Fixed

- **Messages** — A message sent while the API was down no longer stays failed; it is sent when the API is back
- **Messages** — A message sent offline said "Failed to send" at once; it now waits out the send's three seconds and says it will go on its own when you are back online
- **Messages** — A mention inside a link, or glued to the end of code, no longer notifies anybody or is highlighted; a name in a `~~~` fence no longer notifies (D-101)
- **Messages** — The hover controls no longer cover a message's first line or the edit box
- **Messages** — Sending a picture no longer leaves the feed a picture's height above its end
- **Messages** — An edit, a send or a reaction no longer vanishes from the screen when the feed is read again at the same moment
- **Threads** — Reading a channel to its newest message no longer marks replies in unopened threads read; they wait for the thread or the inbox (D-147)
- **Notifications** — An open inbox shows "your question was resolved" without a reload (D-106)
- **Notifications** — The rail's inbox dot stays quiet in Deep Work like the badges (D-15)
- **Notifications** — The production stack passes the Web Push and sign-in mail settings to the API, so push keys and email sign-in set in `production.env` take effect
- **Channels** — A channel joined or made on one device appears live on the others
- **Channels** — A channel's details no longer opens with the name selected, and the notification, open-questions and member views name people by display name
- **Channels** — A long channel name no longer runs under the header's controls on a phone
- **Search** — Search finds "ÇAĞRI" from `çağrı` and "İstanbul" from `istanbul`, and the palette finds "Doğancan" from "dogancan" (D-105)
- **Sign-in** — A draft left in the browser by a session that ended no longer appears in the next person's composer
- **Sign-in** — A callback clicked twice, and a GitHub login or name with a control character, no longer fail sign-in (D-78)
- **Attachments** — Downloading an attachment from the real object store no longer fails with a 500 (D-109)
- **Attachments** — An export of a workspace that has attachments no longer fails (D-140)
- **Attachments** — A store that is down answers 503 `STORAGE_UNAVAILABLE` instead of 500
- **Accessibility** — Moving to a channel leaves focus in its composer on a wide window, and a thread's panel never leaves focus on nothing
- **Accessibility** — On a phone, Saved's tabs, inbox rows, open questions, the composer hints and the header no longer cover or break titles and Send
- **Operations** — A backup no longer skips the attachments by chance, and a restore reads the dump before it replaces anything
- **Operations** — A message edit naming several people, a leave, and concurrent sends into one channel no longer deadlock, and a database failure answers 503 within 3 seconds (D-87)
- **Operations** — Several nodes started at once no longer deadlock on the migration lock, and a node migrating on start is no longer cut off at 30 seconds (D-86)

### Security

- **Sign-in** — Passwords are throttled but never locked out: ten wrong passwords for an address from one client and twenty from one client in 15 minutes, with unknown addresses and wrong passwords answering alike (D-179)
- **Sign-in** — Sessions are opaque tokens stored only as hashes, every refusal looks the same, and signing out everywhere ends every session and open socket (D-60, D-85)
- **Sign-in** — The OAuth state cookie is signed with a key derived from `ENCRYPTION_KEY` to stop cookie tossing (D-62)
- **Sign-in** — Changing a password ends every other session, and a failed sign-in address carries only the reason (D-121)
- **Setup** — Setup answers everybody without the claim alike with `404`, limits attempts per client, locks after wrong codes, and counts a way in only after a try that worked (D-179)
- **Administration** — Only the people the operator names (GitHub logins, or `*`) may create workspaces, and the match is on the GitHub login itself (D-155, D-169)
- **Administration** — Writing in a channel needs membership of it over HTTP and the socket alike (D-156)
- **Administration** — Every administrative write is on the audit trail, naming the session that acted, never message words; a test requires one row per role-gated write (D-26, D-116)
- **Administration** — Server settings are visible to the administrator only, secrets are never shown, and a server change is written to its own trail without values (D-179)
- **Administration** — Cross-workspace and invisible-channel requests answer one identical `404` (D-21, D-34)
- **Messages** — Image decodes wait in a bounded line so large images cannot stall uploads (D-170)
- **Messages** — The image proxy fetches only `https` public addresses on a fresh connection with no redirect, at most 10 MiB and five seconds (D-39)
- **Messages** — Links are drawn only when their address passes one check, and rendered text is never taken as markup (D-101)
- **Attachments** — Uploaded files are read through the API; images are served as stored WebP and everything else as a sandboxed download so an uploaded script cannot run (D-109)
- **Operations** — The socket upgrade checks the request's origin before the session, and every mutation from another origin or with a non-JSON body is refused (D-39, D-80)
- **Operations** — The HTTP edge is bounded: bodies over 64 KiB are refused before reading, and responses carry `nosniff`, referrer, framing and cache policies, plus HSTS over https (D-80)
- **Operations** — HTTP routes and sockets are rate limited per user or client with `429` and `Retry-After`, and a user's sockets share one write budget; a user may hold 20 sockets (D-81, D-84)
- **Operations** — The page is sent with a content security policy allowing no inline script and no framing, and a Permissions-Policy turning off camera, microphone, geolocation and similar features (D-102)
- **Operations** — Stored credentials are sealed with AES-256-GCM bound to the row, and configuration refuses the development key, plaintext databases and non-canonical keys in production (D-39, D-79)
- **Operations** — The proxy no longer logs query strings, and retries only requests that never reached the API
- **Operations** — Backups are written readable only by their owner, and error reports carry no absolute paths of the host (D-95, D-96)
- **Operations** — Costly reads (GitHub cards, external images) have their own budget, and calls to GitHub are budgeted per workspace (D-81)
- **Operations** — Container images are pinned by digest and actions by commit, dependency and licence checks gate the build, and CodeQL findings are fixed in the code (D-91, D-92)

---
