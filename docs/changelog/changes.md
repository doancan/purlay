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

- **Profile** — A person whose account did not come from GitHub — an emailed link, single sign-on or a password — sets the name everyone sees on Profile; a GitHub account's name stays GitHub's (D-235)
- **Mobile** — Purlay installs as an application from the browser; on an iPhone, added to the Home Screen it can receive notifications, and the notifications page says how (D-230)
- **Channels** — An owner or an admin can bring an archived channel back from General, with its messages and members; its members see it again at once, and a name taken since is said (D-232)
- **Notifications** — Quiet hours: a window of the day on chosen days, every week, on the clock of your profile's time zone, when nothing pops up or rings — Deep Work by itself; what arrives is kept and counted (D-234)
- **Administration** — The server's administrator can suspend somebody's account from Server → Accounts: they are signed out on every device and cannot sign in, and their messages and name stay; lifting it lets them back in as they were (D-233)
- **Administration** — The audit log can be narrowed by person, action and days (in the reader's own time zone, kept in the page's address) and downloaded as CSV or NDJSON; a download is itself on the log, and every entry is also an ids-only line of the server's log (D-222)
- **Messages** — A file path with a line (`src/retry.ts:14`) or a commit's SHA in a message opens on GitHub, in the repository of the channel's one GitHub feed (D-223)
- **Channels** — An owner can let a channel keep its history longer than the workspace does, or forever, never shorter; the purge keeps the longer window, and Data & retention says how many channels keep longer (D-225)
- **Notifications** — An enabled device can request a test notification, with permission and device-setting guidance if it cannot be shown (D-148)
- **Threads** — Keep a selected answer, decision note and reference on a thread, with versioned edits that preserve drafts on conflict (D-204)
- **Questions** — Mark a question before anybody replies, assign a channel member, and filter unanswered or assigned questions with longest-waiting order (D-204)
- **Search** — Filter by resolution, question, date, code, files and repository, find decision notes and selected answers, and save personal searches (D-204)
- **Search** — Type operators with the words — `in:#channel`, `from:@person`, `has:code`, `is:open`, `repo:owner/name`, `on:`/`before:`/`after:` a day, `"exact words"` — in the search field, `/search` and the palette; they set the same filters as the controls, and one that names nobody is said and searched for as words (D-224)

- **Native app** — The public client handshake advertises additive API capabilities, beginning with notification type filtering, without requiring a newer app or changing contract-version gates (D-186)

- **Inbox** — Clients can filter notification history by one or more stored reasons before pagination, independently of All/Unread; omission keeps every type (D-106)

- **Operations** — A hosted deployment of several nodes shares one Redis, set with `REDIS_URL`: a message, a sign-out, who is online and who is typing reach every node, and a person's write limit is one limit across them. A Redis that goes away is degraded service, not an outage. Without `REDIS_URL` nothing changes and nothing connects (D-201)
- **Operations** — An operator can switch on point-in-time recovery for the database (`WAL_ARCHIVE=on`, off by default) and restore it to a named moment into a new instance without touching the live one, with the archive's retention tied to the base backups, a stated RPO and RTO, and the restore rehearsed weekly (D-202)
- **Operations** — `scripts/check-backup.sh` exits non-zero when the newest backup is older than 26 hours or the archive is failing, so a backup that stopped is noticed, and the documented cron lines are held to the layout a deploy leaves (D-202)
- **Sign-in** — A server can be connected to the organisation's OpenID Connect provider (Okta, Entra ID, Keycloak and the like) in Administration → Server or by `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: people sign in with it beside GitHub and email, and it is linked to an existing account only when both the provider and that account's address are verified (D-200)
- **Native app** — A person signs in to the macOS application in their browser and authorises it with one click; it gets a session of its own (D-191)
- **Native app** — The server says which client versions it still serves and where to get a newer one, and refuses an older one with a clear answer (D-190)
- **Operations** — Every release carries the contract bundle a non-browser client is generated from, with its digest (D-192)
- **Sign-in** — A person sees where they are signed in, under Sessions & account, by device name and when it was last used, and signs one place out without ending the rest (D-193)
- **Messages** — A client that was away asks what happened to a channel's messages since it last heard — edits, deletions, reactions taken back, replies, and messages that arrived late — and is answered by the messages themselves (D-194)
- **Sidebar** — A person folds each section by its heading (what is unread, what mentions them and the open row stay listed), and arranges the column from one menu: only what is unread, channels by name or by recent activity, Conversations and People switched off, muted channels left out, and a reset; the choices are kept per person and workspace (D-195)
- **Operations** — An operator can scrape `/metrics` with Prometheus by setting `METRICS_TOKEN` (off by default): requests by route and status, latency, open sockets, rate refusals, push and mail failures and the scheduled jobs, with no personal data (D-221)

### Changed

- **Operations** — A merge reaches the server only after that commit's own checks and its image have both succeeded; a deploy started by hand is held to the same (D-229)
- **Search** — The date filters are whole days in the viewer's time zone, as the date operators are, rather than UTC days (D-224)
- **Dependencies** — The toolchain and runtime libraries move to their newest patch releases; the three deprecations they flagged are removed (`dns` lookup order, the build's `rolldownOptions`, the account-linking option the library now makes unconditional); `knip` is held at 6.41 until it reads the entry points again
- **Operations** — The object store is Garage v2.5.0, with its fixes for a reflected XSS on error pages and a panic on a malformed URL; a node cannot go back to an older version once upgraded, so take a backup before the first deploy that runs it (D-219)
- **Operations** — `CONFIG.md` says how to set up SPF, DKIM and DMARC for the sign-in mail, and why bounces are not handled by the server
- **Performance** — Going back to a channel after reading far back through its history opens it as fast as any other: a channel that is left keeps its newest messages and reads the older ones again as they are scrolled to, instead of drawing them all at once (2.1 s for 2,000 messages before); the feed is not virtualized (D-199)
- **Process** — Phase 1 ends on what is built and verified end to end, not on a team staying off another product for thirty days; the cloud no longer waits on that count (D-197)
- **Performance** — The first-load JavaScript gate is a backstop at 400 KB gzipped, no longer a ceiling a feature is cut or deferred to fit; the time budgets are unchanged (D-196)
- **Sidebar** — The workspace's name at the head of the column has its tile and sits inset and rounded like the rows, so its hover and focus no longer touch the rail and the hairline; the jump field lines up with the rows (D-195)
- **Sign-in** — An emailed sign-in link can carry the application's pending sign-in into the browser that opens it (D-191)
- **Messages** — A person back from a long disconnect has every unsent message sent, up to the fifty a client keeps, where the server used to refuse all but the first eighteen: the burst a connection or a person's writes may spend at once is sixty frames, the rate still ten a second (D-198)

### Fixed

- **Setup** — The administrator's name follows the rule every name does: a right-to-left name with its direction mark is taken, a line separator is not, and the field stops at the 128 characters the server keeps (D-179)
- **Messages** — Quotes preserve lists and blank lines; code sharing keeps nested fences and pasted text intact, Enter follows the rendered code block, and Undo preserves later edits. Copy and wrap stay reachable on narrow screens (D-205)

- **Notifications** — A visible window behind another no longer marks new channel messages or thread replies read and closes their notices; returning to the conversation reads them (D-147, D-148)
- **Notifications** — Settings correctly lists channels set to Every message among what can interrupt; resolved questions remain in the inbox (D-107, D-148)
- **Inbox** — A row's time is when the person was told by the server's clock, so the demo's inbox no longer gives every row the moment it was seeded (D-106)
- **Messages** — A draft that comes back starting with `/` no longer opens the command list by itself, and a list closed with Esc stays closed (D-214)
- **Messages** — The key hints under the command list, the `@` list and the palette wrap as whole hints on a narrow window instead of two broken columns (D-214)
- **Messages** — On a device that is only touch no keyboard hint is shown — key labels, the hint rows they leave words in, and the editor's save keys — by the same test that makes Enter a new line there (D-188)
- **Threads** — Resolve names its shortcut as the keyboard prints it — Ctrl+Shift+R off a Mac, where it showed ⌘⇧R (D-122)
- **Workspace** — A size under a kilobyte reads as English counts it — “0 bytes”, “1 byte” — in storage, files and exports (D-41)

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
- **Integrations** — A GitHub delivery's signed body sent again under a new delivery id posts nothing: a feed refuses a body it has already posted (D-231)
- **Sign-in** — Asking for somebody's sign-in links no longer keeps them from signing in by email: the hourly limit is per address and client, with a higher ceiling per address (D-231)
- **Files** — A file kept in the browser is checked with the server each time it is opened, so somebody removed from a channel can no longer open its files from their cache (D-231)

---
