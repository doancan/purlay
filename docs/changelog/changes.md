# Purlay — Changelog

Notable changes, newest first. Releases get their own file: `docs/changelog/v{x.y.z}.md`.

---

## Unreleased

### Feature — 2026-10-12: the notification inbox, on the server (D-106)

- `GET /api/notifications?workspaceId=` lists what the caller was told — named, sent directly, answered
  in a thread, their question resolved — newest first, from channels they can still see, never about a
  deleted message; `unreadOnly` narrows it.
- `PUT /api/notifications/read` marks some or all read. The mention badge of each channel touched is
  counted again from the rows, and the caller's other devices are told at once.

### Feature — 2026-10-12: search a workspace (D-105)

- `GET /api/workspaces/:workspaceId/search?q=` finds the words as typed, ignoring case, in roots and
  replies, resolved threads too — in the channels the caller can see and nowhere else; a deleted
  message is never found. `channelId` narrows to one channel. Bounded in length (D-105 §2),
  newest first, a page at a time.

### Feature — 2026-10-12: private channels in the client, and bringing people in (D-104)

- The new-channel dialog offers Private, said in words beside the box; a private channel's header
  carries the lock.
- A channel's header offers Add people to its members: the workspace's people, narrowed as you type,
  each with Add. Loading, failure (with Retry), nobody else and nobody by that name are each said in
  words. The person added sees the channel in their sidebar at once.

### Feature — 2026-10-12: delete your own message, after being asked (D-103 §7)

- Your own message's menu has Delete, which asks first. The message is its tombstone at once — or gone,
  if nobody answered it — before the server answers; refused, the toast says why and the channel is
  read again. Everybody else sees it go at the same moment (`MESSAGE_REVISED`).

### Feature — 2026-10-12: edit your own message (D-103, `UX.md` §5, §7)

- Your own message has a menu, and Edit opens the words in the row — Enter saves, Shift+Enter is a new
  line, Esc lets go. `E` on a focused message of yours, and `↑` in an empty composer, open the same
  editor.
- Painted before the server answers. A refused edit puts the old words back, says why, and opens the
  editor on what was written.
- Choosing Edit from the menu leaves focus in the editor, not on the menu's button.

### Feature — 2026-10-12: an edit and a delete reach every open screen at once (D-103)

- `MESSAGE_REVISED` on the channel's topic carries what an edit or a delete changed — the words, the
  times, the mentions — at the message's version, and never its reactions or thread, whose own frames
  a late revision must not undo. A client keeps the newest revision of each message.
- A row says it was edited, with when on hover; a deleted message is drawn as its tombstone, in both
  languages, with no reactions and nothing to act on, and keeps its thread; a deleted message nobody
  answered leaves the screen, as it leaves the feed the server reads.

### Feature — 2026-10-12: private channels, and any member brings people in (D-104)

- A channel can be created `private`: seen by its members only. `POST /api/channels/:channelId/members`
  lets a member bring in somebody from the workspace, who is told with `CHANNEL_ADDED` and sees the
  channel at once. Not in the channel, or a direct message, is `403`; somebody not in the workspace is
  `404`; somebody already in it is `204` again and told nothing.
- A direct message and a channel member are checked as a person of the workspace by one function.

### Feature — 2026-10-12: a message can be deleted, and its thread stays (D-103 §7, D-9)

- `DELETE /api/messages/:messageId`: the author, or a workspace owner or admin. The content becomes an
  empty tombstone and nothing is erased — not the row, its thread, its reactions or what people were
  told. Deleted already is `204` again; another member is `403`.
- A deleted root with replies stays in the feed as its tombstone, with its thread, which can still be
  opened; a root nobody answered leaves the feed; a deleted reply stays in its thread, and the thread
  keeps its count. A deleted message cannot be answered, reacted to or edited.
- What it added to unread and mention counts is taken back, for exactly the people it was counted
  for, never below zero. Its waiting notifications are marked read and kept.
- Migration `0016` redefines the feed and thread indexes to hold tombstones; the replay still reads
  live messages only. The unapplied migrations planned after it moved up by one.

### Feature — 2026-10-12: the author can edit a message (D-103, closes O-1)

- `PATCH /api/messages/:messageId` replaces the content of the caller's own message, with no window;
  the message says it was edited. The body is read once again, as at write time (D-101): its metadata,
  its mentions. Another member is refused `403`; a message the caller cannot see, or a deleted one, is
  `404`. The same content again is not an edit.
- A name the edit adds is told once — a notification, and the mention count where the message is still
  unread. Nobody already told about the message is told again (it would break I-6), a name taken out
  keeps what it was told, and somebody who joined after the message is told for the inbox only.
- The row is locked before anything is decided: an edit that loses a race with a delete answers `404`
  and does not bring the deleted words back. The session is held live for the write (D-85).
- The reading of a body is one function for a send and an edit (`modules/messages/body.ts`). Other
  people see the edit on their next read; live, with the revision frame (#333).

### Infrastructure — 2026-10-11: the image can be published from a machine while the pipeline cannot

- `scripts/release-image.sh` releases a commit that is on `origin/main`, from a clean tree: `verify` with
  the database, one build of the commit's own tree for `linux/amd64` (or `PLATFORM`), `image-smoke.sh`
  against that build, the push as `sha-<commit>`, and the digest the registry holds — refused unless it
  is the image that was tested — to put in `PURLAY_IMAGE`. Its tests run it, against stubs. It refuses a dirty tree, an
  unmerged commit, a remote that names no GitHub repository, and a run without a database.

### Testing — 2026-10-11: the demo and every browser test reach the client through the API

- The demo's front server no longer serves files: it keeps its login and sends everything else to the
  API, which serves the build as the image does. The browser suite therefore runs the production path,
  under the document's real policy (D-102), and every test fails on any refusal the policy reports.

### Fix — 2026-10-11: a reader who has just scrolled up is not carried down by a message landing first

- Whether the feed follows what arrives is measured from where the reader is at that moment, not
  taken from the browser's last scroll report, which comes a frame late. Under load a message could
  land inside that frame: the reader who had scrolled up was moved to the bottom and shown no pill.
  The same holds when the box changes size, and a reader at the bottom of a box that shrank stays
  there. Found by the browser suite under load.

### Feature — 2026-10-11: the image serves the client, under the document's own security policy (D-61, D-102)

- The API image builds the client and serves it from the one origin: `/` and every path the API does
  not own is the shell, a hashed asset is cached for good, every other file is revalidated by its
  entity tag (`304`), and a path under `/api`, `/auth` or `/health` is never answered with HTML.
  `CLIENT_DIST` names the build; set without an `index.html`, the API refuses to start.
- The HTML document carries `DOCUMENT_SECURITY_POLICY` — no inline script, nothing framed — with
  inline style and GitHub's avatar host as two measured exceptions (D-102). API responses keep
  `default-src 'none'`.
- The proxy compresses (`encode zstd gzip`). The image smoke test checks the shell, its first script
  and that script's cache lifetime.

### Feature — 2026-10-11: messages are drawn as the markdown they were written in (D-101)

- `renderContent` draws the tree the server read: emphasis, strong, strikethrough, inline and fenced
  code, links, quotations, lists with their first number, task boxes that say whether they are done
  (in both languages), tables that scroll inside a box a keyboard can reach, rules and line breaks.
  A heading is bold at the body's size; four spaces are not code. Nothing is markup: the tree is drawn
  as elements, and a link is drawn only when its address is a `SafeHref`, checked again at the page.
- A body past a bound, one the engine fails on, or one that fails to draw is shown as typed — that
  body alone; the feed around it stands. The deepest bodies the bounds allow are drawn in Chromium
  and WebKit (`docs/spikes/markdown.md`).
- A mention is highlighted with the server's own pattern, in prose only, never inside code. The
  hand-written client parser is gone.

### Security — 2026-10-11: a link's address can only be made by the check that allows it (D-101 §9)

- A link in the narrowed tree carries a `SafeHref`, which only `SafeHref.of` can make: an object
  with an `href`, a string, or a spread of a real one does not compile, and asserting one fails
  lint, demonstrated by `verify:enforcement`. The renderer (#43) can take the tree on trust.
- The shape of an `@username` is one pattern in `@purlay/markdown`, used by the server to resolve
  names; the renderer (#43) is to highlight with it in place of the client's own copy.

### Feature — 2026-10-11: markdown is read once when a message is written, by the engine the browser will use (D-101)

- **One engine on both sides.** `packages/markdown` reads a body with micromark (the engine
  `remark-parse` wraps) and four GFM extensions; the server records the code languages, whether the
  body is only code, and a bounded few GitHub pull requests and issues in `messages.metadata`,
  validated against the contract before insert. The browser renders from the same reading next (#43).
- **Narrowed: the narrowing is the sanitiser.** Raw HTML, reference definitions, images, indented
  code, setext headings, character references and footnotes are never recognised; a link goes only
  where D-101 allows, as the browser reads its address, and anything else is its label's text.
- **Bounded, never refused.** The engine is superlinear on runs of delimiters and of address-like
  characters, and overflows the stack on containers opened on one line, so a body past the bounds
  is sent and stored as typed and records nothing. A lone `\r` no longer hides a line from the
  check. Where code is comes from the engine's own block reading: a pattern for it was tried, and a
  fuzz test showed it could not follow a fence inside a list item (`docs/spikes/markdown.md`).
- **A name quoted inside a `~~~` fence no longer notifies anyone.** The mention parser had code
  rules of its own and missed that fence; it now reads the body with every fenced block the engine
  reads blanked.
- An engine failure inside the bounds is logged as an error with its cause, never the content; a
  lint rule keeps the package free of anything a browser cannot run; thirteen mutations prove each
  bound and each half of the sanitiser is held by a test. Closes O-6.

### Fix — 2026-10-11: the API image builds again (#326)

- `docker build` had failed since 2026-10-10: the web client gained a dependency on
  `packages/tokens`, and the image's install stage did not copy that manifest, which a frozen
  lockfile requires. Nothing noticed because CI could not run. The manifest is copied, the image
  workflow now runs when it changes, and `scripts/dockerfile.test.ts` fails on any workspace whose
  manifest the install stage leaves out.

### Fix — 2026-10-10: answering your own thread is held to telling you nothing (D-29)

- The rule held, but nothing would have noticed it going: the test for a self-reply checked the
  sender's counters, which a different filter keeps, and never the sender's notification rows. It now
  does, and `scripts/mutations.ts` removes the guard to prove the test goes red.

### Docs — 2026-10-10: one verification command, and how a fresh clone reaches the database

- `CONTRIBUTING.md` §7 and §8 named `typecheck && lint && bun test` as the check before a PR — the unit
  tests alone — while §2 says `bun run verify` is the gate CI runs. Both now point at `verify`.
- §2 says where `DATABASE_URL` comes from locally (a `.env` Bun reads, the compose database's URL);
  without it the integration tests were skipped behind a banner and nothing said how to turn them on.

### Feature — 2026-10-10: the browser tests, the demo and the budgets (D-49, D-50, D-98)

- **`bun run demo`** builds the client, recreates a scratch database, seeds a believable workspace
  through the real API (sixty messages in #api with three threads, two hundred deploy notices to page
  through, reactions, mentions, a read position) and serves it on one origin, with a demo-only sign-in.
- **Playwright and `@axe-core/playwright`**, against that harness, in dark and light at 1440 and 820 px:
  the sign-in screen, the 404, the gallery, the skip link and the focus that follows a navigation, a
  theme that is set before first paint, the seeded data through the browser's own `fetch`.
- **The shell is prerendered**: `AppSkeleton` is rendered into `dist/index.html`, so the first response is
  layout (a test photographs it with JavaScript off and checks the real frame's sidebar is the same width).
- **`bun run budget:web`** fails above 250 KB of initial gzipped JavaScript, names the chunks (and, with a
  source map, the sources inside the largest), and fails a highlighter grammar or a second locale in the
  initial chunks. It is in `verify` and CI.
### Feature — 2026-10-10: the interface has an identity (D-100)

- **Cards on a canvas.** The window is a tinted ground and the sidebar and the channel are two rounded
  cards on it, with one soft shadow; the sign-in screen and every empty state are the same card. A control's
  corner is 8px, a card's 14px. Both themes.
- **Avatars, and still no bubbles.** Initials on one of six tints chosen from the username (stable, nothing
  to fetch or fail), in a fixed column beside the text; the time is next to the name. Code blocks keep the
  whole width of the column. There is no presence dot because there is no presence.
- **One typeface, served from here.** IBM Plex Sans and Mono in Latin and Latin Extended (ğ ş İ are in the
  second), self-hosted under `public/fonts` with the OFL beside them; `tokens.json` refuses a URL, and a
  browser test checks the faces really load, Turkish letters included, from this origin.
- **A new shape for the chrome.** A jump field in the sidebar that opens the palette, the two views as a
  segmented control in the header, a composer that is one card with a round Send button and hints only
  while it has focus, a palette whose rows carry an icon tile or an avatar, a skeleton that looks like a
  row. The phone header no longer clips; an open-question's text wraps on two lines instead of being cut.
- **Test and record.** `UX.md` §2, §3 and §9 are rewritten, D-100 records what was amended (no avatars, no
  depth, system fonts) and what was rejected (bubbles, a variable font, a font service, GitHub photographs);
  the visual baselines are regenerated and looked at. The connection-bar test now waits for the app to be
  connected rather than for the browser's socket, which had made it race.

### Feature — 2026-10-10: the channel feed (D-98, D-99)

- **A channel reads like a log**, as the approved prototype draws it: a 56px time gutter, no avatars, the
  author's name once per run of messages within five minutes, the time of a grouped message there on hover
  without moving anything. Day dividers, a real `<time>` with the full time on hover, a mention of the
  person tinted and said in words.
- **Message text is read as exactly three things** — fenced code, inline code and bare `http(s)` links —
  plus the `@name` the server resolved, as React nodes and never as markup. The parser is a single forward
  scan, tested at the longest message a person may send with inputs built to make a regular expression
  back out of itself. Code blocks carry their language and line count, a copy that holds the raw text,
  and a clamp above twelve lines. Shiki colours them with the `--syntax-*` tokens, loaded on first use:
  the initial bundle holds no grammar.
- **A send paints before the network answers** and never moves when the echo arrives; sending has a clock
  in the gutter, failed has a coloured edge, a reason, Retry and Delete.
- **The reader's place is kept** (`UX.md` §6): not moved by what arrives below or by older pages loaded
  above, followed only from within 80px of the bottom (and always after their own send), a "N new
  messages" pill otherwise; a channel opens at its unread marker, and counts as read when the bottom has
  held for half a second, once more on leaving — never on render, never from a hidden tab.
- Reactions are the server's set (chips with a pressed state, a seven-emoji menu); rows are memoised and the
  data layer keeps message identity, so one new message draws one new row. New tokens: `size-code-clamp`
  (the 280px clamp) and `stroke-marker` (the failed message's edge).

### Feature — 2026-10-10: the client's foundations, in both themes and two languages (D-98)

- **Light and dark ship together.** The theme is the operating system's until a person chooses, kept per
  device, and set before first paint by a same-origin script (no inline script for a content security
  policy to refuse). A development gallery shows every primitive and state in both themes at once.
- **English and Turkish from the first screen**, on `Intl` and typed catalogues: a missing or misspelt
  key is a compile error, plurals are the platform's decision, and each language is its own chunk.
- **A typed router of our own** (a route table, `Link`, `useRoute`), no dependency; `Link` is a real
  anchor that takes over only a plain left click.
- **Primitives on Radix** (dialog, menu, tooltip) and written here (button, text field, toast, states),
  every class a token. Two accessibility defects only a test could find are fixed: a controlled dialog
  returned focus to the page's top, and its auto-focused close button opened a tooltip that swallowed the
  first Escape.
- **The application frame:** a skip link, one `<main>`, and focus that moves to it when the address
  changes — a client-side navigation otherwise leaves a keyboard user on the link they pressed.
- Component tests run `axe` on every primitive in each state; the helper is itself tested to fail on an
  inaccessible page. Dialog, palette and toast widths are tokens.

### Feature — 2026-10-10: the visual vocabulary is one file, and the build judges it (#137)

- `packages/tokens/tokens.json` holds every colour in both themes, the scales and the type styles;
  `bun run tokens:generate` writes the CSS custom properties, the Tailwind binding and the token names.
  Tailwind's default theme is no longer imported, so `bg-red-500` and `p-7` do not exist (D-97).
- Control height, header height, message-timestamp column, badge and presence dot are tokens
  (`h-control`, `h-header`, `w-gutter`, `h-badge`, `size-dot`): the five lengths the approved prototype
  needed that the file did not have (D-97 §7).
- **Contrast is computed, not claimed.** `pairs.ts` states which colour is read on which, and every
  colour must be in a pair or have a reason not to be. The first run found `border-strong` at 2.85:1 on a
  mention row in the dark theme; it is fixed.
- **Three refusals of a raw value:** the file's validator, a lint rule, and a test that compiles every class
  the application writes and fails on one that builds to nothing or to a literal (`z-50` builds from a
  bare number whatever the theme says).
- One icon set behind one component: `Icon` takes a meaning and a size token, and has no stroke width to
  ask for. The component test harness now registers its DOM per file; with a second component test
  the first harness gave the second file none.
- The numbers `UX.md` repeats (widths, base type size, the radius) are bound to the file by a test.

### Fix — 2026-10-09: the image smoke test brings its own database

- It reached the development database through `host.docker.internal`; binding that database to the loopback
  address (#299) made it unreachable from a container on a Linux runner, and the `image` check was red on main
  for three commits. It now starts a PostgreSQL of its own on a private network, reached by container name,
  with nothing published, and removes everything when it ends (#231, D-92 amended). A test fails if the
  script references the host or the development port again.

### Fix — 2026-10-09: the image ships no tests, and health probes stop filling the log

- The image contained every `*.test.ts` (75 files, 83 with the test-only directory). They are left out in
  `.dockerignore`, and `scripts/image-smoke.sh` asks the image itself: 83 before, 0 after (#231, D-92
  amended).
- `/health` and `/health/ready` request lines are written at `debug` instead of `info` (about twelve lines every ten
  seconds, with a balancer and the container health check polling); a failing probe is still visible, because readiness writes its reason at `warn`.

### Fix — 2026-10-09: a node that migrates as it starts is not cut off at 30 seconds

- Migrating on start ran on the application's pool, which cancels a statement after 30 s: a migration with a
  longer statement failed, the node exited, and its restart failed at the same point. It now opens a
  connection of its own, the one `bun run db:migrate` uses, with no statement timeout (D-87, D-93, #231).

### Fix — 2026-10-09: the database counts a message's length in the contract's unit

- `messages_content_length` counted characters while the contract counts UTF-16 code units, so a writer
  that is not a door could store sixteen thousand emoji — more than a frame can carry. `0011` counts
  units; the limit a person sees is unchanged (D-67, amended).

### Fix — 2026-10-09: a client watching thousands of channels subscribes in turn

- 3,500 watched channels were 35 `SUBSCRIBE` frames sent in one burst: the server rate-limited some and
  then closed with `TOO_BUSY`, on every reconnect. The client now sends one chunk, waits for its
  acknowledgement, retries a `RATE_LIMITED` chunk with backoff, and waits longer after a `TOO_BUSY`
  close (D-82, #231). `ARCHITECTURE.md` §5.4 also states that every reconnect replays about 65 s of
  already-held messages, deliberately (D-65), and what that costs.

### Fix — 2026-10-09: a socket that fails to open is told in a frame

- An identity read that failed after the upgrade was admitted produced a raw error body that clients took
  for malformed and reconnected into at once. It is now an `ERROR` frame and a close with `TOO_BUSY` or the
  new `INTERNAL` (1011) (D-84, amended). D-88 records that a retried send publishes the stored row,
  tombstone included.

### Fix — 2026-10-09: a replay does not carry messages written after a revocation

- A member removed between a subscription's authorisation and its replay read was sent messages written
  after the removal, ahead of the notice. The hub drops replayed messages of channels revoked while the
  replay was held (D-85, amended).

### Fix — 2026-10-09: a sign-out while a socket opens no longer leaves it open

- A sign-out between the hub reading the session and the socket subscribing to its end was published to
  nobody; the socket stayed authenticated and a send on it was acknowledged. The socket now listens first
  and confirms the session with a second read (D-85, amended).

### Fix — 2026-10-09: a user's sockets share one write budget, and the sockets are capped

- One user opened 100 sockets and sent 20 messages on each: all 2,000 were acknowledged in eight seconds
  with no `RATE_LIMITED`, against HTTP's ten a second for the same person. `MESSAGE_SEND` is now charged
  to a per-user bucket shared with HTTP's writes, and a user may hold 20 sockets and a node 2,000, refused
  at the upgrade (`429` / `503`) and enforced again as upgrades bind. Provisional numbers (D-84, O-4).

### Docs — 2026-10-09: an upgrade and rollback runbook, and the failure it rests on shown

- `ARCHITECTURE.md` §11 now says how to upgrade (backup first, change `PURLAY_IMAGE`, expect `/health/ready`
  to be 503 for the length of the migration), what happens when it goes wrong (a failed migration, or an older
  image against a newer schema, stops the node with `migrating on start failed` and exit 1 — reproduced),
  how to roll back (restore the backup taken first, `restore.sh --no-bucket`), and what losing or changing
  `ENCRYPTION_KEY` costs (#231).

### Fix — 2026-10-09: the migrator survives a deadlock against live traffic

- At about 5,000 writes a second migration 0010 was ended with `deadlock detected` by sends taking the
  same locks in the other order. A migration ended that way is now run again (five attempts, 250 ms to 2 s
  apart, each logged); nothing else is retried. The 0010 header no longer says its lock is held "for an
  instant", through a checked table of comment-only corrections that leaves the statements' checksum
  rule intact (#231, D-86). Run migrations at low traffic.

### Fix — 2026-10-09: sign-in survives what GitHub sends and a double-clicked callback

- A NUL or other control character in a GitHub login or name failed sign-in; they are removed. Two
  callbacks for one account at once answered 500 for the second; both now succeed and share one account
  (D-78, amended).

### Fix — 2026-10-09: the key checks cannot be walked around, and an integer is an integer

- A second-round attack changed the development key's last base64 character (same bytes, different
  string) and passed; patterns like `abcd` repeated and bytes 0..31 passed too. The key must be
  canonical base64, is compared to the development key as bytes, and is refused when it is a
  pattern. `SESSION_TTL_DAYS=1.5` is refused instead of truncated (D-79, Part of #231).

### Fix — 2026-10-09: the proxy no longer logs query strings, its ports can move, and there is a file to start from

- Caddy's access log wrote `/auth/github/callback?code=...&state=...` in full. It now logs the path and
  nothing after the `?` (#231, D-94 amended); shown on a real run below the pull request.
- `HTTP_PORT` and `HTTPS_PORT` move the proxy's host ports; the HTTPS port is also in `APP_URL`, and the
  caveat about public certificates is in `CONFIG.md`.
- `docker/production.env.example`: every required variable, secrets empty so an unedited copy fails by name;
  a test binds it to the compose file.

### Chore — 2026-10-09: nothing may remove visibility without deciding what sockets are told

- A test finds every production statement that revokes a session, soft-deletes a user, workspace or
  channel, or deletes or updates a membership, and requires each to be mapped to the event it publishes,
  or to a reason and an owner. A planted unlisted write fails it (#231, D-85).
- Out-of-band SQL revocation is documented as not ending open sockets until expiry or a restart. A
  command-line revoker is not provided: another process cannot reach the in-process bus.

### Fix — 2026-10-09: a mutation's body must be JSON

- A form post with no `Origin` and no `Sec-Fetch-Site` created a workspace, so D-39's "a cross-site
  form cannot produce JSON" held for nothing. Any other body type is now `415`
  `UNSUPPORTED_MEDIA_TYPE`; requests with no body are unaffected (D-80, Part of #231).

### Fix — 2026-10-09: a send cannot commit after its session was revoked

- A sign-out racing a send let one write commit after `revoked_at`, because the socket's identity is
  cached. The send now takes a share lock on the session row in its own transaction: the write
  commits before the revocation or is refused (D-85, Part of #231).

### Fix — 2026-10-09: a control character in a name is a 400, not a 500

- A NUL in a workspace or channel name was an `INTERNAL` error and an error report. Names now refuse
  control characters, separators, lone surrogates and bidirectional overrides at the contract;
  topics refuse what PostgreSQL cannot store; GitHub's display name has them removed (D-40,
  Part of #231).

### Fix — 2026-10-09: a restore reads the dump before it replaces anything, and a backup is private

- `restore.sh --replace` dropped the live database before reading the dump: a truncated dump whose checksums
  had been regenerated left the live database with 20 400 messages turned into 0. It now validates, restores
  into a staging database, checks it, and swaps by renaming; a bad dump leaves the target exactly as it was
  (#231, D-95 amended). The default restore now puts the bucket in a new place too and checks it before the
  database is touched.
- Backups are `0700`/`0600` instead of the caller's umask (any local user could read them), and a failed
  backup removes its partial directory, saying to run `production-init.sh` when the object store was never
  initialised. The weekly rehearsal asserts all of it.

### Fix — 2026-10-09: the error reporter cannot be held hostage, and does not name the host

- A collector that accepted connections and never answered held all ten report slots for ever: 25 failing
  requests gave ten deliveries and then silence until restart, with nothing logged, and SIGTERM ran to the
  ten-second deadline. A report now gives up after five seconds, drops are logged at `warn` at most once a
  minute, a redirect is not followed, and shutdown waits for the reporter two seconds at most (#231, D-96
  amended). Run against a real never-answering collector: ten delivered, one drop notice, the next five
  delivered after the timeout, SIGTERM answered in two seconds.
- Stack traces in a report no longer contain absolute paths of the machine (home directories, the build
  directory): relative to the working directory, to the package in `node_modules`, or the file name alone.

### Chore — 2026-10-09: the image and rehearsal checks run on every pull request, and the published image is the tested one

- The `image` and `restore-rehearsal` workflows had path filters, so a pull request that broke the
  Dockerfile or `backup.sh` ran no check and could merge, and a check that does not run cannot be required.
  Both now run on every pull request and skip their work inside the job when nothing relevant changed
  (`scripts/pr-touches.sh`, which fails closed on a listing it cannot read). Check names to require: `build`
  and `rehearse` (#231).
- On main the image is built once, pushed by digest, smoke-tested as that digest, and tagged — not rebuilt
  between testing and publishing (D-92 amended).
- No `actions/checkout` keeps the job token in `.git/config` any more (`persist-credentials: false`); a test
  fails a checkout without it (D-91 amended).

### Fix — 2026-10-09: an export nothing imports now fails the build

- `knip` was promised in D-48 and never ran. It runs in `verify` and in CI, and
  `verify:enforcement` plants an unused export to show it fail (29 stated rules now). Its first
  run found 19 things: eight exports and types made private, two re-exports and the `happy-dom`
  pin deleted; three container scripts and the browser realtime client are named in `knip.jsonc`
  with a reason, the latter until the client store lands (#136, #26).

### Feature — 2026-10-09: errors can be reported, and by default are not

- With `ERROR_TRACKING_DSN` set, whatever is logged at `error` is also posted to a Sentry-compatible
  endpoint, cleaned exactly as the log is and carrying the request id; unset, nothing exists and
  nothing leaves the process. No vendor library; bounded, drops under a storm, never throws into the
  caller; a malformed DSN, or an `http://` one in production, refuses to start (#248, D-96, D-44).
- Against a stand-in collector, one real 500 produced one envelope with the DSN set and none without.

### Test — 2026-10-09: the audit's mutation survivors are killed

- Of 21 mutations re-derived against the current code, 15 survived the tests as they were on main and
  none survives now: a retry from another channel is a conflict, history and replay leave deleted messages
  out and cap the page, the OAuth state's length check and a missing `code` are tested, `SESSION_TTL_DAYS`
  is held to 1–365, the member list and `/api/me` leave tombstones out, the web connection ignores a replaced
  socket's frames, and a send is announced only after its commit (a second connection reads the row at the
  moment of publication). `bun run mutate` keeps all of them (#246, D-47).

### Feature — 2026-10-09: a mutation runner that never touches the working tree

- `bun run mutate` applies each mutation in `scripts/mutations.ts` to a copy of the repository, runs the
  tests it names and reports caught, survived, stale or equivalent; it refuses to judge when the
  unmutated tests already fail. Its own test shows a known survivor reported as survived and a known kill
  as caught (#246, D-47).

### Fix — 2026-10-09: the integration suite no longer times out its own hooks

- CI failed about every other run with "a beforeEach/afterEach hook timed out": the migrator test made
  thirteen databases and dropped them in `afterAll`, each drop a checkpoint. It now uses schemas;
  readiness breaks the database in rolled-back transactions; the template is built once per process in a
  preload; drops are issued together (`dropDatabases`) and a budget test guards the cost. Also made
  deterministic: the migrator's lock-blocking test (held by an advisory lock, not by sleeping), the
  shutdown drain tests (gates, not sleeps), the socket cleanup test (a server of its own), the
  falls-behind test (sends until the server gives up) and the HOT-update test (a clone's empty pages)
  (#246, D-46).

### Feature — 2026-10-09: a backup that has been restored

- A populated stack — 20 400 messages, awkward unicode, 44 objects up to 12 MiB — was backed up and
  restored into a fresh database and bucket and compared identical; then every volume was destroyed
  and the stack rebuilt from the backup alone (#248, D-95, D-73). Record, commands and what it does not
  show: `docs/spikes/backup-restore.md`.
- The rebuild found two defects the first restore could not: storage initialisation needed a running
  API, and an empty array under `set -u` on macOS's Bash 3.2.
- `scripts/restore-rehearsal.sh` is that, as a command, and runs weekly in CI (D-44).

### Feature — 2026-10-09: backup, restore and a comparison that judges them

- `scripts/backup.sh` writes a directory: a custom-format `pg_dump` (read back with `pg_restore --list`
  before it counts), the bucket with a manifest, and `SHA256SUMS`. `scripts/restore.sh` checks the sums,
  restores into a new database by default, refuses a target that has tables, refuses to replace the live
  database while the API runs, and imports only into an empty bucket. `scripts/compare-databases.sh`
  compares per-table counts and a checksum of every row (#248, D-95).
- `production-init.sh` checks that an anonymous read is refused from a one-off container, so storage
  can be initialised before the API has ever started — the order a rebuild after a loss needs.
- Shell scripts are held by a test: they parse, are executable and stop at the first failure.

### Feature — 2026-10-09: the object store can be copied out and back, and compared

- Nothing backed up the bucket. `scripts/bucket-copy.ts` exports every object with a manifest of its
  size and SHA-256, imports into an **empty** bucket only, and verifies a bucket against a manifest;
  the first of the backup work for D-95 (#248). It runs inside the API image, on the stack's network,
  because the store is published nowhere.
- Keys that would not map to exactly one file — an empty, `.` or `..` segment, a leading slash — are
  refused at export instead of overwriting each other: `a//b` and `a/b` are one file on disk and two
  objects in the bucket.

### Feature — 2026-10-09: a production compose file

- `docker-compose.production.yml`: the API, PostgreSQL, Garage and Caddy behind one origin with
  automatic TLS. Only the proxy publishes ports (80 and 443); the API starts when its dependencies
  are healthy and the proxy when the API is ready; every image but the API's is pinned by digest
  (#248, D-94, D-73).
- Its only inputs are the variables in `CONFIG.md` plus `PURLAY_IMAGE`, `POSTGRES_PASSWORD` and
  `GARAGE_RPC_SECRET`; a missing one stops `docker compose` naming it. `scripts/production-init.sh`
  creates the storage layout, bucket and key once. Brought up on an empty machine it migrated itself
  and answered `https://localhost/health/ready` with 200 through Caddy's internal CA.

### Feature — 2026-10-09: the API migrates itself on start, once, however many nodes there are

- `MIGRATE_ON_START=true` (off by default) makes the process apply pending migrations after its listener
  opens; nodes started together take turns in the migrator's lock, and a node whose migration fails
  exits 1 (#248, D-93).
- Two real API processes started at the same instant against an empty database both become ready with
  every migration recorded once. Run before the migrator polled for its lock, the same test deadlocked
  (three in three); it now passes because of the migrator, and fails three in three if the migrator's
  lock is taken out.

### Chore — 2026-10-09: lint refuses the door-to-door import and production code importing test code

- `realtime` cannot import `ingress`; production code under `apps/api/src` cannot import a `testing/`
  directory or `*.testing.ts` file (`purlay/no-test-code-import`). Both have cases in
  `verify:enforcement` (28 stated rules now), shown failing when the rule is switched off.
- `bunfig.toml` leaves `apps/*/src/testing/**` out of coverage, which is safe because of the second
  rule (#245, #136, D-47).

### Feature — 2026-10-09: the API has an image

- A two-stage `Dockerfile`: production dependencies from the frozen lockfile, then a distroless
  runtime that runs the source as user 65532 with a read-only root filesystem, no shell, and a health
  check on `/health/ready`. Both bases are pinned by digest (#248, D-92).
- Every pull request that touches it builds the image and runs it against the compose database
  (`scripts/image-smoke.sh`); a push to main publishes it to GHCR with provenance and an SBOM.
  The publish job can only be exercised once it is on main.

### Chore — 2026-10-09: the browser has a place to read the clock

- `apps/web/src/system-clock.ts` is the one file in the client that reads the time, exempted by name
  in `eslint.config.mjs` the way `platform/clock.ts` is for the API; everything else takes a `Clock`.
  `verify:enforcement` now also shows a neighbouring web file is still refused (#136).

### Refactor — 2026-10-09: the socket lifecycle leaves the composition root

- `ingress/http/app.ts` (438 lines) keeps the routes and edge hooks; admission, open, frame handling
  and close are `ingress/ws/socket.ts`. No behaviour change (#245, D-47).


### Chore — 2026-10-09: every Action is pinned to a commit, and a test says so

- `actions/checkout`, `oven-sh/setup-bun` and `actions/setup-python` were pinned to tags their
  owners can move. Each is now a full SHA with its version in a comment, resolved and checked
  against the tag with the API; `scripts/workflow-pins.test.ts` fails any `uses:` that is not
  (#247, D-91). Dependabot's github-actions ecosystem keeps proposing the next SHA.

### Fix — 2026-10-09: two processes migrating at once no longer deadlock

- A starter waiting for the migration lock was a transaction to PostgreSQL, and `CREATE INDEX CONCURRENTLY`
  waits for those: one of two simultaneous starters died with `deadlock detected`, every time. The lock is
  now polled with `pg_try_advisory_lock`, so a waiting starter is idle between attempts. Reproduced first
  (10 of 10 runs red), then 20 of 20 green; replacing the poll with the blocking lock turns it red again
  (D-86, #231).

### Refactor — 2026-10-09: the `/api/me` query is a module's

- `readMe` no longer holds a raw query; `meOf` in `modules/workspaces` does (#245, D-47).

### Refactor — 2026-10-09: replay budgeting is a module; the casts that hid the frame union are gone

- Replay caps and the cursor floor moved from `realtime/router.ts` to `modules/messages/replay.ts`.
  `frame()` can no longer pair an event with another event's data, and the timer handle is typed.
- Joining a private channel or a DM you are in answers 404; that branch is now tested (#245, D-47).

### Refactor — 2026-10-09: test scaffolding moves to `src/testing/`

- `ingress/http/testing.ts`, `fixtures.ts` and `cross-tenant.ts` are now `testing/doubles.ts`,
  `signed-in.ts` and `cross-tenant.ts`. The cross-tenant table finds `docs/API.md` from its own
  location instead of the working directory (#245, D-47).

### Refactor — 2026-10-09: sign-in and session resolution are modules; ingress only translates

- `completeSignIn` and the session-end fan-out left `ingress/http` for
  `modules/auth/sign-in.ts` and `platform/events.ts`. A cookie header becomes a session in
  one function used by the HTTP guard, the hub and the socket admission, and the cookie definitions
  moved to `platform/cookies.ts`, so `realtime` no longer imports `ingress` (#245, D-47). Behaviour unchanged.

### Fix — 2026-10-09: the database refuses a message in the wrong tenant

- A message whose channel was in another workspace, a reply in another channel than its parent, a read
  position in another channel, a message id that was not a UUIDv7, and a DM key of `garbage` were all
  accepted. They are composite foreign keys and two CHECKs now, each with a test that attempts the violation
  and expects the constraint by name. Added `NOT VALID` and validated outside the transaction: on 1,000,000
  messages the slowest read during the migration was 6 ms and the slowest write 57 ms (#242, D-90).
- `SCHEMA.md` §11 says which invariants stay with the service, and why.

### Fix — 2026-10-09: deleting a message or a channel is no longer a table scan per row

- On 1,000,000 messages, deleting 100 took 4.8 s and deleting one channel did not finish in 60 s: the
  foreign keys on `messages` and `channel_members` had no index to be enforced with. Every foreign key
  column now has one (built concurrently): the same deletes take 8.7 ms and 90 ms. A test reads the catalogue,
  so a future table cannot forget (#241, D-89).
- `idx_workspaces_slug`, which duplicated the unique constraint's index, is gone. The search index's cost
  was measured and is written down: 15 to 25 microseconds a message, and it stays.

### Fix — 2026-10-09: a send no longer rewrites the channel row's indexes

- Every send updated `channels.last_message_at`, which was in `idx_channels_workspace`: of 2,000 sends, none
  was a heap-only update and the indexes tripled. The column left the index (migration `0008`); the same
  2,000 sends made 1,999 HOT updates and the indexes did not grow. The update is also monotonic now, and
  skipped when the message is not the newest (#244, D-88).
- A retried send announces the stored message again, on purpose, and a test says so.

### Fix — 2026-10-09: a socket frame that finds no database connection says so

- A `MESSAGE_SEND` or `SUBSCRIBE` that waited out the pool was answered `INTERNAL`; it is now the
  `DATABASE_UNAVAILABLE` frame HTTP already used, so a client may retry it (D-87).

### Fix — 2026-10-09: the connection pool fails fast and says what is wrong

- With a pool of two, a third query waited **7,612 ms** for a connection to free. It now waits at most
  3 s and fails with `DATABASE_UNAVAILABLE` (`503`), carrying no detail. Every connection also has a
  30 s statement timeout, a 15 s idle-in-transaction timeout and `application_name = purlay-api`; an
  idle connection the server drops is reported instead of ending the process (#243, D-87).
- `DATABASE_SSL_CA_FILE` trusts a private or managed certificate authority.
- `purgeDeadSessions` removes expired and revoked sessions in bounded batches. The scheduler is #71.

### Fix — 2026-10-09: readiness notices an edited or missing migration

- `/health/ready` now answers 503 when an applied migration's file was edited, has gone, or sorts out of
  order, the same states the migrator refuses to run past (D-86). A database from before checksums existed
  is still ready.

### Fix — 2026-10-09: a connection failure is written with what failed

- `pg` throws an `AggregateError` with an empty message when a host resolves to several addresses and
  none answers, and the log wrote `"message": ""`. It now writes every nested error with its message,
  and any error's system code (`ECONNREFUSED`, `23505`) as `errorCode` — not `code`, which stays on the
  never-logged list.

### Fix — 2026-10-09: a migration can leave its transaction, and an edited migration is noticed

- `0007` said `NOT VALID` then `VALIDATE` "lets writes continue". Inside the migrator's transaction it did
  not: on 1,000,000 messages a concurrent `SELECT` hit its statement timeout while the validation ran.
  A file can now opt out with `-- purlay: no-transaction`, and the same migration then delayed no `SELECT`.
  `CREATE INDEX CONCURRENTLY` becomes possible (#240, D-86).
- Each applied migration records its checksum; an edited, missing or out-of-order file stops the migrator
  before anything runs. `db:migrate` reads `DATABASE_SSL` like the application.

### Feature — 2026-10-09: a membership or session change ends delivery on every node

- A revoked session closed its sockets only on the node that handled the sign-out; a removed member
  kept receiving a channel on an open socket while HTTP answered 404; a deleted user's sockets lived
  on (#238, #203). Three bus events now carry these: `SESSION_ENDED` on `session:` and `user:`
  (`account-deleted`), and the new `ACCESS_REVOKED`, which unsubscribes the channels and leaves the
  connection open (D-85).
- Shown with two applications sharing one backplane and real sockets: sign-out on one closes the
  socket the other holds, and a removal published while a subscription is being authorised still
  ends it, because a subscription is now made before its channels are authorised.

### Fix — 2026-10-09: a socket's frames are handled in order, and a drain waits for them

- The framework started a handler per frame and did not wait for the last: a fast `UNSUBSCRIBE` was
  overtaken by a slower `SUBSCRIBE` (reproduced: the client kept receiving), and a frame still reading
  the database could meet a closed pool at shutdown. Frames now run one at a time behind a queue of 32;
  a connection that fills it is closed with the new `TOO_BUSY` (1013) (#237, D-84).

### Fix — 2026-10-09: one socket's failure no longer costs the others a frame

- The bus delivered in a bare loop: a send that threw stopped every later subscriber from receiving
  a message that was already committed, and surfaced as an error to the publisher. Each delivery is
  now isolated and a failure is logged with the socket's id, never the frame (#237).
- What a closed socket leaves behind is asserted on sizes: the hub, the bus and the limiter return to
  zero through the running server, and the expiry timer is shown cancelled on close. (The timer was
  already cancelled; it had no test.)

### Fix — 2026-10-09: a subscription is made before its replay is read

- A message committed between the replay read and the subscription was in neither, and the client's
  cursor moved past it. The socket is now subscribed first, live frames are held until the replay is
  written, and a message in both is sent once (#237, D-83). The bus also kept an empty entry for every
  socket that unsubscribed; it no longer does.

### Fix — 2026-10-09: a client's mistake is never a 500

- A body that is not JSON, a lost race for a workspace slug or channel name, and a GitHub login or
  display name longer than its column all answered `500`. They are now `400 VALIDATION_FAILED`,
  `409 *_TAKEN` and a shortened stored name, mapped in `refusalFor` and the identity rules
  (#233, D-78). A unique index nobody listed still answers `500`.

### Fix — 2026-10-09: a request that writes twice writes both or neither

- Creating a workspace, creating a channel and signing in each made several writes on the pool, so a
  failure between them left an ownerless workspace (slug taken for good), a nameless channel, or an
  account without a session. They now run in one transaction, and the services that write twice
  accept only a `Transaction` — the pool no longer compiles (#232, D-77).
- The test that proves it makes the second write fail on a cloned database and finds the first gone;
  before the fix it found it still there.
### Feature — 2026-10-09: HTTP routes are rate limited, and a session records where it started

- `/auth/*` is limited per client address and every mutation under `/api/*` per signed-in user, at
  the socket's budget, so `POST /messages` is no longer the unthrottled way in. A refusal is `429`
  with `RATE_LIMITED` and `Retry-After`. Numbers provisional (O-4). `TRUST_PROXY` is read: without
  it `X-Forwarded-For` is ignored. `sessions.ip_address` is written at sign-in (D-81, #235).

### Feature — 2026-10-09: the HTTP edge is bounded

- A JSON body over 64 KiB is refused with `413` by the server before it is read (a 60 MB body was
  parsed and answered `200`). A mutation from another origin is `FORBIDDEN`, logout included. Every
  response carries `nosniff`, referrer, framing and cache policy, and HSTS over https. A well-formed
  inbound `x-request-id` is kept as a label (D-80, #234).

### Fix — 2026-10-09: configuration refuses an unsafe production

- `ENCRYPTION_KEY` is decoded: 32 bytes, not one repeated value. Production refuses the public
  development key (which was itself 33 bytes), `DATABASE_SSL=false` without
  `DATABASE_ALLOW_PLAINTEXT=true`, and an `APP_URL` that is not `http`/`https`. Every refusal names
  its variable and never prints a value (D-79, #236).

### Chore — 2026-10-09: the browser has a place to read the clock

- `apps/web/src/system-clock.ts` is the one file in the client that reads the time, exempted by name
  in `eslint.config.mjs` the way `platform/clock.ts` is for the API; everything else takes a `Clock`.
  `verify:enforcement` now also shows a neighbouring web file is still refused (#136).

### Fix — 2026-10-09: the client notices a dead socket and stops retrying a refusal

- A half-open socket (sleeping laptop, dead NAT) read `open` for minutes. The client now pings after
  25 s of silence and treats 15 s without any frame as dead, reconnecting at once (D-82, #239).
- A signed-out user retried every 30 s forever, because a refused handshake is a 1006 like any outage.
  After three attempts that never opened, the client asks `GET /api/me` and stops on a 401.
- An event the client does not know is ignored instead of looping the connection through close and
  reconnect during a rolling deploy; `parseServerMessage` replaces `parseServerFrame`.
- The first `PONG` now feeds the server clock, and `start()` works again after `ended`.
- `ARCHITECTURE.md` §5.4 states the cursor caveat: a live frame does not move the cursor past a
  replay whose HTTP continuation is unfinished; the connection exposes `pendingContinuations` and
  `continuationDone` so the store can honour it.

### Chore — 2026-10-09: the dependency audit blocks, and four of the five findings are fixed

- `bun audit fix` moved `brace-expansion` 5.0.9 to 5.0.12 and `source-map-js` 1.2.1 to 1.2.2, within
  range, which clears three high and the moderate finding (#247). The audit is a job of its own that
  fails at high severity (`bun run audit:gate`), weekly as well as on every change.
- **The fifth cannot be fixed.** `braces` (through `kysely-codegen`, a development tool) has no
  patched release at all — the advisory lists none. It is in `scripts/audit-allowlist.json` with the
  reason and an expiry; the gate fails on an expired entry and on an entry that matches nothing.

### Chore — 2026-10-09: licences are checked, and the repository has a disclosure path

- `bun run check:licenses` reads the installed dependency tree and fails on a licence that cannot
  ship in an AGPL-3.0 distribution — an allow-list, so a licence nobody has heard of fails rather
  than passes (243 packages today: MIT, Apache-2.0, BSD, ISC, MPL-2.0, Python-2.0, BlueOak). It is a
  workflow of its own (#247).
- Every workspace manifest now declares `AGPL-3.0-or-later`. That is what `NOTICE` grants ("version 3
  ... or any later version"); `LICENSE` is the licence text and does not choose, and a test binds
  the manifests to `NOTICE`.
- `SECURITY.md` (private reporting, supported versions, response targets one maintainer can keep) and
  `.github/CODEOWNERS`.

### Chore — 2026-10-09: CodeQL scans the code, with the least token it can have

- A `codeql` workflow analyses JavaScript and TypeScript on every pull request, on main and weekly
  (#247). The repository is private and code scanning needs Advanced Security there, so results are
  kept as an artifact and the job fails if the SARIF has any result; they upload to the Security tab
  as soon as the repository is public. `scripts/workflow-permissions.test.ts` fails a workflow whose
  top-level token grants more than read.

### Fix — 2026-10-09: the local object store is Garage, and `bun run db:up` works on a clean machine

- MinIO's images are no longer published, so `db:up` failed anywhere they were not cached (#183).
  Garage replaces it after three stores were run against the operations attachments need; two passed.
  Its image has no shell, so `scripts/storage-init.sh` creates the layout, the bucket and the
  development key, and fails if the published port does not refuse an anonymous read.
- `MINIO_PORT` and `MINIO_CONSOLE_PORT` become `STORAGE_PORT`; there is no console.

### Feature — 2026-10-09: the client generates ids against the server's clock

- A laptop whose clock is 90 seconds slow was refused by D-33's window; one 10 seconds fast would have
  pinned its messages above everyone's. The client now derives an offset from the first `PONG` and
  generates against the corrected time (#21). Until that `PONG` arrives it uses the local clock,
  and a send the server refuses surfaces as `failed` with a retry.

### Research — 2026-10-09: the image pipeline is already in the runtime

- **`Bun.Image` makes thumbnails with nothing installed**, on macOS and in a Linux container, with
  EXIF removed from every output and a decompression bomb refused by default. The spike was meant to
  choose among native libraries and found none was needed (#6, D-75).
- **`resize(width, height)` stretches.** Found with a half-red, half-blue source; a solid-colour one
  looked correct. Thumbnails use `fit: 'inside'`.
- **A truncated JPEG passes `metadata()`** and fails only when decoded, so an upload is validated by
  producing its thumbnail, not by reading its header.

### Feature — 2026-10-09: the client reconnects, and catches up from where it stopped

- A dropped socket is reopened after a jittered, capped backoff, and every reconnect resubscribes
  with the highest message id heard per channel, so the server returns only what was missed (#22).
  More than 100 watched channels are split across frames. A session that has ended is not retried.
- `parseServerFrame` in `@purlay/types`: the browser's check that what arrived is a frame the
  contract defines. A frame that is not one ends the connection rather than being guessed at.
- Not in this change, deliberately: the optimistic buffer and its ACK deadline, continuing a replay
  that was one page (`nextCursor`), and a heartbeat. Each belongs to the store above this layer.

### Research — 2026-09-09: what the frontend stack costs, before a screen exists

- **The declared stack is 69% of the declared budget with no product code**, imported eagerly.
  Split, the initial bundle returns to **43%**, leaving about 142 KB for the whole product. The
  budget is reachable — and only if splitting is a rule from the first screen, not a cleanup at the
  end. A budget check that arrives once five screens exist arrives with a violation already in it.
- **The highlighter's *engine* is the weight, not its grammars.** Shiki's JavaScript regex engine is
  53 KB gzipped lazily loaded; the WASM engine is smaller in JavaScript and **seven times larger in
  total** (36 KB + 232 KB of WASM). For a product where most messages carry no code block, that is
  the wrong trade. `ARCHITECTURE.md` §2 said grammars load lazily; the measurement says the engine
  is the sentence that matters.
- **Radix publishes no combobox.** D-52 named five primitives and four exist — found by installing
  them, not by re-reading the paragraph. The command palette is **O-7** now, with `cmdk` and a
  hand-built listbox as the two candidates and the argument for primitives applying hardest to
  exactly that component.
- The lint rule D-52 requires — *a raw value is an error* — **is available**: two plugins support
  Tailwind 4 and ESLint 10. Which one actually refuses an arbitrary value here is the spike #137
  owes before either enters the stack.

### Hardening — 2026-09-09: five places the documents and the code disagreed

A cross-check of what the documents publish against what the code does. Each finding was found by
**comparing**, not by reading — every document was individually consistent — and each now has a
check, because finding them by hand once is not a strategy.

- **`GET /api/me` was documented as Phase 0, had a response shape in the contract, and nothing
  served it.** A signed-in client had no way to learn who it was signed in as: the first thing every
  screen needs. Implemented (#176), and a check now compares the endpoints `API.md` publishes for
  this phase against the routes served, **in both directions** — it also found `POST
  /auth/logout-all` served while documented as Phase 1.
- **`/auth/logout-all` is Phase 0 now**, with the reason written down: *sign out everywhere* is the
  capability D-11 chose database-backed sessions **for**, so shipping the cost without it leaves the
  decision unpaid.
- **Five error codes could never be raised.** Four belonged to features that do not exist, and
  `SESSION_EXPIRED` was unreachable **by design** — D-60 made every session refusal the same code
  on purpose. A code a client is told to handle exhaustively and will never receive is a lie in the
  contract. Removed, and a check now requires every published code to have a call site. `413` and
  `429` left the status union for the same reason.
- **`?after=` was in the contract, validated, and silently ignored.** Worse, the socket's replay
  read the *newest* page and filtered it in JavaScript while its own comment claimed to be keyset —
  so a client away for longer than one page silently lost the **oldest** messages it missed, which
  are exactly the ones it needs. It is a range query now, and asking for older and newer at once is
  a `400` rather than a silent choice.
- **The sidebar put silent channels above active ones.** PostgreSQL sorts nulls *first* under
  `DESC`, so a channel nobody had written in outranked every one with recent activity — invisible in
  any test where no channel has messages.
- **Eight assertions demanded an empty database.** `withRollback` rolls back a test's own writes; it
  never claimed to empty anything. They passed because CI starts from nothing — and failed the
  moment the application had actually been run locally. Green in CI, red for the person building the
  product. Every query in an integration test now names what it is asking about, and a check
  refuses one that does not.

### Implementation — 2026-09-09: the socket

- **The bus, the admission and the router**, all framework-neutral, so the security gate and the
  protocol are tested against a real database without a server. What the transport adds is thin,
  and this is what it is thin around.
- **The origin is checked before the session is looked up** (D-39). `SameSite=Lax` does not
  reliably protect a handshake: another origin can open the socket and the browser may attach the
  cookie. A missing origin is refused too — a browser following the rules always sends one.
  Removing the check failed two tests.
- **One transaction, published after it commits, acknowledged after publishing** (D-35). A refused
  send publishes nothing, so nobody sees a message that was not written. The transaction boundary is
  a **dependency** rather than a call, for the reason D-46 makes every executor an argument: a
  function that opens its own transaction cannot be run inside the one the harness rolls back.
- **Subscribing is authorised per channel** — a socket cannot listen to a conversation it could not
  read over HTTP — and replays what was missed oldest-first by keyset, because ids are time-ordered.
- **The bus forgets a closed socket entirely.** A topic set that is never cleaned up grows with
  every channel anybody ever opened, and only shows up after a long uptime.
- **#174 opened for the two limits §5.5 states and nothing enforces**: the frame cap cannot be
  applied where the router sees the payload, because the framework parses JSON first — measured —
  and the rate limit is still O-4.

### Implementation — 2026-09-09: messages

- **The hot path, and all three of D-33's permanent failures.** A wrong version, a timestamp from
  the future or too far back, and a collision acknowledged as a send — each has a test, and each
  test was made to fail by removing the check it guards.
- **A collision discloses nothing.** The row it hit is read back and compared with the requester
  before anything is returned; a mismatch is `409` carrying neither the content, nor the sender, nor
  the channel. The same sender re-sending the same id in the same channel gets the **same message
  back**, which is what D-8 designed the client-generated id for.
- **Keyset, never `OFFSET`.** One row more than asked for answers *is there another page* by
  reading rather than by a second `COUNT`, and the last page says so instead of making the client
  ask again to find out.
- **The prohibition on `OFFSET` is a check now**, one of the fitness tests #130 collects, added with
  the code rather than after it. Its first version matched the *prose explaining the rule* in the
  file that obeys it — a check reporting a violation it had read in a comment. Comments are
  stripped first, and it still catches a real one.

### Implementation — 2026-09-09: what a message id is

- **The generator and the rule live together**, in the contract package, bound by a test that
  generates two hundred ids and validates every one. They are two halves of one fact — the client
  makes ids the server must accept — and separating them is how a window widens on one side only.
  Neither app may own it: `apps/web` cannot import from `apps/api`, and a copy in each is the
  duplication the rule exists to prevent.
- **A test that reads the value it is testing cannot catch a change to that value.** Widening the
  window from five seconds to sixty passed every test around it, because they all computed their
  offsets *from* the constant. Found by breaking it on purpose. The numbers are now asserted
  literally, and bound to the sentence in D-33 that decided them — changing either without the
  other fails.
- The shape check refuses a v4 id, which the contract's own `uuid` format accepts. That is the
  whole reason it exists: an id of the wrong version makes a channel's ordering wrong **forever**,
  because the value is the primary key and the pagination cursor.

### Implementation — 2026-09-09: channels

- **The four channel endpoints Phase 0 serves**, and the first place both guards meet: a channel
  named inside its workspace goes through the membership guard then the visibility guard; a channel
  named on its own derives the workspace from the resource and does both.
- **Two mandates, not one.** Every workspace-scoped endpoint carries the cross-tenant `404` (D-21)
  and every channel-scoped one carries the intra-workspace visibility `404` (D-34) — four tests,
  each also asserting the body matches the one for something that does not exist.
- **Listing narrows with the visible set** rather than filtering after the fact, which is the shape
  D-34 requires and what will confine the trigram scan when search arrives. Replacing it with a
  workspace-wide read on purpose failed the test.
- **Joining is idempotent.** A `409` on a second join makes a retry after a dropped response look
  like a failure, when the outcome asked for is already true.
- Names are unique **per workspace**, case-insensitively, among live channels only — so the same
  name in another workspace is fine, and deleting a channel frees its name.

### Implementation — 2026-09-09: channel visibility as a type

- **`ChannelContext`**, the second axis (D-34). Same mechanism as the tenant boundary: a brand keyed
  by a symbol its module does not export, so the only way to hold one is to have passed the guard,
  and asserting one is a lint error. The rule written for #12 covered it before it existed —
  matching by name rather than by a list was the reason.
- **The rule is written whole, though Phase 0 creates only public channels.** A guard correct only
  for today's case stops being one when the next arrives, and here that means showing somebody a
  conversation they were not in. The private cases are seeded directly and tested now; removing the
  membership check on purpose made a private channel visible to the whole workspace.
- **Four ways to be refused, one value.** Another workspace, private and not yours, soft-deleted,
  never existed — and a channel id that is not a UUID, which would otherwise be a `500` on the cast.
  The test compares the serialised responses and asserts there is exactly **one distinct shape**.
- **The lint rule caught the test that proves it.** Asserting a workspace context where a channel
  one was required is exactly what the ban forbids; the assertion is a `declare const` now, with no
  exemption anywhere.

### Implementation — 2026-09-09: workspaces

- **The four workspace endpoints Phase 0 serves**, each through the membership guard, each carrying
  the cross-tenant test `ARCHITECTURE.md` §10 makes mandatory — and asserting not only `404` but
  that the body is **byte-identical** to the one for a workspace that does not exist. Turning the
  guard's refusal into a `403` on purpose failed both.
- **`WORKSPACE_SLUG_TAKEN`** joins the closed error set. A slug is an address in a URL and the
  contract had no code for taking one twice; the nearest existing one was about channels.
- **Validation is this project's, not the framework's.** The framework's refusal echoes the
  submitted value and publishes the schema, so a typo comes back as a description of the server's
  own rules. The test asserts a submitted secret and the words `minLength` and `pattern` are all
  absent from the refusal.
- **I-2 is established here and guarded elsewhere**, stated rather than left implied: creation makes
  an owner and that is tested, and nothing in Phase 0 can then break it — changing a role and
  removing a member are both Phase 1. The guard belongs with the endpoints that can violate it,
  where it can be tested against something that tries.
- **`/api/*` requires a session**, in one place, with a missing and an invalid cookie producing the
  same `401`.

### Implementation — 2026-09-09: signing in with GitHub

- **The whole handshake**, driven end to end in tests against a real database with GitHub as a
  double: the redirect asking for exactly `read:user user:email`, the signed `state`, the code
  exchange, identity resolution, the session, and signing out — here and everywhere.
- **D-61** — **one public origin.** `CONFIG.md` said the callback registered with GitHub is
  `${APP_URL}/auth/github/callback` while `APP_URL` was documented as the *client's* origin and the
  API was a separate container. Every document was individually consistent and the combination did
  not work. Development is proxied so a browser sees what production shows it — which is the one
  place a topology difference is most expensive, because cookies and redirect URIs cannot be tested
  on a machine shaped differently from the deployed one. There is now no CORS at all.
- **D-62** — the `state` cookie is signed with a key **derived** from `ENCRYPTION_KEY`. Comparing
  the cookie to the query parameter is sound only while nothing else can write a cookie for this
  origin; a sibling subdomain can, and *cookie tossing* plus an attacker-chosen state signs the
  victim into the attacker's account. A second secret was rejected: the failure mode of *one more
  key* is the one nobody rotates.
- **Every collision D-38 names has a test**, including the likely one — GitHub omits the address
  from the profile for anyone who has not made one public, which is common among the developers
  this product is for. Removing the email-conflict check on purpose reproduced the silent account
  merge it exists to prevent.
- **A route group cannot be split out as a typed function.** The application's type is invariant in
  its routes, and the library's permissive alias launders `any` into every handler — 42 lint errors,
  which is the rule working. Handlers are framework-neutral now: a request in, a decision out.
- **A component test's DOM was leaking into the API's tests.** `bun test` runs every selected file
  in one process and imports files whose tests are all filtered out, so a top-level DOM
  registration fired during a run in which that file executed nothing — replacing `Request`,
  `Response` and `Headers` globally and breaking six API tests. Every file passed alone. Registering
  in `beforeAll` and unregistering in `afterAll` fixes it; adding only the `afterAll` did not,
  because the hook never ran. The reasoning behind choosing a per-file DOM over a global preload
  was right and the mechanism was not.
- **One test was silently flaky and was caught before it merged.** It tampered with the state by
  replacing the last character with `0`, which is a no-op whenever it already was `0` — a test that
  would have passed fifteen times in sixteen.

### Implementation — 2026-09-09: sessions

- **An opaque token, and only its hash in the database.** The claim is that a database dump hands
  over no live session, so the test looks for the raw token in **every column** of the row it
  created — a token that leaked into `user_agent` would pass a narrower assertion.
- **Every reason to refuse looks the same.** Expired, revoked, unknown, or owned by a deleted user
  all resolve to nothing. Otherwise an unauthenticated caller learns whether a token was ever real
  and whether an account ever existed — the 404-not-403 argument (D-21), one layer earlier. The
  deleted-user case is the one that would have been missed: a soft delete leaves the session row
  untouched, so without the join it keeps working.
- **D-60** — `last_used_at` is refreshed at most once an hour. This table is read on every request
  and every socket upgrade; writing it on every resolve turns the hottest read path into a write
  path to maintain a column whose only consumer is a device list nobody has built. Not maintaining
  it at all was also rejected: a column that never moves reads as data and is fiction.
- **The clock is a dependency**, in `platform/clock.ts` — the place the lint rule against reading
  it directly has been pointing at since it was written. It needs no exception to that rule.
- **The cookie's attributes are asserted, not trusted**, including the one that is invisible when
  wrong: the cleared cookie must match the original on everything a browser keys on, or sign-out
  stores a second cookie and the session survives.

### Specification — 2026-09-09: the stack table has to be true

- **D-59** — **the table says what is installed, and a test agrees.** D-57 stopped the next guess;
  it did nothing about the ones already in the table. A third column names the packages or compose
  services that make each row real, and every one is resolved against the manifests and
  `docker-compose.yml`.
- **The half that matters is the other direction.** `not yet` names its packages too and they must
  be **absent**, so a row cannot quietly stay behind once its thing is installed — the same drift
  pointing the other way, and the one nobody would think to look for. Proved by marking an
  installed package `not yet`, an absent one installed, and by removing the watcher from an
  `undecided` row.
- **It found one immediately.** *"A small CommonMark/GFM renderer"* and *"a sanitising serialiser"*
  are descriptions, not choices; they had no packages to name and nothing watching for the
  decision. **O-6** now, decided together in Phase 1 because the client renderer and the server
  sanitiser have to agree on what they accept.
- Generating the column was rejected: it would agree with the manifests by construction, which is
  the question being asked. The column has to be written and then contradicted by a check.

### Implementation — 2026-09-09: one command, two processes

- **`bun run dev` starts both.** It delegates to each workspace's own `dev` rather than repeating
  their commands, so there is one definition of how each application starts and the shortcuts
  (`dev:api`, `dev:web`) cannot drift from it. Bound by a test.
- Verified by running it: API `200` on `/health`, client `200`, from a single command.

### Implementation — 2026-09-09: the client boots

- **`bun run dev:web` serves and `bun run build:web` builds.** Vite, React and Tailwind at exact
  pins, wired the way the spike said Tailwind wants — its plugin and one line of CSS, no config
  file and no content array. Proved by the emitted rules, not by a class name in the markup:
  `.bg-slate-950{background-color:var(--color-slate-950)}`.
- **The measured floor: ~60 KB gzipped**, a quarter of the 250 KB budget, before a product screen
  exists. That number now sits beside the budget in `PRD.md` §5 rather than in a spike nobody
  re-reads. It is *smaller* than the spike's 82 KB because the spike installed things the client
  does not need yet — which is D-57 paying for itself.
- **The component-test DOM is registered per test file, not globally.** A `bunfig.toml` preload
  would install a DOM into every suite in the repository, including the ones where a dependency
  that feature-detects `window` would quietly take its browser path. The cost is that the global
  `screen` cannot work — `@testing-library/dom` binds it before any test file runs — so lint
  refuses that import and points at the measurement.
- **`bun x` from the wrong directory silently downloaded an unpinned Vite** and built with it. It
  succeeded, which is the problem. A check now refuses a script naming a tool its own manifest does
  not install.
- **The list of TypeScript projects is derived from the solution config**, not written down. The
  hand-written one fell behind within the hour: a tooling project was added and the check that
  compares what the compiler sees to what the linter sees reported a file nothing compiled.

### Implementation — 2026-09-09: the API is a process

- **It serves.** `bun run dev:api` starts ElysiaJS, `GET /health` answers `200`, an unknown route
  answers the error envelope rather than the framework's default, and a missing variable makes the
  process **refuse to start** — every problem at once, with secret values withheld.
- **One error handler, and three of its branches exist because a spike found the trap**
  (`docs/spikes/elysia.md`). A framework validation failure is not an `AppError`, so a handler
  branching only on `instanceof AppError` would have sent every `400` to the catch-all and told a
  client that mistyped a field the server had broken. The framework's own validation body echoes
  the request and publishes the schema; it is replaced entirely. Both were verified by removing the
  branch and watching the test fail.
- **`ROUTE_NOT_FOUND`** joins the closed error set: the contract had no code for *no such route*,
  and the nearest one would have been a lie.
- **The application returns the surface its caller uses, not the framework's type.** Annotating it
  as the bare `Elysia` does not compile — the type is invariant in its routes — and letting it
  infer puts every route's accumulated type into a committed `.d.ts`. Naming `handle` and `listen`
  answers both and keeps the framework's types out of everything above ingress.
- **No database handle is built yet**, because nothing needs one: liveness must answer while the
  database is down. It arrives with the first route that needs it.

### Specification — 2026-09-09: two claims finally run, and the rule that follows

- **D-57** — **a choice that has not been run is not a choice.** Three defects in a row had one
  shape: a branded type that could never have compiled (D-54), a task runner in the stack table
  that was never installed (D-55), a framework version named while nothing had installed the
  framework (D-56). The count, taken before fixing it: **19 stack rows, 6 ever run.** A tool now
  enters §2 on a record in `docs/spikes/` carrying the date, the versions actually resolved, the
  real output, and what had to be **loosened** — with "nothing" said out loud, because silence
  there is indistinguishable from not having looked. `CONTRIBUTING.md` §6.7 states it.
- **The two riskiest claims were run.** ElysiaJS and the whole web client stack both hold under
  this repository's strictness with **nothing loosened**. Both found things the documents did not
  know: ElysiaJS's own declarations produce 104 errors with `skipLibCheck` off, so its
  compatibility is contingent on that flag (now on D-20's risk row); the web skeleton spends a
  third of the bundle budget before a product screen exists; `happy-dom` alone cannot render a
  component; and one headless primitive costs about 28 KB.
- **D-58** — **what the client sends refuses what it did not declare.** Measured, not assumed: an
  undeclared property returns 200 and is silently dropped. Every shape a client sends is now
  closed, nested payloads included, and the set is derived from `ClientFrame` rather than listed —
  a new frame cannot escape by not being added to a list. Responses stay open on purpose.

### Specification — 2026-09-09: versions leave the documents

- **D-56** — **a version is a fact, so it lives in the manifest and nowhere else.** `ARCHITECTURE.md`
  §2 named versions beside choices. Two were bound to reality by a test; the third could not be,
  because nothing had installed the thing. The table was asserting a fact about a repository it had
  never looked at. §2 now names choices and never numbers, and `check-docs.py` — which already
  refused a version outside its owners — has stopped exempting it. It caught the paragraph
  explaining the rule, which named two versions while doing so.
- **Every dependency is pinned exactly.** The repository was mixed, with no rule written for which
  was which. A caret range is the polite form of *I do not know which version this is*; a pass from
  a differently-resolved tree is "green in one state is not green" one layer down. Checked, and the
  check was made to fail on purpose.
- The test binding the database image to a major written in §2 **lost its subject** and was
  replaced. The image tag is the fact; there is nothing left to bind it to.

### Specification — 2026-09-09: three claims the documents made and the repository did not

- **D-55** — **Bun workspaces are the build orchestration; there is no task runner.** The stack
  table listed Turborepo and accepted the cost of maintaining its configuration. Nothing was ever
  installed: no `turbo.json`, no `turbo` in any manifest. A table describing a repository that does
  not exist is worse than either choice. Resolved by deciding rather than by installing, with the
  trigger for revisiting written down instead of implied.
- **D-47 named the wrong owner.** Its text sent readers to `CONTRIBUTING.md` §5 for the required
  test matrix — the copy D-21 was amended to remove, and which §5 itself says lives in
  `ARCHITECTURE.md` §10. The reference resolved, so the consistency check passed: a section number
  can be right while the sentence around it is wrong.
- **`CONTRIBUTING.md` §5 said the same thing twice**, once as bullets and once as a paragraph under
  them. Removed rather than reconciled.

None of the three could be caught by what exists today. #156 covers the class the first one belongs
to: the table has to say which tools are installed, and a test has to agree.

### Implementation — 2026-09-09: the tenant boundary became a type

- **D-54** — a context is branded by a **module-private symbol key**, and asserting one is a lint
  error. The form `ARCHITECTURE.md` §7.3 documented — `readonly __brand: unique symbol` — is
  uninhabited: in property position it names a symbol no expression has, so not even the guard
  could have produced one, and every compile-time proof that a caller cannot forge a context would
  have passed because nobody could make one at all. The mechanism would have shipped with its
  escape hatch at the only place that must not have one.
- **`apps/api/src/platform/tenancy.ts`** — the membership guard, the sole producer of a
  `WorkspaceContext`. One refusal serves both "no such workspace" and "not your workspace", so the
  two are indistinguishable by construction rather than by two branches kept in step. A
  `:workspaceId` that is not a UUID takes the same refusal — handed to PostgreSQL it raises on the
  cast, and the boundary would have answered 500 where it promised 404.
- **The enforcement demonstration now names its rule.** It asserted only that ESLint exited
  non-zero, which any unrelated error in the violating file satisfies — a demonstration that can
  pass for the wrong reason, in the script that exists to stop exactly that. Each violation now
  declares which rule must reject it, and both failure modes were reproduced on purpose.
- **`verify` and the pipeline are compared in both directions.** The old comparison proved every
  CI step was runnable locally and said nothing about the reverse, so
  `bun run config:example -- --check` ran locally and never in CI. A check that cannot block a
  merge is a suggestion.
- **Branch names are checked** rather than named in a document nothing reads — the rule had been
  broken twice already. The prefixes are the Conventional Commit types, so a branch and its commits
  use one vocabulary (`CONTRIBUTING.md` §8).
- **`OVERVIEW.md` no longer states progress.** It said Phase 0 had not started, in a repository
  with a database, a contract and a pipeline in it. `bun run queue` computes it.

### Specification — 2026-09-09 (fourth pass): the interface, the budgets, and the escape hatch

The previous pass made seven rules fail the build and left the hatch that makes all of them
optional wide open. This pass closes that, and settles the two things the enforcement layer could
not check because nobody had decided them: what the interface is made of, and what "fast" means as
a number a build can fail on.

- **D-48** — exceptions are **expensive and visible, not closed**. Nothing stopped
  `// eslint-disable-next-line @typescript-eslint/no-explicit-any`, which made every rule optional.
  Each exception now names its rule, explains itself and links an issue; an unused one fails the
  build, so the debt cleans itself up. An outright ban was rejected: it pushes people to loosen the
  shared config instead, and a rule quietly weakened for the whole repository is far worse than one
  line marked as an exception. **The target is zero exceptions nobody can count, not zero
  exceptions.**
- **D-49** — seven performance budgets were declared CI-enforceable and **none was measured**, which
  is the exact failure D-17 exists to prevent, reproduced inside the document containing D-17. The
  two deterministic ones now block; the five that move between identical runs block on a regression
  instead. Thresholding a noisy p95 teaches a team to say "flaky, re-run it", and that habit does
  not stay confined to one check.
- **D-50** — the client stays a single-page application with a **prerendered shell**. The incumbent
  everyone finds heavy is not heavy because of how it renders; it is heavy because of how much it
  ships and how much it holds, so the answer is D-49's two numbers rather than a different
  architecture.
- **D-51** — desktop and mobile are **the same client in a shell**, and the bar is polish rather
  than platform nativeness. Recorded because the quality bar named two exemplar groups that made
  opposite decisions: none of the interface exemplars ships a native desktop application. Native
  Swift clients are **not planned** — not deferred, since that choice changes the design system and
  the contract from the first component.
- **D-52** — the frontend gets an architecture rather than only an interaction spec: **one source
  for every visual value** with a literal as a lint error, headless primitives for the five
  components where focus and ARIA fail silently, `axe` and a keyboard-path test per screen, visual
  snapshots, and a justification owed for each new primitive. `@base-ui-components/react` was the
  obvious modern choice and is **deprecated at release-candidate stage** — checked rather than
  remembered.
- **D-53** — "production-ready" is a **per-screen definition of done**, not a phase. Phase order
  decides what ships; this decides what shipping means. Each cause of an unfinished feel gets a
  mechanism instead of an intention.

### Specification — 2026-09-09 (third pass): making the rules executable

Forty-four decisions and eleven invariants, and **not one of them enforced by anything but
reading**. That is the mechanism by which a well-specified project quietly becomes an ordinary
one: the documents stay true and the code stops matching them, one reasonable exception at a time.
This pass closes that, and it is the last one before code.

- **D-45** — the Kysely types are **generated** from the applied migrations, not hand-written.
  `SCHEMA.md` §10 previously admitted to a hand-maintained copy policed by a drift test, which is
  the exact trade the ownership rule tells us not to make — and weaker than it looks, since a
  drift test only catches what someone thought to compare. Generation makes drift impossible
  rather than detectable. D-20's rejection of an ORM does not apply: code generation is build-time.
- **D-46** — integration tests run in **one transaction per test, rolled back**, with a template
  database for the cases that cannot. The consequence is architectural and is why it could not
  wait: **every service takes its executor as an argument**, so a service reaching for a
  module-level database handle is now a lint failure. Also written down: a flaky test is
  quarantined the day it appears and fixed or deleted within one working day, because a suite
  people learn to re-run has stopped being a gate.
- **D-47** — **a rule that is not mechanically enforced is not a rule.** The first code written is
  the enforcement layer, and its acceptance is a demonstration: a pull request containing `any`
  must go red. `strict: true` becomes the floor rather than the ceiling
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); lint rules become type-aware, which
  closes the likeliest defect in this architecture — a transaction whose `await` was forgotten;
  the layering rule becomes a real lint configuration; the documents' invariants become
  architecture fitness tests; `main` gets branch protection **that applies to the author of this
  entry, who pushed to it directly four times while writing these documents**; `AppError` codes
  become a discriminated union instead of free text; and request-id logging exists from the first
  handler rather than from the phase that needs it.

  Rejected in the same decision, so the effort goes where it pays: mutation testing, a global
  coverage target, DDD ceremony, pre-commit hooks as the authority, and tuning a build graph with
  nothing yet to build.

### Specification — 2026-09-09 (second pass): the product gained a cloud

The founding decision said *not a SaaS*. It now ships two ways, and that reopened everything
downstream of it. Three decisions were **rewritten** rather than amended, because patching a
decision whose premise changed leaves the old reasoning in place for the next reader to trust.

**Rewritten**
- **D-1** — self-hosted open source *and* a cloud we operate. Four audiences; the dogfood team
  still holds the only veto. **No open core**: the cloud runs the same code and sells operation,
  never withheld capability. The original decision's own warning — that paying customers would
  push roughly 40% of the engineering budget into non-product work — is now accepted rather than
  avoided, and phased so it cannot arrive before there is a product worth charging for. The size
  of the business is written down as a constraint: a small operation funded by its users, not a
  growth-stage SaaS.
- **D-24** — **MIT → AGPL-3.0, plus a CLA.** The original reasoning hinged word-for-word on
  *"D-1 explicitly gave up commercial ambition"*, which is no longer true. It also contained an
  error worth naming: it rejected AGPL because companies ban AGPL dependencies, which is a cost
  that applies to **libraries linked into a product**, not to an application a company runs
  internally. The CLA matters now rather than later — the ability to relicense or dual-licence
  ends at the first merged outside pull request, and `README.md` still says contributions open in
  Phase 2. `LICENSE` replaced; `NOTICE` added.
- **D-28** — for the cloud **we are the data processor**, so the DPA the previous decision
  refused to publish is now genuinely required, along with a real subprocessor list and breach
  notification. For self-hosters nothing changes: the operator is the controller and we are not a
  party at all. Two postures, stated separately, because one document covering both would be
  wrong in both directions.

**Amended** — D-7 (the shared broker is required by the cloud and *never* by a self-hoster),
D-20 (PostgreSQL 16 → **18**, versions pinned to current stable, ElysiaJS named as the highest-risk
choice now that uptime is a commitment, with Hono as a written fallback and a four-week trigger),
D-25 (multi-node is an obligation for one deployment and a measurement for the other), D-27
(retention is set by the operator when they own the disk, and by the plan when we do), D-31
(SSO has a paying demander now), D-10 (a vestigial line about text search configuration removed).

**Added**
- **D-39** browser and transport security. The gap that mattered: **no `Origin` validation on the
  WebSocket upgrade**, which is cross-site WebSocket hijacking, and it is built in Phase 0.
  Also: attachments served defensively, the one-line "external images proxied" turned into a
  hardened fetcher rather than an SSRF endpoint, a CSP baseline, and AES-256-GCM named for a key
  the configuration had already required.
- **D-40** deterministic collation. `lower('İ')` is not `i` under a Turkish locale, so channel-name
  uniqueness depended on how the server was provisioned. Identifier columns now declare
  `COLLATE "C"`, `citext` is dropped for the same reason, and `/health/ready` asserts it.
- **D-41** English and Turkish from the first screen, built on `Intl` and typed catalogues with no
  i18n library — a missing key is a compile error, and the 250 KB budget survives.
- **D-42** the cloud stays shared-database multi-tenant. The accepted cost is the largest in the
  document: an isolation bug reaches every customer at once, which is exactly why D-21 and D-34
  are enforced by types rather than by review.
- **D-43** per-**workspace** pricing, never per seat — charging by seat would contradict the cost
  axis the product competes on and the first paragraph of the README. Sold through a merchant of
  record, with a numeric trigger for moving to direct payments.
- **D-44** backups with a *tested* restore, error tracking, uptime monitoring, a status page, and
  `pino` named at last for the structured logging §10 had always mandated. No telemetry is ever
  collected from a self-hosted deployment.

**Scope** — a new phase, **2.5 / `v0.4.0` — Cloud**, gated on S-3 and blocked until S-1 is met.
`PRD.md` gains a fourth success criterion and a second primary persona; §6 keeps *per-seat
billing* on the permanent non-goal list and adds *open core* to it, while billing itself leaves.

### Specification — 2026-09-09

A capacity, compliance and operations pass. Four questions that the specification had never been
asked were answered, and answering them exposed one internal contradiction that had to be fixed
rather than worked around.

**Added — `DECISIONS.md` D-25 – D-32**
- **D-25** capacity: a numeric build target (300 sockets, 20 msg/s) and a multi-node ceiling
  (1 000+), with the three triggers that open Phase 3. D-7's rule finally has a measurement to
  point at. Two new seams follow — `PresenceRegistry` and `RateLimiter` — because they are the
  only node-local state whose *correctness* changes on a second node.
- **D-26** an append-only `audit_log` for administrative actions. Never message content.
- **D-27** retention, erasure and export — **closes O-3**. Retention is opt-in per workspace and
  defaults to infinite, so the "nothing is thrown away" tenet is unchanged. Account erasure and
  content erasure are two deliberately separate operations.
- **D-28** the project is not a data processor and will not publish a DPA. Ships the operator's
  data map and runbooks instead.
- **D-29** notifications now include **thread participation** — revises D-12. Without it, the
  person who asked the question never learns it was answered, which is the product's own thesis.
- **D-30** background work is CLI commands under an external scheduler; `job_runs` exists so a
  cron nobody installed is visible rather than silent.
- **D-31** SSO leaves the permanent non-goal list for Phase 3 (OIDC, gated on demand). SAML
  stays permanently refused.
- **D-32** work is tracked in GitHub Issues and Projects. Linear rejected: per-seat closed SaaS,
  which is the model D-1 exists to reject.

**Fixed — a contradiction, not a wording change**
- `PRD.md` §6 and D-1 both listed SSO/SAML as permanent while D-25 and D-26 described an
  organisation that has an identity provider. A non-goal contradicted by another decision teaches
  readers the whole list is negotiable, so it was resolved rather than softened.
- `SCHEMA.md` shipped `notification_type` values `thread_reply` and `thread_resolved` that D-12
  forbade. Resolved in favour of the enum, by D-29.

**Added — `DECISIONS.md` D-33 – D-36, closing the gaps a pre-implementation review found**
- **D-33** the client-supplied `messages.id` is validated at the boundary — v7 shape and a
  timestamp within `[now − 60s, now + 5s]` — and `ON CONFLICT` no longer returns an ACK without
  verifying the existing row belongs to the same sender and channel. D-8 made the id
  client-generated and never said what happens when the client sends something else; a poisoned
  id is a primary key and cannot be repaired. Clock skew is corrected from `ServerFrame.ts`,
  a field that was already defined for it and never used.
- **D-34** channel visibility becomes a second branded context. `WorkspaceContext` made the
  tenant axis structural; the channel axis was left to call sites, and two specified endpoints
  leaked because of it — search, and the open-questions view, which as written listed every
  member's private discussions. A third mandatory test class follows.
- **D-35** the message write path is one transaction, and the `EventBus` publish happens **after**
  the commit. Publishing first lets a subscriber receive a message that then rolls back, and with
  a durable client-generated id that client cannot learn to forget it.
- **D-36** markdown stays the only stored representation and §8.1's rationale is corrected: it
  claimed to save client render cost, which it never did. The content-pipeline dependencies §8
  was built on are now named in `ARCHITECTURE.md` §2 with their costs.

**Added — `DECISIONS.md` D-37, D-38, closing the last two gaps that blocked Phase 0**
- **D-37** `WORKSPACE_OPEN_JOIN_SLUG`. Phase 0's exit criterion requires two GitHub users in one
  workspace, and no Phase 0 endpoint could put them there — invitations are Phase 1 and joining a
  channel already requires membership. The phase had been defined with an exit criterion its own
  scope could not reach.
- **D-38** GitHub identity, with every collision given a defined answer: the requested scopes
  (`read:user user:email`) were written down for the first time; the email is the primary
  **verified** address or sign-in is refused, because the default `/user` response omits it for
  any developer who has not made it public and `users.email` is `NOT NULL`; a known address
  arriving under a different `github_id` is refused rather than silently linked (D-5); a username
  freed by a GitHub rename and taken by somebody else no longer collides fatally. It also closes
  an interaction neither D-22 nor D-27 covered — erasure now clears `github_id`, so signing in
  again creates a new account instead of resurrecting the one the person asked to have removed.
  Invariant I-11 extended.

**Fixed — found by a machine audit of every cross-document reference**
- `UX.md` §5 pointed at `PRD.md` §4.2 (*Threads*) for a statement about GFM in the composer,
  which belongs to §4.1 (*Messaging*). The section number was valid, so no link check would ever
  have caught it — only resolving each reference to its target's **title** did.
- `PRD.md` §4 carried a `4.6b` subsection. Renumbered to 4.7 and 4.8; nothing referenced §4.7,
  so the renumbering was free.

**Repository — work tracking moved to GitHub**
- **`docs/ROADMAP.md` retired.** Its task list now lives as GitHub Issues, one per task, and
  keeping both would have been exactly the duplication `OVERVIEW.md`'s ownership rule forbids.
  Its two unique facts moved rather than vanished: the working rule went to `CONTRIBUTING.md` §7,
  and the "never" list was already only a pointer to `PRD.md` §6. Eleven references updated in
  the same change.
- Milestones are versions, not phase names: `v0.1.0`, `v0.2.0`, `v0.3.0`, `v1.0.0`. The phase each
  one corresponds to, and its exit criterion, live in the milestone description; `PRD.md` §4
  remains the owner of what a phase contains.
- Issue templates for epic, feature, task and bug, plus a pull request template, each carrying the
  definition of done in two tiers — what always applies, and what applies conditionally. A
  checklist whose items do not all apply is a checklist people learn to tick without reading,
  which is the same failure D-17 was written to prevent.

**Repository**
- The contributor rules moved from an agent-specific filename to **`CONTRIBUTING.md`**, which is
  what an open-source repository is read for anyway. Content and section numbering are unchanged,
  so every `§` reference in the other documents still resolves. Agent entry points, vendored
  skills and their manifest are untracked.
- Five `.gitignore` patterns carried inline comments. Git does not support them: the trailing
  text became part of the pattern, so the agent-tooling directory was never ignored and
  `!.env.example` never took effect — which would have silently prevented Phase 0 from committing the file `CONFIG.md`
  requires.

**Schema**
- `workspaces.retention_days` (NULL = infinite, floor of 30 days), `audit_log`, `job_runs`
- New `SCHEMA.md` §9; Kysely types, invariants I-9 – I-11, migration `0009_administration.sql`.
  The unapplied Phase 2 migrations shifted to `0010`/`0011` — legal only because neither had run.
- Sections renumbered (Kysely §10, Invariants §11, Migrations §12) and every cross-reference in
  `ARCHITECTURE.md`, `CONTRIBUTING.md`, `UX.md` and `ROADMAP.md` updated in the same change.

---

### Specification — 2026-09-07

The four original drafts were solution specifications with no problem specification behind
them, and they contradicted each other in ways that would have failed at the first `INSERT`.
Reviewed, decided, and rewritten.

**Added**
- `DECISIONS.md` — 23 decisions, each with its rejected alternatives and reversal cost
- `ROADMAP.md` — phase-by-phase execution plan with exit criteria
- `PRD.md` now has a persona, a problem statement, success criteria and a competitor position
- Schema: `sessions`, `attachments`, `mentions`, `notifications`, `link_previews` — all five
  were promised by the PRD and absent from the schema
- `ARCHITECTURE.md`: `EventBus` seam, `WorkspaceContext` branded type, reconnect/replay
  protocol, error and observability rules

**Changed**
- `messages.id` → application-generated **UUIDv7**; pagination is keyset on `id` alone (D-8)
- Message ordering no longer depends on `created_at`, which was unstable within a millisecond
- Direct messages are workspace-scoped; cross-workspace DM removed (D-6)
- `parent_id` → `ON DELETE RESTRICT`, so soft deletion no longer destroys threads (D-9)
- Channel name uniqueness → partial index over named channels only; DMs keyed by `dm_key` (D-6)
- Workspace ownership → `workspace_members.role`; `owner_id` removed (D-22)
- `users.github_id` → nullable (D-11)
- `message_type` → `{text, system_event}`; a code block is not a row type
- Text search config → `simple`; the English `tsvector` column and index dropped (D-10)
- Unfurl cache → PostgreSQL `link_previews`, with negative caching (D-23)
- Performance targets → seven measurable budgets (D-17)
- Web Worker usage → measurement-driven, no longer a blanket rule

**Added in the audit pass** — five documents the specification referenced but did not have:
`README.md` (named directly by success criterion S-2), `docs/UX.md` (the wedge is a behaviour and
had three sentences), `docs/API.md` (the HTTP contract existed only as scattered mentions),
`docs/CONFIG.md` (the config loader was required to validate variables nobody had listed), and
`LICENSE` — the project called itself open source in three places while granting no rights at
all (D-24, MIT).

**Documentation hygiene** — after an audit pass, six facts that had been stated in two or three
files each were given a single owner, with the other locations reduced to pointers:
phase contents and non-goals → `PRD.md` · performance budgets → `PRD.md` §5 ·
stack and accepted costs → `ARCHITECTURE.md` §2 · required tests → `ARCHITECTURE.md` §10 ·
open questions → `DECISIONS.md` Part D · attachment size limit → the `attachment_size_limit`
constraint. An ownership table now lives in `OVERVIEW.md`.

Also fixed: `ARCHITECTURE.md` stated a WebSocket rate limit as settled while `O-4` recorded it
as an open question — it is now marked provisional in both places.

**Removed**
- Redis from Phases 0–2 — a single node needs no broker (D-7)
- Tauri from Phase 1 — moved to Phase 3 (D-14)
- Magic-link auth and GitHub webhook feeds from the MVP — moved to Phase 2 (D-5)
- Personal scratchpad — a self-DM does the same job with no new schema (D-5)
- The `<35MB idle memory` requirement — unachievable as stated (D-14)
- The "sub-millisecond search" claim — unachievable and unmeasurable as stated (D-10)
- The "local-first" claim — Zustand is in-memory; the accurate word is *optimistic* (D-19)
