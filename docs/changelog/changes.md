# Purlay — Changelog

Notable changes, newest first. Releases get their own file: `docs/changelog/v{x.y.z}.md`.

---

## Unreleased

### Polish — 2026-10-19: the first two screens a person sees

**Sign in** carries GitHub's mark on its button (the icon set dropped brand marks, so the mark is a
glyph of our own), the button is the touch height, and the lines below the title break evenly instead
of leaving one word alone. **Welcome** — the channels to start in — is a centred column with the
workspace's tile, the channels as rows of one card (picked ones tinted, the busiest marked *Active*,
the topic under the name), and Skip and Join in the card's foot; the button reads *Join* rather than
*Join 0 channels* while nothing is picked. Somebody already in every public channel is told so, rather
than that there are none.

### Feature — 2026-10-19: Settings is a page, and the menus are short again (D-146, D-151)

The workspace menu had grown to nine items, each opening a 480px dialog, and the account menu to sixteen
rows — the owner, looking at the running product, called them cramped and the screens undesigned. Settings
is now a page, `/w/<slug>/settings/<section>`, with its own navigation in the sidebar's place: **Account**
(Profile, Preferences, Notifications, Keyboard shortcuts, Sessions & account) and, for an owner or an
admin, the workspace's pages (General, Members, Invitations, Integrations, Audit log, Data & retention).
Every page has one shape — a title, a sentence, cards of labelled rows — on a ground a step below the
cards, in both themes and down to a phone. Members is a table with counts, a search, a role filter and
what each role can do; the audit log names who acted with their avatar; history windows read "Forever",
"1 year", "5 years". Notifications says plainly what reaches a closed tab on this server, and lists every
channel's level in one place. The account menu keeps Deep Work, Settings (`Cmd/Ctrl+,`), shortcuts and
Sign out; the workspace menu keeps the workspaces, Create, Invite people and Workspace settings; the rail
has a gear; the palette finds every page by name. The pages load as a chunk of their own. Controls —
buttons, fields, selects — are 32px tall instead of 28px, and menus are as wide as the sidebar. Turkish
role names are Sahip and Yönetici, no longer "Owner" and "Admin".
### Feature — 2026-10-19: anybody may leave a workspace (D-152)

There was no way to leave a workspace short of asking an admin to remove you. `DELETE
/api/workspaces/:id/membership` takes the caller out of the workspace and its channels, tells their own
devices, and records `member.left`; the last owner is refused with `LAST_OWNER` until somebody else is an
owner. An invitation that was open before somebody left still lets them back.
### Fix — 2026-10-19: an answer in a thread is read in the thread, not by scrolling the feed past it (D-147)

Reading a channel to its newest message marked read every notification at or behind the position,
replies included: an answer somebody gave in a thread the person never opened went from unread to read
— its badge, the tab title's count and the inbox's unread state with it — as soon as anything newer was
said in the feed. The read position now reads the roots only. A reply's notification waits for its
thread, which the panel reads while it is open in front of the person (`PUT
/api/messages/:messageId/thread/read`, up to the newest reply it has), or for the inbox; until then it
counts as unread, so the badge stays within the unread count (I-6) without vanishing.
### Fix — 2026-10-19: messaging polish

Defects found by a visual audit of the messaging screens, at 1440 and 390 wide in both themes.

- **Channel details no longer opens on its name with the text selected.** Radix selected the first
  field's text, so the first key typed renamed the channel. The dialog takes the first focus itself
  (`Dialog`'s `focusFirst="dialog"`), and no dialog opens with a field's text selected: a first field
  that already holds text gets the caret at its end.
- **Browse channels and New channel are always shown** beside the Channels heading, in the navigation's
  quiet tone with their tooltips; they were invisible until the heading was hovered. New message beside
  Conversations takes the same tone and alignment (it was drawn in the content's tone on the navy).
- **A long channel name no longer runs under the header's controls on a phone.** The name could not
  shrink, so it overflowed its box; it is now cut with an ellipsis, and the topic gives way first.
- **The header's open-questions count is the channel's own**, not the workspace's, and opens the view
  narrowed to the channel (`?in=`, with *Show every channel*). A direct message or a group shows the
  control only while it has open questions.
- **A person is named by their display name everywhere they are named in words**: a direct message's
  header, the inbox, search (its rows and the choice of where to look), the open questions, *Resolved
  by …*, an add that failed, and a row's name for a screen reader. They said the handle while the feed
  and the sidebar said the name. The handle stays where it is the point: a mention and the profile.
- **The thread line under your own message is mirrored**: its status ends where your bubble ends,
  instead of sitting at the feed's far left.
- **A long line of code shows that it goes on.** A code block, a diff and a table scroll under a thin
  scrollbar in the theme's tones that is always drawn (macOS hid it until scrolled), and a code block's
  header has **Wrap lines**, a toggle that wraps the view without changing what Copy copies.
- **Add people says who is already in the channel.** Its members are listed after the people who can be
  added, each saying *Member* instead of offering an Add that did nothing.
### Fix — 2026-10-19: an open inbox shows "your question was resolved" without a reload

The client asked an open inbox again only when a channel's mention count rose, and a resolution moves no
counter (D-99 §1), nor does a mention in a public channel the person is not in — so either appeared only
after a reload. Every write that creates a notification now tells its person `NOTIFICATIONS_UPDATED` on
their own topic after the commit (a send, an edit naming somebody new, a resolution), and the client reads
that workspace's inbox again — once more after a read already on its way, however many arrive. The
counters no longer ask as well, and a reconnect reads the inbox again, since the frame went to a socket
that was down (D-106, amended).

### Fix — 2026-10-19: the rail's inbox dot is quiet in Deep Work, as the badges are

The dot on the rail's Inbox is the same fact as the mention badges (`UX.md` §2), and in Deep Work the
badges and the tab's count draw nothing (D-15) — but the dot never asked whether Deep Work was on, so it
stayed lit through it. It now reads Deep Work as the badges do; the inbox itself still lists everything.

### Fix — 2026-10-19: the production stack passes the Web Push and sign-in mail settings to the API

`docker-compose.production.yml` named every variable it hands the API, and `VAPID_*`, `SMTP_URL`,
`MAIL_FROM` and `SMTP_ALLOW_PLAINTEXT` were not among them. `--env-file` only fills the file's
placeholders, so keys set in `production.env` never reached the container: `/api/push/key` answered
`{"publicKey":null}` and email sign-in stayed off, without a word. They are now passed to the API and the
scheduler, empty meaning off as before, and `docker/production.env.example` lists them with how to make
a key pair. The test that holds the stack now fails on any variable the API reads (`.env.example`) that
the stack neither passes nor names with the reason it is withheld.

### Fix — 2026-10-15: an object store that is down is 503 STORAGE_UNAVAILABLE, not 500 (closes #708)

With the bucket configured and Garage stopped, an upload and a download answered `500 INTERNAL` and the
log wrote `request failed` at error with the store's stack — an outage read as a bug, and "Something went
wrong on our side" to the person. The S3 adapter now says a store that refuses or drops the connection,
times out, or answers that it cannot serve now as `503 STORAGE_UNAVAILABLE` on every operation, as the
database's outage is `DATABASE_UNAVAILABLE`; an absent key is still nothing, and any other failure still
escapes. Live: down → 503 in 20 ms, back → 201 and 200 at once.

### Fix — 2026-10-15: the silent-collector spec counts what the reporter sends, not what a loaded server got to (closes #632)

`error-tracking.bounded.test.ts` waited for requests to *arrive* at a loopback server that never
answers, while the reporter aborts each after 150 ms. In one process under load the server's handler
could run after the abort, so a request that was sent never arrived and the spec gave up waiting —
reproduced 1 run in 48 beside CPU load. It now counts the requests the reporter makes through the real
`fetch` adapter: what the reporter did, which is what it tests. 48 runs in 48 green under the same load.
With #646, #699 and #706, every failure recorded on #632 has its cause found and fixed.

### Fix — 2026-10-15: a socket whose session ends as it opens is always told why (part of #632)

The hub tells every socket whose session ended why before closing it (#194, #577) — except when the
sign-out landed between admission letting the socket in and the hub's first read of the session. Then
it took the socket for one that never had a session and closed it with the code alone. Seen once in a
full run under load (`revocation.integration.test.ts`: a 4401 close, no frame) and reproduced on demand
by ending the session before the hub reads it. A socket that carries a session cookie had a session —
admission let it in only with a live one — and is told.

### Fix — 2026-10-15: a search result found across I, ı, İ and i is marked (closes #704)

Since #701 the server finds "ÇAĞRI" for `çağrı` and "İstanbul" for `istanbul`, but a row's excerpt
marked its match with a case-insensitive regular expression whose folding does not pair İ with i nor I
with ı, so such a result showed from its start with nothing marked. Each of the four now matches any of
them there too, as the server folds them.

### Fix — 2026-10-15: the command palette finds "Doğancan" from "dogancan" (closes #702)

The palette compared names with `toLowerCase` alone, so a name with Turkish letters was not found
typed without them — `dogancan`, `kilic`, `cagri` found nobody — while the `@` list, which folds case,
marks and the dotless `ı`, found the same people. The palette now compares through the same `fold`, and
still marks the letters of the name as written.

### Fix — 2026-10-15: search ignores case in every language, and I ı İ i are one letter (closes #700)

The database is C, under which `ILIKE` folds ASCII letters only: "çağrı" did not find "ÇAĞRI",
"istanbul" did not find "İstanbul", "ärger" did not find "ÄRGER". Search now compares
`purlay_fold(content)` with the folded words — ICU's root lowering, then Turkish's four i's as one —
on a trigram index built on the same expression (migration `0043`, replacing `idx_messages_search`), so
the scan stays inside the workspace (D-10). `%`, `_` and `\` are still what was typed.

### Fix — 2026-10-15: the channel-list error spec no longer fails when another spec moves bob (part of #632)

`states.e2e.ts` *the channel list … offers Retry, and recovers* failed in three of four full browser runs
on a loaded machine (light-narrow): a parallel spec put bob — the spec's person — in a room, the frame
for it read his channel list again on its own, the front door moved him there and the overlay closed
over **Retry**. Reproduced on demand by adding bob to a room before the click. The spec now runs its page
without a socket: the list's failure and recovery are what it tests.

### Fix — 2026-10-15: moving to a channel leaves focus in its composer on a wide window (closes #697)

After **Cmd+K → a channel**, or a click in the sidebar, focus was on the page's `<main>` and the
composer was more than sixty Tab presses away — what a keyboard-first person typed next went nowhere,
and an empty channel broke `UX.md` §8 (*"No messages yet" + composer focused*). The composer focused
itself as it appeared, and the frame then took focus back for `<main>`. On a wide window a field the new
page focused inside `<main>` now keeps it; elsewhere, and on a narrow window — where a focused field
opens the on-screen keyboard over the page — `<main>` still takes it.

### Fix — 2026-10-15: a session that ends in an open tab says so on the sign-in screen (closes #693)

The sign-in screen had a sentence for a session that ended — *Your session ended* — reached by
`?reason=ended`, but nothing in the client sent it: a page whose session was revoked (signed out
everywhere from another device, expired) landed on the plain card. A page that held a session and is
then refused now goes to `/sign-in?reason=ended`; a first visit with no session, and a person who signed
out themselves, still land on the plain screen. `account.e2e.ts` holds the real path.

### Security — 2026-10-15: the next person signed in on a browser no longer finds the last one's draft (closes #694)

A draft was kept in the browser by channel and thread alone, and forgotten only when this page signed
out. A session that ended any other way — **Sign out everywhere** on another device, expiry,
revocation — left it, and whoever signed in next on the same browser found it in the composer, ready to
send as theirs (reproduced live). An independent review then found the same words written back *after*
an ordinary sign-out, by the composer's last write as the screen closed. Now:

- a draft's key carries its person (`purlay.draft.<user>.<channel>[.<thread>]`), as unsent messages'
  already did;
- the page records whose its personal keys are, and the moment it learns who is signed in — before a
  composer reads a draft — anybody else, or nobody recorded, makes it forget them first; the same
  person keeps theirs; a forget that does not finish leaves the record, so the next claim tries again;
- the composer writes a draft only while the page is still its person's, so nothing lands after a
  sign-out or after somebody else signed in in another tab — whose arrival also empties the page's
  cache.

Drafts written before this release are forgotten once, on the first load after it: nothing recorded
whose they were.

### Feature — 2026-10-15: the audit log says which channel a repository was connected to (closes #691)

`integration.feed_created` and `integration.feed_removed` now record the channel's id beside the
repository, and **Audit log…** names it — *connected acme/api to #deploys* — from the channels the
viewer can see, so a private channel they are not in is still "a channel". Entries written before keep
their words.

### Fix — 2026-10-15: an open question reads in full lines on a phone (closes #688)

The "2 replies · 14:49" pill was a column of its own beside each question, which at 390 px left the
question two or three words a line. It is on the author's line now — where a wide window drew it
anyway — and the question has the row's width; `apps/web/e2e/narrow.e2e.ts` measures it.

### Fix — 2026-10-15: an offline send says it will go on its own (closes #685)

A send written while the network was gone said "Failed to send · Check your connection and try again"
after its three seconds, under a bar promising messages will send when the connection is back — and
the engine does send it on the reconnect. Such a row now says it goes on its own when you are back
online (in both languages), still with Retry and Delete; a timeout or a server's refusal keeps its
sentence. The reasons the engine resends and the reasons the row describes this way are one constant,
`UNREACHED` in `data/failure.ts`.

### Fix — 2026-10-15: a missing setting is named once (closes #683)

The API and every command that loads the configuration listed each missing variable twice — "Expected
required property" and then "Expected string" — because TypeBox reports every rule a path breaks. Each
variable is now named once, with the first reason, so the list an operator reads in the logs is the
list of things to set.

### Fix — 2026-10-15: Saved's tabs no longer cover its title on a phone (closes #681)

At 390 px the three tabs were drawn over the `h1` ("Save" under "In progress"). On a phone the header
now wraps and the tabs take a row of their own, each a finger tall. `apps/web/e2e/narrow.e2e.ts` checks
every screen with a header of its own — Saved, the inbox, the open questions, search — for a title
covered, cut or run out of its header.

### Fix — 2026-10-15: an inbox row's first line stays one line on a phone (closes #679)

At 390 px the line naming why a notification is there wrapped: `4m` and `ago` on two lines, `thread`
on its own. It is one line now — the reason and the channel truncate, the time never breaks — and
`apps/web/e2e/narrow.e2e.ts` measures it in both themes.

### Fix — 2026-10-15: a backup no longer skips the attachments by chance; the restore rehearsal runs again (closes #677)

`has_api` in `scripts/ops-common.sh` piped `docker compose config --services` into `grep -q` under
`pipefail`: grep left at the first match, compose died of SIGPIPE when it still had services to list,
and the pipeline failed though `api` was there — two runs in five once the stack had six services.
`backup.sh` then said the stack had no API, **left out the bucket and exited 0**; `restore.sh` could
miss a running API before replacing the live database. Every script now reads grep's input to the end
(`grep … >/dev/null`), and `scripts/shell-scripts.test.ts` refuses a pipe into `grep -q`. The
rehearsal, broken since D-144, now writes `GARAGE_ADMIN_TOKEN`, lets `storage-init` prepare the store,
checks a backup holds the bucket, and passes end to end; `backup.sh`'s hint names `storage-init`.

### Fix — 2026-10-15: the licence check judges what the lockfile resolves (closes #675)

- `bun install --frozen-lockfile` does not prune `node_modules/.bun`, and the check read every manifest
  there: a long-lived checkout failed on a font nothing depended on any more. It now judges the installed
  packages the lockfile names at that version, and the workspace's own; a fresh install loses none.

### Fix — 2026-10-15: `db:check` reads only the application's schema (closes #673)

- The migrator's integration test makes a schema per case and drops them when it ends; a run killed
  first left them behind, and `db:generate` wrote their tables into `schema.ts`, so `db:check` failed on
  types that were right. The types are now generated from `public` alone; `db:check` passes with such
  schemas still in the database.

### Fix — 2026-10-15: an edit naming several people no longer deadlocks with a send (closes #669)

- Found by a chaos soak — four people doing everything at once in one channel, one `500` in 3,098
  requests: an edit that newly names people counted them with `user_id in (…)`, which on a small table
  the planner reads in the rows' physical order, beside a send locking the same rows in `user_id` order.
  The edit now locks the people it names in that order first, and counts exactly those. A test turns the
  index scans off so the order no longer depends on the plan: before, a deadlock in each of three runs.

### Fix — 2026-10-15: leaving a channel no longer deadlocks with a message being sent in it (part of #669)

- A leave took the channel's row and then its membership; a send holds the memberships it counts and
  then takes the channel's row. Side by side they could each wait for the other, and one failed with a
  deadlock. A leave now takes its membership first. Shown by a test that sets the interleaving up with a
  third transaction holding the channel row: before, a deadlock in each of three runs; after, none.

### Fix — 2026-10-15: concurrent sends into one channel no longer deadlock (closes #668)

- Several people writing into one channel at once could each hold a member's counter row the other
  needed; PostgreSQL ended one send as a deadlock and its sender got `500` (measured: 13 of 418 sends
  from four writers). A multi-row update locks rows in the order its snapshot reaches them; the arrival
  counter now locks the members' rows first, by `user_id` — the order a delete already takes them in.
  Twenty-five sends from each of five people at once now all succeed, and a mutation removing the lock
  is caught.

### Security — 2026-10-15: the proxy no longer replays a request the API received and died on (closes #666)

- With `lb_try_duration` (#645), Caddy's default also retried a GET whose exchange failed after it was
  sent — measured: one GET to an upstream that accepts and drops it was sent **119 times** in 30 s. The
  OAuth callback is such a GET, spending a one-time code. The proxy now retries only a request that never
  reached the API (`lb_retry_match` matches nothing); measured since: once. A request that arrives while
  the API restarts is still held until it is back.

### Feature — 2026-10-15: a search result shows where its words were found (closes #664)

- Each result marks the words searched for, and a long message's excerpt starts a little before the
  first of them, at a word, with an ellipsis — so a match past the first two lines is seen without
  opening the message. Matched as the server matches (D-105 §1), on the excerpt a reader sees (#651).

### Fix — 2026-10-15: an empty conversation no longer asks what the channel is for (closes #662)

- A conversation nobody had written in yet showed a channel's invitation — "Say what it is for in the
  first message". It now says that only the people in the conversation see what is written there, in
  both languages, for a conversation with one person, a group, or yourself.

### Infra — 2026-10-15: every production container is bounded, and Garage writes to the disk before it says yes (closes #639)

- Each service in `docker-compose.production.yml` has a memory and a process bound, several times what
  it was measured to use (`docs/spikes/resources.md`): a runaway takes its own container down and is
  restarted, not the host. Each memory bound is a variable for a larger server; CPU is not bounded.
- Garage's production configuration sets `metadata_fsync` and `data_fsync`: without them a power cut can
  lose files the API was told were stored. Measured cost: 2.5 ms at the 95th percentile of a 256 KiB
  write, the median unchanged.

### Fix — 2026-10-15: a message's hover controls no longer cover it (closes #653)

- The controls hung over the first line of every message — on your own short one they hid its words —
  and stayed over the edit box while a message was edited. They now stand above the first line (on a
  wide window clear of the row above too; on a narrow one, where they are a finger tall, over that row's
  corner rather than their own words), and are not drawn while editing. Measured in a browser.

### Testing — 2026-10-15: the screenshots three changes left stale (closes #658)

- The gallery (four new glyphs, #649) and, on a narrow window, the conversation screenshots (the header's
  Open questions as a glyph, #629; no composer hints, #656) are updated. The full browser suite passes in
  all four projects.

### Fix — 2026-10-15: a send that cannot reach the server is failed after its three seconds, not at once (closes #655)

- Since #640 an offline send goes to the HTTP door, which fails at once, and the row said "Failed to
  send" at once while the bar promised it would send. Wanting a server is now `sending` until the send's
  three seconds are out (UX §3.1), and a reconnect inside them sends it without a word; after them it
  is failed, and still resent on the reconnect. A server's refusal is still said at once.

### Fix — 2026-10-15: focusing the composer on a narrow window no longer moves the page (closes #654)

- #643 gave the composer's hints a row of their own on a narrow window, so focusing the composer made it
  taller. Pressing the "new messages" pill took focus from the composer, the composer shrank, the pill
  moved between the press and the release, and the click missed it. On a narrow window the hints are no
  longer drawn — a phone's keyboard has no Shift+Enter — and are still the field's description for a
  screen reader. `narrow.e2e.ts` measures that the feed is as tall with the composer focused as not.

### Fix — 2026-10-15: a list shows a message as it reads, not as it was typed (closes #651)

- Search results, the inbox, saved messages, the pins and the open questions drew a message's markdown
  as typed — ``Deployed `api` `06f1700` `` with its backticks, a fence with its three. Their one-line
  excerpt is now the text a reader sees, from the same parsed tree the feed draws (`excerptOf` in
  `@purlay/markdown`): a code span by its contents, a link by its label, emphasis without its marks.
  Past the parser's bounds a message is shown as typed, as the feed shows it.

### Fix — 2026-10-15: a scheduled job that stops working is seen (closes #635)

- The `scheduler` container's healthcheck is now `jobs:status`: a job overdue, or failing since it last
  succeeded, shows the container unhealthy in `docker ps` and to anything that watches container
  health. It was disabled, and the status was a command nobody ran.
- The scheduler and each job report what they log at `error` to the error tracker, like the API, through
  one `errorTrackingFor` the three share.

### Fix — 2026-10-15: each place in the workspace menu has a glyph of its own (closes #642)

- Audit log was drawn with the keyboard of Keyboard shortcuts, and Members, Workspace settings and Keep
  history shared one cog. They are now people, a log, the cog and history; Export is a download. A test
  holds that no two places in the menu share a glyph.

### Security — 2026-10-15: the page sends a Permissions-Policy (D-102 amended, closes #638)

- Camera, microphone, geolocation, payment, USB, serial, HID, MIDI, display capture and the Topics
  API are off for anything that ever runs in the page; the clipboard (Copy code) and fullscreen stay
  the origin's own. A browser test fails if Chromium rejects an entry or Copy code stops reaching
  the clipboard.

### Docs — 2026-10-15: the backup runbook keeps clear of the nightly purge, leaves the host, and says when it fails (closes #637)

- The documented backup started at 02:30 host time, the minute the retention purge starts in UTC; it now
  starts at 01:00 and says how to place it on a host in another zone.
- New: a concrete off-host copy (`rsync` over SSH, keeping the backup's permissions) and two ways to be
  told a night failed — cron's mail, or an uptime monitor's check-in. Marked as examples, not rehearsed.
- The upgrade runbook says what to do when `--wait` gives up during a long migration.

### Fix — 2026-10-15: the socket tests that fill the kernel's buffers state their own time (part of #632)

- They post megabytes until the kernel's buffers fill, and on a loaded machine one ran past Bun's
  default five seconds. They now state their own budget; what decides whether the server works is still
  their own bound and the three-second wait for the close.

### Fix — 2026-10-15: a restart is held by the proxy, not answered 503; readiness is bounded (closes #636)

- While the API restarted, the proxy answered at once that no upstream was there. It now holds a
  request up to 30 s for a ready node (measured: 503 in 4 ms before, 200 once the API was back after).
  It retries only what it could not hand over, so nothing is sent twice.
- `/health/ready` ran several queries on every call from anywhere. It now answers from a check at
  most a second old, one check at a time; it stays public for an uptime monitor (`PRD.md` §5).
- A stale comment in the production compose file now names `storage-init`.

### Fix — 2026-10-15: an error nothing handled is reported, and ends the process (closes #634)

- An unhandled rejection or an uncaught exception in the API or the scheduler was left to the
  runtime: printed, and never sent to the error tracker. Each is now logged once and reported as urgent
  (past a tracker full of ordinary reports), new work stops, the tracker is flushed within two
  seconds, and the process exits 1 for its container to restart — also when it happened during a
  shutdown's drain. A test runs a real process to show the runtime emits both.

### Fix — 2026-10-15: on a phone the focused composer's hints no longer cover Send (closes #627)

- Squeezed between the controls, the three hints wrapped and were drawn over the send button. On a
  narrow window they now take a row of their own under the controls. `narrow.e2e.ts` checks that no
  hint overlaps a control in the composer.

### Fix — 2026-10-15: the inbox names a direct message's sender once (closes #631)

- A message from one other person read "alice wrote to you · alice": the place after the dot was the
  conversation, which for one other person is that person. Such a row now names no place; a group
  conversation and a channel still name theirs.

### Feature — 2026-10-15: the page says at once that the network is gone, and reconnects the moment it is back (closes #626)

- A socket is not closed when the network goes, so the "Reconnecting…" bar waited for a `PING` to
  go unanswered — up to forty seconds of a page that looked connected and was not. The connection
  now hears the browser's `offline` and `online` events: offline declares the socket dead at once,
  and online starts the backoff over (within a jittered second, not after the wait earned offline),
  or checks an open socket with a `PING`. A message written meanwhile, or still waiting for its
  answer when the network went, is sent on the reconnect. `ARCHITECTURE.md` §5.4 says so.

### Fix — 2026-10-15: the empty Saved, Inbox and Open questions screens have room under the header (closes #625)

- The three screens drew their own copy of the "nothing here" tile, with no space above it, so it
  touched the header. They and the side panels now share one `GlyphEmptyState` (`ui/states.tsx`).
- The empty Saved screen named the reaction button "React", which read as the framework. It now
  says: choose Save for later on any message, and it waits for you here.

### Fix — 2026-10-15: one Escape closes a dialog that has only a list to read (closes #623)

- The audit log and the workspace export opened with focus on their close button, whose tooltip
  then took the first Escape, so the dialog needed two. A dialog whose first control would be its
  close button now takes focus itself; Tab still reaches Close.

### Fix — 2026-10-15: a channel's name is no longer drawn under its header's views on a phone (closes #624)

- At 390 px the header's controls were wider than the window, and the channel's name was drawn over
  "Open questions". On a narrow window the link is now its glyph and its count, and its name still
  says "Open questions" to a screen reader. `narrow.e2e.ts` measures that nothing in the header
  overlaps the name.

### Docs — 2026-10-14: the contributor licence agreement, and the check that holds it (D-145, closes #122)

- `CLA.md` is the agreement, adapted from the Apache Individual CLA. It is a licence grant, so the
  contributor keeps their copyright. A contributor signs by adding themselves to
  `.github/cla-signatures.json` in their own pull request. `bun run check:cla` runs in the pipeline
  and refuses a pull request whose author has not signed, or that signs for somebody else. README and
  CONTRIBUTING say so.

### Feature — 2026-10-14: the production stack comes up with one command (D-144, closes #76)

- `docker compose -f docker-compose.production.yml --env-file production.env up -d --wait` is now the
  whole installation. A one-shot `storage-init` service prepares the object store through Garage's
  admin API on every `up`, doing only what is missing, and checks that the bucket refuses anonymous
  reads. The API and the scheduler wait for it. One new secret is needed: `GARAGE_ADMIN_TOKEN`.
  `scripts/production-init.sh` is no longer needed, and is kept for an existing stack. The README has a
  self-hosting section.
- Fixed: the production image did not build since #539, because the Dockerfile did not copy the push
  worker's source.

### Docs — 2026-10-14: what personal data an instance holds, and the operator's runbooks (D-28, closes #85)

- New `docs/DATA.md`, for the operator who runs an instance:
  - who receives what: the project receives nothing, and the instance's own recipients are listed;
  - a data map of every table, with what it holds about a person, why, and for how long;
  - a retention runbook;
  - an erasure runbook, including what backups keep and for how long.

  A test fails the build when a migration adds a table the map does not name.

### Fix — 2026-10-14: an upload interrupted midway leaves nothing nobody can find (closes #607)

- An upload now writes the keys of its objects to the deletion queue before it writes the objects, due
  an hour later, and takes them out in the transaction that inserts its row. A process that stops
  between the store's write and the row's insert therefore leaves keys that `sweep:deletions` deletes
  once that hour has passed, never objects no row names. An upload that is refused or raced lets its
  objects go at once, as before.

### Feature — 2026-10-14: the page says when you are in front of it, so your phone stays quiet (D-143, closes #545)

- While a Purlay page is visible and focused, it sends `ACTIVE` for its workspace when you press a key,
  touch or click, and as it comes to the front, at most once a minute. The server then holds that
  workspace's Web Push for two minutes. A tab left open behind other windows says nothing, so your
  phone still buzzes. After a reconnect the next word goes at once, and a refused word is not taken
  for a broken connection.

### Feature — 2026-10-14: a push is held while you are looking at that workspace (D-143, part of #545)

- A new client frame, `ACTIVE`, tells the server that a page is in front of its person in a workspace.
  The server keeps that for two minutes. While it holds, a Web Push for that workspace is not sent to
  any of the person's devices, and it is not sent later either. A workspace the sender is not in is
  refused as not found. The page that sends the frame is the next slice.

### Fix — 2026-10-14: a class list in any constant is held to the tokens (closes #572)

- The token vocabulary check now also reads every constant that a `className` or a class helper names,
  whatever the constant is called. Before, it read only constants named `…Classes`, so a raw value in
  `const link = '…'` built and shipped unchecked. The constants the issue named (`textCell`, `words`,
  `sectionTitle`) are read now, and every class in them is a token.

### Refactor — 2026-10-14: one check that the caller is in the channel, and one way a test tries (closes #575)

- Pins, channel settings and adding a member now ask the shared `requireChannelMember`, with
  `isChannelMember` beside it, instead of each reading `channel_members` itself. Each keeps its own
  refusal sentence. The four integration tests that tried a refused write in a hand-written savepoint
  now use `testing/attempt.ts`, which gained `inSavepoint` for a test that needs the error itself. No
  test changed what it asserts.

### Docs — 2026-10-14: how a reporter of a vulnerability is credited (closes #123)

- `SECURITY.md` now states its credit policy: a confirmed report is credited in the advisory and the
  fix's changelog entry, under the name the reporter chooses or anonymously, and there is no bug
  bounty. The private channel, the response times and the supported versions were already there.

### Fix — 2026-10-14: a channel joined or made on one device appears on the others, live (closes #540)

- Joining a public channel, or making a channel, now sends `CHANNEL_ADDED` to the person's own
  devices, as leaving one already sent them `ACCESS_REVOKED`. Before, every other open page missed
  the channel until it was reloaded, along with its unread messages and its mentions in the badges and
  the tab's title. This was the cause of the inbox test that failed only while other tests ran. The
  test now joins its channel after the page has loaded, so it reproduces the case every time.
- That fix exposed a second, client-side cause. Each subscription's answer re-read every cached
  thread, so a thread whose replies had failed was read again before its failure could show, and
  under a stream of new channels it stayed "Loading replies…" for good. `readAgain` now leaves a
  query that failed with nothing to show alone, with its Retry, wherever it is used: threads, pins,
  files and feeds. The frames that read a list again go through it too: a thread resolved or deleted
  (the open questions), stars (`CHANNELS_UPDATED`), saves (`SAVED_UPDATED`) and a workspace's members.
  A reconnect still reads everything again, failures included, since what failed may have failed
  because the connection was down.

### Fix — 2026-10-14: a write the network never answers is given up after 30 seconds (closes #604)

- The web client now gives every write (POST, PUT, PATCH, DELETE) a 30-second deadline. A write still
  unanswered then fails as the `NETWORK` failure every action already reports with Retry. Before, Save
  and Pin, which send one request per message at a time, stayed busy until the page was reloaded.
  Reads keep their query's own signal, and uploads, which report their progress, are not bounded.

### Fix — 2026-10-14: a pin the server kept stays marked when reading the pins again fails (closes #605)

- When a pin or an unpin is accepted but reading the channel's pins again fails, the change the server
  confirmed is set on the list. Before, the mark went back with nothing said, and a second press sent
  a second request. The same fix was made in Save in #606.

### Docs — 2026-10-14: forms are plain controlled fields (D-142, closes #582)

- `CONTRIBUTING.md` §4 now says what the client does: forms are plain controlled fields, validated by
  the contract at the server, with a refusal shown on the field. It no longer names `react-hook-form`
  and `zod`, which no form used and which were never dependencies.

### Fix — 2026-10-14: a thread's panel never leaves focus on nothing (closes #555)

- Opening a thread moves focus to the panel's heading at once, even while its root is still being
  read back. Closing a thread whose root has no row in the feed returns focus to the control that
  opened the panel, if it is still on the page, or else to the main region. This covers a thread
  opened from the files panel, the inbox, or a `?thread=` address. Before, focus fell to the page
  body.

### Fix — 2026-10-14: a file the store refused to delete is tried again until it goes (D-141, closes #592)

- When retention, an erasure, the orphan sweep or a discarded upload deletes a file's row, the file's
  key is now queued in the same transaction. The file is deleted after the commit. A file the store
  refuses, or one left because the process stopped in between, waits for `sweep:deletions`. That job
  runs hourly at :50 and tries every waiting key again until the store accepts, and its run fails while
  any key is left.

### Fix — 2026-10-14: Save holds what was asked beside the server's list (D-18, D-128, closes #558)

- Save on a message now keeps a pending save or removal beside the server's list of saves, as Pin
  does, and never writes it into that list. A refused save drops only its own change, so another
  save or another tab's change stays. A list read while a save is on its way no longer takes the
  mark back. A press while a request is on its way sends nothing. Retry is offered only for a
  failure that could pass, not for `SAVED_LIMIT`, and asks again only if the message is still not
  saved. The button keeps one name, "Save for later"; whether it is saved is `aria-pressed`, and a
  pending request is `aria-busy`. A save the server accepted stays marked even when reading the
  list again fails.

### Feature — 2026-10-14: exporting a workspace from the app (D-140, closes #84)

- An owner's workspace menu has **Export workspace…**. The dialog asks for an export and lists the
  owner's own exports. While one is being made, the dialog reads the list again every few seconds.
  A ready export is a download link that works once. After it is followed the export reads
  "Downloaded", with a hint to export again if no file arrived, and the list is read again so a
  download that never reached the server offers its link again. A failed export says why, by its
  code: cut off by a restart, the owner no longer an owner, or it could not be made. Strings are in
  English and Turkish.

### Fix — 2026-10-14: an export of a workspace with files no longer fails (D-140, part of #84)

- The export's check that every file belongs to the workspace expected a key format uploads never
  write, so exporting any workspace with an attachment failed. Uploads, exports and the check now
  take the prefix from one function. The export tests store their file through the real upload
  path, so a made-up key can no longer hide the mismatch.

### Feature — 2026-10-14: an owner exports their workspace and downloads it once (D-140, part of #84)

- `POST /api/workspaces/:id/exports` starts an owner's export, made in the background. It covers the
  channels that owner can see, carries nobody's address, and comes as one `.tar`. `GET …/exports`
  lists the workspace's exports, and `GET …/exports/:id/download` serves the archive once and then
  removes it from storage. Only one export of a workspace can be in progress at a time. A ready
  export expires after a day: `sweep:exports` runs hourly and removes expired archives, and marks as
  failed any export cut off by a restart.

### Feature — 2026-10-14: an export carries its files (D-140, part of #84)

- `export:workspace` now copies the file behind every attachment it exports into `blobs/`, after the
  snapshot has committed (a slow store cannot hold the database open), and checks each file's size
  against its row. A file purged since the snapshot is listed as removed; one the store lacks while
  its row is still there is listed as missing, and the command exits 1. A store that refuses, a read
  cut off halfway, or a file of the wrong size stops the export, leaving nothing that looks complete.

### Feature — 2026-10-14: exporting a workspace's records (D-140, part of #84)

- `bun run export:workspace <slug> <directory>` writes a workspace's records as NDJSON, one file per
  table, with a manifest: messages, threads, reactions, pins, incidents, the audit trail, members and
  the people the rows name. They are read in one consistent snapshot, a page at a time, into a new
  directory only its owner can read. Personal state (saved items, read positions, stars, Deep Work)
  and every credential or secret stay on the server, as do a former member's address and profile.
  The audit trail records the export. The files' objects and the owner's download follow.

### Feature — 2026-10-14: an operator erases what a person wrote (D-139, closes #83)

- `bun run erase:content <who> --workspace <slug>` (or `--all` for a self-hoster) empties every
  message the person wrote in that workspace, the way a delete does, and removes their files with
  their objects and their bytes. Everybody else's messages, events and incident write-ups are left as
  they are. Each workspace gets one line on its audit trail; run again, it finds nothing to erase.
- With this, retention, account erasure and content erasure, the three pieces of D-27, are all
  built.

### Feature — 2026-10-14: erasing one's account, on the screen (D-139, part of #83)

- "Erase my account…" in the account menu. It says what goes and what stays, and wants the username
  typed. A session that is too old is offered a fresh sign-in; the last owner of a workspace is told
  which workspaces to hand over, by name. Once done, the sign-in screen says the account was erased.
- An erased person appears as "deleted user" in the reader's language wherever people are named: on
  messages, in direct messages and their titles, in the palette, on profiles and on incidents.

### Feature — 2026-10-14: erasing one's own account (D-139, part of #83)

- `POST /api/me/erase` erases the caller's account. It needs their username typed and a sign-in from
  the last fifteen minutes. Their address, name, GitHub id and profile are cleared; every session is
  revoked and its sockets closed; their devices, pending sign-in links, saved items and notifications
  are deleted. Their messages, reactions and memberships stay, shown under a "deleted user" name. A
  later sign-in makes a new account.
- A workspace always keeps a live owner. An erased owner no longer counts toward the last-owner rule,
  and the last live owner of a workspace that has other people in it must hand it over before
  erasing. No new account may take a name beginning `deleted-user-`.

### Feature — 2026-10-14: choosing how long history is kept, on the screen (D-139, part of #83)

- Owners have "Keep history…" in the workspace menu: forever (the default), a month, a quarter, a
  year, two or five. A shorter window shows what will be deleted, and its button is red and names it;
  a longer window says nothing more. A window set another way appears as itself.

### Feature — 2026-10-14: an owner sets how long history is kept (D-139, part of #83)

- `GET` and `PUT /api/workspaces/:id/retention`, for owners only: whole days from 30 to a hundred
  years, or forever (the default). Each change goes on the audit trail with the old and the new
  window; setting the same window again writes nothing. The audit dialog shows the change in the
  reader's language.

### Feature — 2026-10-14: the retention purge (D-139, part of #83)

- `purge:retention` runs nightly, before the storage count is checked: in each workspace that keeps
  its history for a number of days, older messages are deleted. A reply goes on its own and its
  thread's summary is counted again; a root still answered within the window stays as a tombstone
  until its last reply goes. What each message added is taken back first: unread counts, mentions,
  and its files, with their bytes and their objects. Each workspace gets one line on its audit
  trail per run. A workspace that keeps everything, which is every workspace until an owner says
  otherwise, loses nothing.
- A reference to a message that disappears at that moment (a reply, reaction, pin, save or read) is
  now `404 MESSAGE_NOT_FOUND` on HTTP and on the socket, not a server error. Each one is logged with
  the name of the refused reference. A test binds the list to the database's own foreign keys. A
  workspace whose purge fails still gets a trail line for what was done, the other workspaces are
  still purged, and the run fails and names the workspace. A file the store would not delete also
  fails the run.

### Decision — 2026-10-14: retention and erasure, decided before they are built (D-139, part of #83)

- How the retention purge treats a thread across its window, what of a person erasure takes and what
  it keeps, who may erase, and why an operator's command cannot end a person's sockets — written down
  first. Removing messages from a channel now goes through one set-based rule, so the purge and content
  erasure take back exactly what a delete does.

### Feature — 2026-10-14: signing in by email, on the screen (D-138, closes #81)

- The sign-in card offers a link by email under GitHub where the server sends mail, and says the same
  thing whatever the address. The link opens a page that shows whose it is and signs in only on
  **Sign in**; an invitation in hand travels in the link, so the new tab still lands on it.

### Feature — 2026-10-14: using a sign-in link (D-138, part of #81)

- `POST /auth/email/preview` says which address a link was sent to without spending it, and
  `POST /auth/email/consume` spends it and signs in — making the account, the first time, with a
  username from the address. A link works once, for fifteen minutes, and never into an account that
  signs in with GitHub; two links used at once make one account. One client may ask for twenty links
  an hour, whatever the addresses. The screens follow.

### Feature — 2026-10-14: a sign-in link by email (D-138, part of #81)

- `POST /auth/email` sends a sign-in link to an address — or, for an address of a GitHub account, a
  word to sign in with GitHub — answering the same whatever the address, and sending after the answer.
  Five messages an hour for an address; links live fifteen minutes, are kept only as digests, and a
  daily job (`sweep:email-sign-ins`) clears them. Mail goes over TLS past the server's own machine;
  whether the relay answers is said as the server starts. Using the link, and the screens, follow.

### Feature — 2026-10-14: signing in by email, decided first (D-138, part of #81)

- How email sign-in works and how it meets GitHub sign-in is decided before any of it is built: a
  link proves an address at the moment it is used, email sign-in is for accounts made by email, and
  nothing is linked silently. The server takes `SMTP_URL` and `MAIL_FROM`, both or neither, and
  says at `GET /api/auth/methods` whether email sign-in is on.

### Feature — 2026-10-14: an incident's runbook and postmortem, on screen (D-137, closes #487)

- The incident panel links the runbook, opened in a new tab, and holds the postmortem, drawn as a
  message is and written in place; somebody else's save in between is said and shown, and the
  person's own words are kept to save again. Incident channels are complete: declared, moved,
  responded to and written up.

### Fix — 2026-10-14: every mutation entry still proves its guard, checked on every verify (#584)

- Seven entries of `scripts/mutations.ts` had gone stale as the code they guard moved; they are
  repaired, and `scripts/mutations.test.ts` now fails the build the moment an entry stops applying to
  exactly one place, or names a test that is gone.

### Feature — 2026-10-14: an incident's runbook and postmortem (D-137 §3, §5, part of #487)

- An incident carries the runbook it follows, an https link anyone in the channel sets or clears, and
  its postmortem, saved from the version it was edited from: somebody else's save in between is said,
  never written over. Both may be written after it is resolved. The screens follow.

### Feature — 2026-10-14: who is responding, on screen (D-137 §3, part of #487)

- An incident's panel lists who is responding; a member says "I'm responding", brings somebody else in
  from the channel, or takes somebody off — painted at once and put back if refused — and the banner
  shows the first three.

### Feature — 2026-10-14: who is responding to an incident (D-137 §3, part of #487)

- Anyone in a channel brings people in it in to respond to its incident, themselves included, and
  takes them off; at most fifty and nobody outside the channel. Somebody who leaves the channel stays
  on the list: it records who responded. Each change is on the incident's timeline with who did it. The
  screens follow.

### Feature — 2026-10-14: a channel's incident, on screen (D-137, part of #487)

- A channel's open incident is a banner under its header and a mark in the sidebar, SEV1 to SEV4.
  Its panel declares one at a severity, moves it, makes it worse or better and resolves it — each
  painted at once and put back if refused — and says what happened, newest first.

### Fix — 2026-10-14: a session that ends while a socket opens says why before closing it (#577)

- A sign-out that landed in the moment a socket was opening closed it with the right code but without
  the `SESSION_ENDED` frame every other end of a session sends first; it is now said, once, whichever
  way the hub learnt it.

### Feature — 2026-10-14: a channel's incident, declared, moved and resolved (D-137, part of #487)

- Anyone in a channel declares an incident in it at a severity, moves it between investigating and
  mitigating, makes it worse or better, and resolves it, once; every change is on its timeline with who
  and when. A retried declaration finds the incident it made; two racing, one wins. The channel list
  carries the open incident's severity, and everyone watching the channel is told as it changes. The
  screens that show it follow.

### Feature — 2026-10-14: a dot for who is online (D-136, closes #480)

- A person with Purlay open has a dot on their avatar in People, in a conversation's heading and in
  their profile, said as "online" to a screen reader. Read when the workspace opens and again half a
  minute after a reconnect; a presence that failed to load draws nothing, never a team gone offline.

### Feature — 2026-10-14: who is online, told to the people one shares a workspace with (D-136, part of #480)

- The server knows who has Purlay open and tells the people who share a workspace with them —
  offline only half a minute after their last tab closes, so a reload is not a departure — and answers
  a workspace's presence for its members. The dot that shows it follows.

### Feature — 2026-10-14: a message's edit history, from its "edited" mark (D-135, closes #82)

- "Edited" opens what the message says now and what it said before each edit. Its author can remove
  an earlier version, after being asked; the edit box says the old words stay until then.

### Feature — 2026-10-14: what an edited message said before (D-135, part of #82)

- Every edit keeps the words it replaced. Anybody who can read the message can read its earlier
  versions, newest first; its author can remove one; deleting the message removes them all.

### Feature — 2026-10-14: a channel's GitHub repositories, in its details (D-134, closes #79)

- An owner or an admin connects a repository from the channel's details, choosing what it posts, and
  is shown the payload URL, the content type and the secret to paste into GitHub — the secret only
  then. Each repository says when it was last reached and why it last failed, and is disconnected
  after asking.
- A dialog taller than the window scrolls inside it: its last button was below the window, where
  neither a pointer nor a scroll could reach it.

### Feature — 2026-10-14: pull requests, issues and releases in a repository's channel (D-134, part of #79)

- A feed posts a pull request opened, closed, merged, reopened or ready for review; an issue opened,
  closed or reopened; a release published — each a sentence with its title, linked to GitHub. Other
  actions are received and not posted. The ids of deliveries are forgotten after thirty days by a
  nightly job, `sweep:github-deliveries`.

### Feature — 2026-10-14: a repository's pushes in its channel (D-134, part of #79)

- GitHub's webhook posts to the address a feed was given: a signed push becomes a message in the
  channel — who pushed what, to which branch, the newest commits — unread for everybody and telling
  nobody. Redelivering the same delivery posts nothing again; a ping confirms the setup; a delivery
  that cannot be posted says why where the feed was set up.

### Feature — 2026-10-14: a message nobody wrote, for a repository's events (D-134, part of #79)

- A repository's event is a message of its own: GitHub's, never a person's — not yours to edit, not
  grouped with anyone's, unread for everybody — drawn as a sentence in your language with links to
  the push, the pull request, the issue or the release. Nothing posts one yet: the webhook follows.

### Feature — 2026-10-14: a repository's feed connected to a channel (D-134, part of #79)

- An owner or an admin connects a GitHub repository to a channel they can see, choosing its events,
  and gets the address and the secret GitHub needs — once; feeds are listed and disconnected the same
  way, each on the audit trail. The webhook address is not served yet: deliveries are posted by the
  webhook that follows, in this release.

### Feature — 2026-10-14: a pasted diff drawn as a diff (D-133, closes #80)

- A ` ```diff ` (or ` ```patch `) block shows numbered lines, what was added and removed in colour
  and in words, the counts, and Unified or Split — copied as it was sent, clamped when long.

### Feature — 2026-10-14: channels to join after accepting an invitation (D-132, closes #489)

- Accepting an invitation leads to the workspace's public channels, the three busiest picked
  already: join them together, change the pick, or skip. A join that fails part way says which.

### Feature — 2026-10-14: starred channels (D-132, part of #489)

- **Star this channel** in a channel's header keeps it in a Starred section above Channels, by name;
  painted at once, put back with Retry when refused, and the person's other tabs follow.

### Feature — 2026-10-14: profiles (D-131, closes #488)

- **Your profile…** in the account menu sets a title, a status line and your time zone (this
  device's in one press). A conversation with one person shows the time where they are and their
  status beside their name, which opens their profile; the people picker shows titles and local
  times. A change reaches everyone who shares a workspace with you at once.

### Feature — 2026-10-14: profiles, the API (D-131, part of #488)

- A person sets a title, a time zone and a status line with `PATCH /api/me/profile`; `/api/me` and a
  workspace's members carry them, and everyone who shares a workspace with them is told to read the
  members again.

### Feature — 2026-10-14: pin a message, and a channel's pins in a panel (D-130, closes #485)

- **Pin** beside Save on a message, for a member of the channel: marked at once, put back with Retry
  when refused. A pinned message says **Pinned** under its words, and **Pinned messages** in the
  header opens the channel's pins beside the conversation — who said each, who pinned it, a reply's
  thread, and Unpin — kept current as anyone in the channel pins or lets one go.

### Feature — 2026-10-14: a channel's pins, the API (D-130, part of #485)

- `PUT`/`DELETE /api/messages/:messageId/pin` pin a message for its channel or let it go — a
  member's, at most 50 a channel — and `GET /api/channels/:channelId/pins` lists them, newest first,
  with who pinned each. Everyone watching the channel hears `PINS_UPDATED` and reads them again.

### Feature — 2026-10-14: a channel's files, in a panel (D-129, part of #485)

- **Files** in a channel's header opens every file shared there beside the conversation, newest
  first, with who shared it and when: an image opens, a file downloads, and one said in a thread
  opens that thread. Kept current as files arrive or their messages are deleted.

### Feature — 2026-10-14: a channel's files, the API (D-129, part of #485)

- `GET /api/channels/:channelId/files` lists every file shared in a channel, newest message first, with who
  shared it, when and in which thread; a deleted message's files and unsent uploads are never shown.
  Each attachment now carries its channel (migration 0027), backfilled for those already sent.

### Feature — 2026-10-14: the Saved view (D-128, #484)

- Saved on the rail: what you kept, newest saved first, in In progress, Archived and Completed —
  the tab in the address — each opening its conversation, moved or let go from its row.

### Feature — 2026-10-14: Save for later on a message (D-128, part of #484)

- Beside React on any message: marked at once, put back and said with Retry when refused, and kept
  in step across tabs by `SAVED_UPDATED`.

### Feature — 2026-10-14: saved items, the API (D-128, part of #484)

- `PUT`/`DELETE /api/messages/:id/saved` save a message, move it to In progress, Archived or
  Completed, or let it go; `GET /api/workspaces/:id/saved?state=` pages them and `…/saved/ids` names
  them. Only what the person can read now, at most 1000 a workspace, and their own devices are told
  `SAVED_UPDATED`. No reminder: reminders stay a non-goal (`PRD.md` §6).

### Feature — 2026-10-13: a group's details (D-127, #486)

- A group's title opens its details: its people, you first, and New conversation with these
  people…, which opens New message with them already picked.

### Feature — 2026-10-13: a group is its people everywhere it is named (D-127, part of #486)

- The palette, search's choice of where to look, the inbox ("wrote to the conversation"), mention
  suggestions (the group's people still in the workspace) and a device's push (titled by the
  group's other people) no longer treat a group as one person.

### Feature — 2026-10-13: group conversations in the sidebar, started from New message (D-127, part of #486)

- A Conversations section lists each group by its people; New message picks up to nine people
  ("To: …") and starts the conversation of exactly them. A group's title, in the header and the
  tab, is its people.

### Feature — 2026-10-13: group conversations, the API (D-127, part of #486)

- A direct message of up to ten people: `POST /api/workspaces/:id/conversations` opens the
  conversation of a set of people, the same one in any order; every message in it tells every
  other person. Migration 0025 lets `dm_key` hold two to ten sorted ids.
- `Channel.peers` names a direct message's people; `peer` is null for a group, so nothing reading it
  shows a group as one person.

### Feature — 2026-10-13: a device is told what needs its person (D-126, part of #78)

- After a send or an edit commits, through either door, the people it told for the first time have
  their devices pushed: only a notification still unread, not held back by Deep Work, on a live
  session's device subscribed under the current key. The words are the inbox's, in the person's
  language, and what was written is never sent.
- Sent through the checked address and lookup an external image uses, detached and bounded; `404`
  or `410` forgets the device, as do five failures in a row. The pushes still on their way are
  waited for at shutdown.

### Feature — 2026-10-13: Web Push's encryption and signature, and `bun run push:keys` (D-126, part of #78)

- `modules/push/encrypt.ts`: a push's body encrypted for one browser (RFC 8291, `aes128gcm`),
  reproducing the RFC's Appendix A byte for byte. `modules/push/vapid.ts`: the ES256 token of RFC
  8292, valid for twelve hours, read back and verified in its test.
- `bun run push:keys` prints a pair the configuration accepts. The API now also refuses a key spelled
  other than canonically, which would have re-subscribed every device on every load.
- `expect(…).rejects` and `.resolves` are refused by lint: Bun does not type them as promises, so an
  unawaited one passed whatever happened, as one test in the subscription slice did.

### Feature — 2026-10-13: notifications on this device, in the account menu (D-126, part of #78)

- The account menu turns them on and off: the browser is asked once, the server is sent the
  subscription and the person's language, and a refusal says where it is undone. Offered only where
  the browser has push and the server has keys.
- A browser's subscription is honoured only for the person who turned it on there (signing out
  forgets who), re-sent on every load to tie it to the session, and made again under a replaced key.
  A changed language is told to the server; a clicked notice opens its conversation in the tab.

### Feature — 2026-10-13: the push worker (D-126, part of #78)

- `apps/web/worker/push-worker.ts`, built by Vite as an entry of its own to `/push-worker.js`: a push
  is always shown, folded by its tag, and a payload it cannot read is shown as the plain notice; a
  click focuses an open tab and tells it the path (`PushOpenMessage`), or opens one. A path is the
  only address it opens: `PushPayload.url` now refuses `//host`.
- Tested from both sides against the contract, and in a browser: Chromium's DevTools protocol
  delivers a push to the built worker.

### Feature — 2026-10-13: a device can be subscribed for Web Push (D-126, part of #78)

- Migration 0024: `push_subscriptions` (a person's devices, tied to the session they were made in) and
  `users.locale`. `GET /api/push/key`, `POST /api/push/subscriptions` and `…/remove`,
  `PUT /api/me/locale`; signing out deletes the session's devices. `VAPID_*` configure it, all three
  or none — none is push off (`PUSH_UNAVAILABLE`). Nothing is pushed yet: the delivery follows.

### Specification — 2026-10-13: Phase 2 begins while Phase 1 waits on its deployment (D-125)

- The owner started `v0.3.0` work before `v0.2.0`'s exit is demonstrated; the order is in D-125, and
  the features from the design screens (#484–#489) are Phase 2 in `PRD.md` §4.

### Feature — 2026-10-13: Deep Work started or ended in one tab is drawn in the others

- `PUT …/deep-work` now publishes `DEEP_WORK_UPDATED` on the person's own topic; their other tabs and
  devices draw the bar and its end at once instead of after a reload (#526, D-108 amended).

### Interface — 2026-10-13: the workspace menu from the workspace's name (D-124)

- The workspace's name at the top of the sidebar, with a chevron, opens the workspace menu; the rail's
  tile still does too. **Create workspace…** in it makes another workspace with the first-run form.

### API — 2026-10-13: renaming a workspace (D-124)

### API — 2026-10-13: renaming a workspace (D-124)

- `PATCH /api/workspaces/:workspaceId` renames a workspace, an owner's or an admin's; the slug stays.
  It is on the audit trail with the name before and after, and every member's open tabs are told
  (`WORKSPACE_UPDATED`) and read their memberships again. Deleting a workspace is still not built.
- **Workspace settings…** in the workspace menu, for owners and admins, is where it is renamed.

### Interface — 2026-10-13: the account menu (D-124)

### Interface — 2026-10-13: the account menu (D-124)

- The sidebar's foot — your avatar, name and handle — opens the account menu: Deep Work for 30
  minutes, an hour, two hours or until tomorrow (or, while on, the minutes left and its end), the
  theme, the language, the shortcut reference, **Sign out** and **Sign out everywhere…**, which asks
  first and ends every session you hold.
- The rail's settings gear is gone and Sign out has left the workspace menu: each lives once, in the
  account menu.

### Interface — 2026-10-13: Deep Work for a while (D-124)

### Interface — 2026-10-13: Deep Work for a while (D-124)

- The command palette starts Deep Work for 30 minutes, an hour, two hours or until tomorrow, and ends
  it; the server keeps the instant chosen. `Cmd/Ctrl+Shift+D` still starts it for an hour.

### Specification — 2026-10-13: a private channel's name is not private (D-104, amended)

- A name a private channel holds is taken for the whole workspace, and a `409` on creating or renaming
  says so to a member outside it. Accepted and written down; nothing else about the channel is shown
  (#520).

### Feature — 2026-10-13: `@` offers people in the composer (D-110 §8, amended)

- Typing `@` and a letter in a channel's or a thread's composer lists who a mention there would reach,
  matched by display name or handle without case or Turkish accents; `↑` `↓` move, `Enter` or `Tab`
  writes `@handle `, `Esc` closes the list, and `Enter` while it is open never sends.
- A private channel offers only the people the client has seen in it; a direct message, its other person.

### Fix — 2026-10-13: unsent messages go with a channel the person lost, and say so

- A message still sending, or failed, in a channel that was then archived, left on another device
  or taken away stayed in the pending store and in local storage with no screen that showed it. The
  engine now removes them when the channel goes (`ACCESS_REVOKED`, or a subscription refused for
  good) and one notice says how many, in both languages. The channel's member list and its threads
  leave the cache with it (#521).

### Fix — 2026-10-13: letting go of channels no longer spends the frame budget a send needs

- The client sent one `UNSUBSCRIBE` per channel. When several channels left together — a list read
  again after channels were archived or left, a workspace switched — the burst spent the socket's
  frame budget, and a message sent in that second was refused as *going too fast* (#523; measured
  in the browser suite: 14 `UNSUBSCRIBE` frames in one second, then the send refused). Channels let
  go together are now one frame, chunked at `SUBSCRIBE_MAX_CHANNELS`, and channels the server
  revoked are forgotten without a frame, since the server already dropped them.

### Web — 2026-10-13: leave or archive a channel from its details (D-123)

- The details end with Leave channel for a member and Archive channel for an owner or an admin, in
  the danger tone (a new `dangerQuiet` button), each asking first. The last member of a private
  channel is told what to do instead. Leaving takes the channel off every tab of the person who left.

### Web — 2026-10-13: a channel's details, from its name (D-123)

- The channel's name in its header opens its details: the name and topic with Save, the members with
  Add people, and the notification level. A rename reaches every open screen without a reload.

### Web — 2026-10-13: a channel's name typed as it is said (D-123)

- New channel turns what is typed into the name's form as it is typed — *Genel Sohbet* becomes
  `genel-sohbet`, Turkish letters and accents folded — instead of refusing it.
- A channel archived, or left on another screen, while somebody is looking at it says which.

### API — 2026-10-13: archive and leave a channel (D-123)

- `DELETE /api/channels/:channelId` archives a channel, for an owner or an admin: hidden from
  everyone, its messages and memberships kept, its name free, and on the audit trail.
- `POST /api/channels/:channelId/leave` takes the caller out; the last member of a private channel is
  refused (`409 LAST_CHANNEL_MEMBER`). `ACCESS_REVOKED` now says why when it is either.

### API — 2026-10-13: rename a channel and set its topic (D-123)

- `PATCH /api/channels/:channelId` renames a channel or sets its topic, for a member of it; a taken
  name is `409 CHANNEL_NAME_TAKEN`. The room hears `CHANNEL_UPDATED`, versioned by the channel's own
  `state_version` (migration `0023`), and a rename is on the audit trail.
- `GET /api/channels/:channelId/members` lists who is in a channel. D-123 also decides archiving and
  leaving; `ARCHITECTURE.md` §7.4 no longer lets every member archive.

### Quality — 2026-10-13: focus is asserted by identity

- `expect(document.activeElement).toBe(element)` passed under Bun with focus on a **different**
  rendered element (#518): inside a mounted app every pair of connected elements compared equal. All
  53 such assertions now go through `expectFocusOn` (`apps/web/src/testing/focus.ts`), which compares
  with `===` and names both elements when it fails; none of them turned red, so no keyboard path was
  broken behind them. Lint refuses the old form, shown by `verify:enforcement`.

### Interface — 2026-10-13: the tab says what needs you, and a failure is never a blank page (D-106, D-96)

- The browser tab is titled `<place> · <workspace> · Purlay`, prefixed `(N)` with the mention badges'
  sum while anything needs the person, live over the socket and quiet in Deep Work.
- A screen that throws while drawing is replaced by a short explanation with Reload and Go home, and
  the shell stays; anything else that throws gets the same at the root. React reports the error to
  the console.
- Alone in a workspace, the People section says so, and offers an owner or an admin **Invite people…**.

### Quality — 2026-10-13: the client is always built for production, and survives StrictMode

- `bun run build:web` sets `NODE_ENV=production` itself. A root `.env` with `NODE_ENV=development`
  (Bun loads it into every `bun run` from the root) had made the browser suite run against React's
  development build, which is not the production shape D-61 asks for and is three times slower.
- Two effects that were wrong when React runs an effect, its cleanup and the effect again (as
  StrictMode does in `bun run dev`): the theme store stopped writing the page after its first
  cleanup, so a choice changed nothing; and the frame took the second run for a navigation and
  focused `<main>` on load, so the first Tab passed the skip link. A production build never ran
  either twice; a development one always did.
- Two browser tests that passed by winning a race: the inbox test started in the room whose mention
  it then expected unread (leaving a channel reads it), and the update test's single Escape closed
  the Settings tooltip instead of the narrow overlay when focus had already returned to Settings.

### Fix — 2026-10-13: a failed sign-in lands on the sign-in screen, saying why (D-121)

- `GET /auth/github/callback` never answers JSON: a cancel on GitHub, a stale or missing state, an
  account with no verified email, an email another account holds, GitHub unreachable, the rate limit
  or a busy database, and anything unanticipated each come back as `/sign-in?error=<reason>`, one of
  `SignInFailure` in `@purlay/types`. The address carries the reason and nothing else; the cause is
  logged.
- The sign-in screen says, in English and Turkish, one sentence per reason: what happened and what to
  do. GitHub's own failures now have a type, `GitHubUnavailableError`, instead of becoming `INTERNAL`.

### Design — 2026-10-13: threads open in a panel on the right (D-122)

- **Show thread**, `T` and Reply open a root's thread in a panel beside the feed: its header and close
  control, the root with its status and Resolve, the replies under an *N replies* rule, and the reply
  box at the bottom. The root's line in the feed says *Thread open* while it is there.
- `Esc` closes the panel and focus returns to the root; focus moves into the panel when it opens.
  Below 900px the panel covers the conversation, which is hidden until it closes.
- Resolving from here still folds the thread and closes the panel; a thread resolved by somebody else
  now stays open where the reader is, with its status changed. Replaces the inline expansion.

### Specification — 2026-10-13: online presence is Phase 2 (D-120)

- `PRD.md` §4.1 no longer lists presence in Phase 1; Phase 2 does, so the PRD and `UX.md` §2 agree.
  Nothing in the client or the server changes: neither shows presence. Building it is #480 (`v0.3.0`).

### Design — 2026-10-12: a conversation with two edges (D-119)

- Messages sit in bubbles: everyone else's on the left on `surface-200` with their avatar, your own on
  the right on `accent-subtle` with neither avatar nor name. A mention of you marks the bubble's edge
  instead of tinting the row, and the row no longer tints under the pointer.
- The avatar and the name stay on a group's first message, so nothing above the reader moves when a
  group grows. The channel's feed and composer are centred.

### Design — 2026-10-12: the Superdesign v10 palette (D-118)

- Navigation takes its own dark navy tone in both themes (`nav-*`), the accent is blue, the focus ring
  is seen on both grounds, and the composer gets `shadow-raised`. Every new pair is computed in both
  themes.
- The rail and the sidebar are drawn on navy in both themes; the channel's rows, day, unread marker,
  code block, reactions and composer follow the draft; the composer's focus ring sits on its edge.

### Quality — 2026-10-13: the browser suite runs green on Safari's or Firefox's engine, by choice

- `PURLAY_E2E_ENGINES=webkit` or `firefox` adds that engine to a run (not to CI): WebKit 124 passed,
  Firefox 126; the engine's measured limits are skipped by name and Chromium's projects skip nothing.

### Quality — 2026-10-13: the error-tracking bound test waits by the clock

- `error-tracking.bounded.test.ts` gave up after a hundred tries of 20 ms; under the full suite's load
  two requests took longer, and it failed waiting rather than asserting. It now waits up to four
  seconds by the clock, inside an explicit ten for the two tests that wait.

### Feature — 2026-10-13: every channel switch is measured in the page, for O-5

- The router marks each change of address and the feed measures to the frame that draws the new
  channel's rows: a `purlay:channel-switch` entry in the browser's performance timeline, at most 500
  kept, nothing sent anywhere (D-44). It is what dogfooding reads to decide virtualization (#75).

### Quality — 2026-10-13: the browser suite run on Firefox too, in a Linux container

- 126 of 132 pass; the six failures are Firefox's or the test harness's (focus past the last element, no
  `first-paint`, a synthetic paste event's empty data, offline emulation, CDP), each measured. No
  product defect on Safari's engine or Firefox's (`docs/spikes/cross-browser.md`).

### Quality — 2026-10-13: the browser suite run on Safari's engine (`docs/spikes/cross-browser.md`)

- WebKit passes 124 of 132 browser tests; the 8 failures are the engine's, not the product's. Firefox
  would not start in this environment and is still to be run.

### Security — 2026-10-13: three ways one member could spend what everyone shares

- Found by an independent review of the budget changes. `/api/images/`, with a trailing slash, reached
  the image proxy uncharged; the limiter now compares the path the router matches. Asking for GitHub
  links nobody wrote spent a call of the workspace's one token each; calls to GitHub now have a budget
  per workspace, under the token's hourly quota. And the line for the node's four image-fetch slots
  only grew; past sixteen waiting a picture is refused at once (D-81).

### Quality — 2026-10-13: the latency budgets measured at the build target (`docs/spikes/capacity.md`)

- One API process with 300 sockets in a channel and 20 messages a second: ACK p95 19–21 ms, fan-out
  p95 14–16 ms, every message to every socket; at twice that, still under 20 ms. Memory under that load
  is 128–136 MiB, past the idle budget, which nothing else had measured.

### Operations — 2026-10-13: the production containers' logs are bounded

- Every service of `docker-compose.production.yml` keeps at most five 50 MB log files. Docker's
  default keeps everything, and a disk filled by logs stops the database next.

### Operations — 2026-10-13: the nightly backup is two cron lines, run as written

- `CONFIG.md` gives the host's crontab for a nightly `backup.sh` and a fourteen-day retention, both run
  under cron's bare environment against the production stack, and the monthly restore that proves
  them. The spike had said a cron line was the documentation; none had been written.

### Quality — 2026-10-13: the connection-bar test closes the sockets before going offline (#347)

- Its own diagnostic (#460) named the cause on its first firing: `ws://…/ws 2`, a socket left
  CLOSING because it was closed after the browser went offline, so its closing handshake never
  finished and the page never heard it close. The test now closes, waits for those sockets to be
  CLOSED, and only then goes offline. The attachment test waits for its picture to be decoded rather
  than only laid out.

### Fix — 2026-10-13: drawing a channel no longer spends what a person sends with (D-81)

- GitHub cards and external pictures were charged to the per-person write budget, and a channel
  asks for one per link it shows: a page of links went over the burst, cards were refused `429`, and
  so would the next message have been. They now have a budget of their own (`COSTLY_READ_BUDGET`,
  provisional under O-4).

### Fix — 2026-10-13: a message sent while the API was down sends when it is back

- Found by crashing the API under two connected browsers on the production stack: the HTTP door
  answered the proxy's 502, the row failed with "something went wrong on our side", and nothing sent
  it when the socket came back — though the bar had promised it would. A proxy's 502/503/504 is now
  the server not reached (`NETWORK`, transient), and a reconnect sends again every send that failed
  only for want of a server; one the server refused stays failed. Rehearsed again: both messages
  arrived once the API was back, once each.

### Quality — 2026-10-13: the connection-bar test says what the page held when it fails (#347)

- `states.e2e.ts` "the connection" fails now and then under the full suite's load and never alone.
  Instead of a bare timeout it now reports every socket's address and state, and every status on the
  screen, so the next failure names its cause.

### Quality — 2026-10-13: the wedge's order test waits for the sender's own frames first (#347)

- `wedge.integration.test.ts` marked where Alice's frames began before her own send's ACK had
  arrived; under the full suite's load the ACK came after the mark and the order began with it. It
  now waits until her ACK and her echo are in, then marks.

### Feature — 2026-10-13: the audit trail is read in the app (D-26, `PRD.md` §4.7)

- **Audit log…** in the workspace menu, for owners and admins: who did which administrative thing to
  whom, in words, newest first, with older pages on demand. The recorded actions are now one list in
  `@purlay/types` (`AUDIT_ACTIONS`), which the API records from and the client names exhaustively.

### Feature — 2026-10-13: search narrowed to one channel (`PRD.md` §4.6, D-105)

- The search screen has **Where**: every channel, or one of them. The choice is in the address
  (`?q=…&in=…`), so Back, a reload and a link keep it; new words keep it too; the empty state says
  where it looked. The API took `channelId` already; the screen never sent one.

### Feature — 2026-10-12: owners and admins manage members and roles in the app (`PRD.md` §4.3)

- **Members…** in the workspace menu: everyone's role, changed from a select where the server would
  allow it, and Remove after asking in the row. The roles API existed (D-111); nothing in the app
  called it, so making somebody an admin took `curl`.

### Feature — 2026-10-12: an owner gives the workspace its GitHub token from the app (D-23, `PRD.md` §4.8)

- **GitHub connection…** in the workspace menu, for owners and admins: whether a token is set and
  since when, a field to save one, and Disconnect. Until now the token could be set only by calling the
  API by hand, so on a new deployment no GitHub link ever became a card.

### Fix — 2026-10-12: a direct message begins a conversation, not a channel

- The top of a direct message said "This is the beginning of the channel"; it says "This is the
  beginning of the conversation" now, in both languages.

### Fix — 2026-10-12: two things a walk through the product found

- The invitation dialog cut each open link's line short, ending at the time — "11:22 …" said
  neither morning nor night — and its Revoke buttons were three of the same name. The line is now
  whole, and is each Revoke's description.
- At a phone's width the composer's hints ran off its right edge when focused; they wrap now. Both
  are measured in a browser.

### Fix — 2026-10-12: what review found in the scheduler, the latency baseline and the pool test (#445)

- A job whose database fails before it starts is now said in the log; a failure is logged before it
  is recorded, since recording needs the database. `budget:latency` refuses a baseline it cannot read
  and an option with no file instead of comparing with nothing. The busy-pool test says which holding
  query failed, and always cancels them. The documents that still listed jobs, or said there was no
  scheduler, point at D-30.

### Quality — 2026-10-12: the busy-pool test waits for what it needs instead of a guess (#347)

- `client.integration.test.ts` waited a fixed 100 ms for two queries to hold the pool's connections;
  under the full suite's load connecting alone took longer and the test failed at 7–10 s. It now waits
  until `pg_stat_activity` shows both, and cancels them when done: 0.4 s, and red when the pool's
  wait is raised.

### Quality — 2026-10-12: the latency budgets block on a regression against main (D-49, #73)

- CI's database job restores the ACK and fan-out p95 that main last recorded, fails a run that
  jumps past it, and, on main alone, keeps the run's numbers as the next baseline. A first run with
  no baseline says so and records one.

### Fix — 2026-10-12: a message that lands while its feed is being read again stays on the screen (#347)

- A list already on the screen and being read again — the subscription's answer re-reads every
  feed — answered with a page read before the live change, and replaced it: a send could be drawn,
  acknowledged, and then vanish from the sender's own screen; a reaction could be undone. Every live
  write now sets such a read aside and asks again, which keeps what was written. The browser test
  that failed now and then under load (`live.e2e.ts`) was this.

### Fix — 2026-10-12: a new deployment's jobs run on its first minute (D-30, #440)

- The scheduler starts with `jobs:first`, which runs once each job that has never succeeded. A new
  stack's `jobs:status` used to exit 1 for up to a day; a restart of a healthy one still runs nothing
  extra.

### Fix — 2026-10-12: a release from a machine leaves the tests out of the image (#438)

- `scripts/release-image.sh` built from the commit piped in as an archive, and BuildKit does not
  apply `.dockerignore` to a context read from stdin: the image carried 177 test files and the
  demo seeder, and the smoke test refused every release. It now extracts the commit into a fresh
  directory and builds from that, which ships none of them.

### Quality — 2026-10-12: the week that closes O-4 is one command (#61)

- `bun run report:frames <log>` reads the API's log and answers what O-4 is closed by: each
  connection's peak frames in a second as the p99 and the maximum, beside the budget, and every
  refusal of frames, sends and HTTP requests.

### Quality — 2026-10-12: attachments work in the demonstration and the browser suite (D-117, #387)

- `STORAGE_DIRECTORY` keeps attachments in a directory instead of a bucket, refused in production
  and beside the `S3_*` variables. `bun run demo` uses one per run when no bucket is configured, and
  a browser test picks an image, sends it and sees it on the other person's screen.

### Feature — 2026-10-12: an upload says how far it has got (D-109, #388)

- The chip reads *Uploading… 42%*, a progress bar a screen reader can read, in both languages. An
  upload goes over the browser's one transport that reports a request body's progress; its answers
  and failures are read exactly as every other request's.

### Feature — 2026-10-12: a link to a picture shows the picture (#110)

- A message's `https` links to a `.png`, `.jpg`, `.gif` or `.webp` — up to three — are drawn under it
  through the API's image proxy, each a link to the original; the picture's host never sees the
  reader. One that cannot be shown draws nothing.

### Security — 2026-10-12: an image proxy that cannot be pointed inside (#110)

- `GET /api/images?url=` fetches an image on another server for whoever is signed in, and serves the
  API's own WebP of it. Only `https` to a named host; refused unless every address the name has is
  public; connected to the checked address on a fresh connection, no redirect, at most 10 MiB and
  five seconds. Every failure is one `404`, its reason in the log with the host alone. The client
  draws external images through it next.

### Spike — 2026-10-12: fetching an external image without becoming an SSRF endpoint (#110)

- `docs/spikes/image-proxy.md`: Bun's `fetch` cannot be told which address to connect to;
  `node:https` with a `lookup` that checks every address can, and TLS still names the host. A
  kept-alive socket skips `lookup` — the proxy must not reuse connections.

### Fix — 2026-10-12: a connection lost before it was drawn as open is still said (#347)

- "Reconnecting…" appeared only if the page had rendered the connection as open; one that opened and
  dropped between two renders — which load makes possible — was never announced. Whether the
  connection has been open is now kept where the status changes, not inferred from what was drawn.

### Security — 2026-10-12: the audit trail names the session that acted (D-116, #397)

- Each row records the session the request was made with; through it the sign-in's address and
  agent are known while the session lives, and the link goes when the session is swept. The empty
  `ip_address` and `user_agent` columns are dropped (migration `0022`).

### Quality — 2026-10-12: the ACK round-trip and the fan-out are measured (D-49, #73)

- `bun run budget:latency` starts the API against a clone of the database, signs two people in on two
  sockets in one channel and times sixty messages to their ACK and to the other socket. First run:
  p95 19.7 ms for both, against 120 and 200 ms. With a recorded baseline it fails on a jump.

### Security — 2026-10-12: every administrative write is on the trail, and a test holds it (D-26, #69)

- An owner or an admin deleting somebody else's message is recorded — who, which message and whose,
  never its words. A test walks the permission table and requires exactly one trail row for every
  role-gated write and none for a read.

### Fix — 2026-10-12: a feed being read when its channel was subscribed is read again (#347)

- The subscription's answer marked a channel's feed and the open threads to be read again only if
  they were not being read at that moment; one already on its way finished with what it had read,
  and a reply or a resolution that landed in between was never shown. It is now read again once that
  read is done. Two browser tests that failed under load are made deterministic: the thread's motion
  is measured from before the press, and the connection test holds its outage until it ends it.

### Feature — 2026-10-12: a pull request's card says its checks and its reviews (#423)

- Passed, failed or running, and approved, changes requested or review required — asked of GitHub's
  GraphQL API with the workspace's token, alongside the card. If that question fails the card is
  drawn without them and asked again within a minute.

### Feature — 2026-10-12: GitHub links are cards (D-23, #67)

- A pull request or issue linked in a message is drawn under it as a card: the kind, the repository
  and number, its state, its title linking out, and who opened it — read with the workspace's token,
  never its author's avatar. No card, nothing drawn; the link stays a link. CI and reviews: #423.

### Changed — 2026-10-12: open join is retired; people are invited (D-115, closes #50)

- Signing in no longer joins anybody to a workspace. `WORKSPACE_OPEN_JOIN_SLUG` is refused at boot,
  naming what replaced it: **remove it from `production.env`** and invite the team with a link from
  the workspace menu.

### Feature — 2026-10-12: owners and admins invite from the workspace menu (D-115, #50)

- **Invite people…** opens a dialog that makes a link, shows it once to copy, and lists the links
  still open — who made each and until when — each with **Revoke**. A member is not offered it.

### Feature — 2026-10-12: an invitation opens in the browser (D-115, #50)

- `/invite#…` takes the token out of the address as the page loads and keeps it in the tab through
  sign-in; the card names the workspace and until when, and **Join** goes there — or **Open**, for
  somebody already in it. A link that does not open says so with the way home; anything else offers
  Retry. In English and Turkish.

### Feature — 2026-10-12: a workspace invites by link (D-115, closes O-2, #50)

- An owner or an admin makes a link that opens for seven days to anyone signed in, lists the open
  ones and revokes them; joining by one makes a member of no channel, never changes an existing
  role, and does not bring back somebody removed since the link was made. The token is shown once,
  stored only as its digest, and travels in bodies, never in a logged path. The screens follow.

### Feature — 2026-10-12: the composer says who else is typing (D-114, #411)

- Typing in a channel's composer tells the room, rationed as the server rations it and only over an
  open socket; the composer's footer names who else is typing there, in both interface languages.

### Feature — 2026-10-12: who is typing is heard, and rationed (D-114, #411)

- A `TYPING` frame each way: a client names a channel it can see, the room hears who and for how
  long — at most once per three seconds per person, whatever the client sends. The web client keeps
  who is typing per channel, never shows the person themselves, and forgets someone when the
  announcement runs out or their message arrives. The composer and the line under the feed follow.

### Security — 2026-10-12: a refused subscription no longer releases a channel's held frames (#412)

- Frames held while a `SUBSCRIBE` was being authorised were dropped for a refused channel only if
  they were new messages; an edit's words, a thread summary, a reaction set or a read position
  published in that moment reached the refused socket with its error. Every kind is dropped now, and
  the same behind a revocation.

### Quality — 2026-10-12: the API's idle memory is a budget the build holds (D-49, #73)

- `bun run budget:api` starts the API against the database, waits for it to be ready and settled, and
  fails at 120 MiB or more; `verify` and CI's database job run it. First measurement: 80.6 MiB.

### Quality — 2026-10-12: the supported browsers are named, and held (D-113, #331)

- Chrome and Edge 120, Firefox 121, Safari and iOS Safari 17.2, as `browserslist` in
  `apps/web/package.json`. A web API one of them lacks is a lint error (`eslint-plugin-compat`),
  an ES2024 built-in a compile error, and the build targets the same list; what none of the three
  sees is written down.

### Fix — 2026-10-12: a GitHub token that no longer opens is tested (#66)

- The branch that says a token did not open — `ENCRYPTION_KEY` changed — and draws no card, and the
  one that throws any other failure on, had shipped untested, below the coverage floor.

### Feature — 2026-10-12: GitHub links unfurl (D-23, D-112, #66)

- `POST /api/integrations/github/unfurl` answers a pull request's or an issue's card, fetched with
  the workspace's token and cached for that workspace alone, so a private repository's card never
  reaches another. A link that is not there is asked about once an hour; GitHub failing, once a
  minute. Only a github.com pull request or issue is accepted, and the request to GitHub is built from
  its parts.

### Operations — 2026-10-12: expired link previews are swept (D-23)

- `bun run job sweep:link-previews` removes the unfurl cache past its expiry, and the scheduler runs
  it nightly. The expiry is also the reader's, so a sweep that did not run serves nothing stale.

### Feature — 2026-10-12: the workspace's GitHub token (D-11, D-23, #65)

- An owner or admin sets, replaces or removes the one GitHub token a workspace's cards will be
  fetched with (`…/integrations/github`). It is sealed at rest with the one cipher, bound to its row,
  never returned and never in the audit trail; the trail says it was set or removed, and by whom.
  Migration `0020` adds `github_integrations` and the unfurl cache `link_previews`.

### Security — 2026-10-12: the one credential cipher (D-39 §6, #113)

- `platform/crypto.ts` seals a stored secret with AES-256-GCM under a key derived from
  `ENCRYPTION_KEY`, a fresh nonce per seal, and the record's id bound in, so a sealed value opens only
  with the same key, for the same row, unaltered. Nothing else in the API encrypts, and a test holds it.

### Fix — 2026-10-12: the class vocabulary check judges each class alone (#385)

- Each class is now built by a compiler of its own. On one shared, incremental compiler a raw class
  was blamed again on every class after it, and a class that built nothing passed behind one that did:
  `size-control`, `size-touch`, `w-gutter` and `py-16` had shipped doing nothing. The composer's send
  buttons are now the square the control token says; the skeleton's rows keep the avatar's column; the
  two that never had a token are gone, which changes nothing drawn. A status compared inside a
  `className`, and a variant handed to a style function, are no longer taken for classes.

### Quality — 2026-10-12: the permission matrix is a test (#74)

- Every role-gated action is tried as an owner, an admin and a member, each in a workspace of its own,
  against a table of what §7.4 allows; a role-gated endpoint `API.md` serves without cases in the table
  fails the build.

### Feature — 2026-10-12: reading the audit trail (D-26)

- `GET /api/workspaces/:id/audit` gives an owner or admin the workspace's trail, newest first, a page
  at a time; a member is refused. The inbox and the trail read their query strings through one helper.

### Feature — 2026-10-12: the audit trail records administrative actions (D-26)

- A role change (with from and to), a member removed, somebody joining by the open door and a channel
  created each write one row of `audit_log`, in the transaction that does it: a refused action leaves
  none. Never anything a person wrote. Nothing updates or deletes the trail, and a test holds that.

### Operations — 2026-10-12: the frame budget is measured (O-4)

- Each socket's closing log line says how many frames it sent, the most in any one second, and how
  many the budget refused, so a week of dogfooding can confirm or correct ten a second with a burst of
  twenty. The line also says its close code again: a field named `code` was withheld from the log as
  an OAuth code is, so every socket closed without one.

### Feature — 2026-10-12: managing members and roles (D-111)

- An owner or admin changes a member's role (`PATCH …/members/:userId`) or removes them (`DELETE`).
  Making somebody an owner, or changing an owner, is an owner's; the last owner stays (`409
  LAST_OWNER`), even when two step down at once. A removed member leaves the workspace's channels, and
  their open sockets stop receiving them at once.

### Operations — 2026-10-12: the scheduler ships with the deployment (D-30)

- `docker-compose.production.yml` runs a `scheduler` service from the API's image, with the API's
  settings, started once the API is ready: sessions are swept hourly, orphans and the storage count
  nightly (UTC), each as its own process. It is installed by `up`, not remembered, and `jobs:status`
  says when each job last succeeded.

### Feature — 2026-10-12: the scheduled jobs (D-30)

- `bun run job sweep:orphans` takes unsent uploads older than a day, with their objects;
  `sweep:sessions` removes expired and revoked sessions; `reconcile:storage` puts each workspace's
  storage count back to the bytes its messages carry, and says which had drifted (I-7). Every run is
  recorded, and `jobs:status` says when each last succeeded, exiting non-zero when one is overdue or
  has never run — the scheduler nobody installed.

### Schema — 2026-10-12: the audit trail and the record of scheduled work (D-26, D-30)

- Migration `0019`: `audit_log`, append-only, keyed by the application's UUIDv7 and kept when its
  actor is erased, and `job_runs`, one row per scheduled job, so a scheduler nobody installed shows
  up as a job that never succeeded. The planned integrations migration moves to `0020`.

### Fix — 2026-10-12: an attachment downloads from the real store (D-109 §6)

- Downloading any attachment from the S3 store was a `500`. Bun turns its S3 file into a redirect
  to a presigned URL when a response is made of it, and refuses one with headers. The store now
  hands out a stream and its size, so the API serves the bytes itself, brokered, with
  `Content-Length`. `bun run test:storage` serves one from Garage to prove it. The in-memory double
  that every other test uses could not show this.

### Feature — 2026-10-12: attaching files from the composer (D-109, #370)

- Paste an image, drop a file or pick one with **Attach a file**: each uploads at once and shows as
  a chip with its state, Retry when it failed and Remove (which throws it away on the server too). A
  file over 25 MB is refused before it is sent. A message may be its files alone; sent while a file
  is still uploading, it waits and says so, then goes. Files sent and not yet acknowledged come back
  with the message after a reload.

### Feature — 2026-10-12: attachments drawn in the feed (D-109 §6)

- A message's images show as thumbnails under its words, in space kept for them before they load,
  and open the full image; its files show their name and size as a download. A thumbnail that does
  not load says so, with Retry. A deleted message shows none of them, in both languages.

### Feature — 2026-10-12: the other screens and the overlays in the flat style (D-110)

- The open questions, the inbox and search have the channel's header and its rows; the inbox and the
  questions say they are empty with a green tile. Sign-in and the first workspace are one card on the
  navigation tone; an address that leads nowhere sits on the window's ground.
- Menus, dialogs, toasts and the palette are 12px overlays with a soft shadow. The palette opens in
  150ms from 0.98 with a fade — and at once for a person whose system asks for less motion.
- Primary buttons darken on hover; secondary buttons are white with a one-pixel shadow. Keys are mono
  on a pale ground. A link in highlighted code is `accent-text`, so it stays legible in the dark.

### Feature — 2026-10-12: the channel in the flat style (D-110)

- The header names the channel in the sans beside a quiet glyph, with its topic after a rule; the two
  views are a segmented control at the right. The feed is 760px and hangs from the left edge.
- A message row has a 36px rounded-square avatar, the name in 14px semibold, the time in mono, and a
  hover tint; its hover controls float above it. The day is a label with a rule after it.
- A code block is a card: the language as a pill, the line count, Copy, and "Show N more lines".
- An open thread's state is a pill — amber while open, green once resolved.
- The composer is a card with three buttons under the box — Bold, Code block and Mention — that each
  insert the markdown the keys would type.

### Feature — 2026-10-12: a flat frame, with the rail back (D-110)

- The rail, down the left edge: the workspace tile (the switcher), then channels, the inbox, the open
  questions and search, and settings at the foot. The inbox carries a dot while something needs you;
  the open questions carry their count, neutral, because they are the team's and not a summons.
- One settings menu holds the theme, the language and the keyboard shortcuts.
- No canvas and no floating cards: the rail and the sidebar share one tone, the conversation sits on the
  window's ground, and one hairline divides them. The sidebar is the workspace's name, the jump field,
  the channels and the people, with your own row at the foot. Channel names are set in the sans.
- On a narrow window the rail and the sidebar open together, as one panel.

### Feature — 2026-10-12: a flat, quiet interface — tokens and type (D-110)

- Inter for prose and JetBrains Mono for machine text, served from this origin (`@fontsource/inter`
  5.3.0 and `@fontsource/jetbrains-mono` 5.3.0, Latin and Latin Extended, 244 KB for the ten files;
  a page downloads only the subsets its characters need). IBM Plex is gone.
- Neutral greys and one deep navy accent, in light and in dark. `accent` is now a fill only — it builds
  `bg-` and `border-` and no `text-` — and its words are `accent-text`, so a navy word on a dark page
  cannot be written. A colour token can say `"role": "fill"` for that.
- Smaller, quieter shapes: 6px controls, 8px rows, 10px cards, 12px overlays; a one-pixel card shadow;
  1.5px icon strokes. The sidebar is 240px and the feed 760px.
- The brief that was the input (`design-system.md`) is removed: its values live in `tokens.json`.

### Security — 2026-10-12: attachments are read through the API, and nothing in them runs (D-109 §6)

- `GET /api/attachments/:id` and `/thumbnail` serve the bytes behind an id to whoever may read them —
  the uploader while unsent, then whoever sees the message's channel, never a deleted message's — and
  `404 ATTACHMENT_NOT_FOUND` to everyone else alike. An image is drawn as the WebP it was stored as;
  anything else, SVG and HTML included, is a download: `attachment`, `application/octet-stream`,
  `nosniff` and a sandboxing policy, so an uploaded script cannot run on this origin.
- `DELETE /api/attachments/:id` throws away one's own unsent upload, its objects with it.

### Feature — 2026-10-12: sending a message with attachments (D-109 §7)

- A send — over the socket or HTTP — names the uploads it carries, up to ten; they become the
  message's in the same transaction, and their bytes the workspace's stored count. A message may be
  its attachments alone. An upload that is not the sender's own and unsent is `404
  ATTACHMENT_NOT_FOUND`, and the message is not written.

### Feature — 2026-10-12: a message carries its attachments (D-109 §6)

- Every message the API returns or sends — history, a thread, search, the inbox, a live frame —
  carries `attachments`, in the order they were uploaded and read in one query for the page. A
  deleted message carries none.

### Feature — 2026-10-12: an uploaded image is stored re-encoded (D-109 §1, §2)

- A PNG, JPEG, GIF or WebP — known by its bytes — is stored upright as WebP, at most 2560 pixels on
  its longer side and never enlarged, with a 512-pixel thumbnail beside it; its camera data goes with
  the original. A file claiming more than 40 million pixels is refused before it is decoded, and a node
  decodes at most two at once. Anything else, SVG included, is a file.

### Feature — 2026-10-12: uploading a file (D-109 §3, §5)

- `POST /api/workspaces/:workspaceId/uploads?id=&name=` takes a file's bytes and answers the
  attachment, waiting to be sent with a message. A retry is the same upload; nobody else's id can be
  taken. Nothing is read before the session and the membership; each node reads at most four uploads
  at once. A person holds at most twenty unsent, and the workspace's quota counts them.

### Feature — 2026-10-12: the attachment store (D-109)

- The API reads its attachment bucket — `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, all or none — and production refuses to start without it. With none, any use
  is a loud `503 STORAGE_UNAVAILABLE`. The store's adapter is Bun's own S3 client, nothing installed;
  `bun run test:storage` runs it against Garage.

### Security — 2026-10-12: the edge ready for attachments (D-109 §4)

- The server's own body limit rises to what an upload needs; every other request is still held to
  64 KiB, now by its `Content-Length` at the edge (`413 PAYLOAD_TOO_LARGE`), and a chunked body is
  refused (`411 LENGTH_REQUIRED`) — both before anything is read.
- Migration `0018`: the `attachments` table, its bounds as CHECKs bound to the contract, and the
  composite key that keeps an attachment in its message's workspace.

### Feature — 2026-10-12: Deep Work, in the client (D-108, `UX.md` §7, §8)

- `Cmd/Ctrl+Shift+D` starts Deep Work for an hour, or ends it. While it lasts a quiet bar says until
  when, with End, and the sidebar draws no mention badges — the counts are kept for when it ends. It
  ends by itself at its time.
- The shortcuts reference now lists Edit (`E`) and Deep Work, both of which work.

### Feature — 2026-10-12: Deep Work, on the server (D-15, D-108)

- `PUT /api/workspaces/:workspaceId/deep-work` starts it until an instant (at most a day ahead) or ends
  it; it also ends by itself. While it lasts, what you are told is still written and counted, marked
  as held back. `/api/me` says until when.

### Feature — 2026-10-12: choose what a channel tells you (D-107)

- A channel's header has a bell: Every message, Mentions and replies (the default), or Nothing — the
  bell crossed out when it is Nothing. Changed at once; refused, the old choice comes back and the toast
  says why. Offered only in a channel you are in.

### Feature — 2026-10-12: a notification level per channel, on the server (D-107)

- `PUT /api/channels/:channelId/notification-level` sets what you are told about in a channel: `all`
  (every message by somebody else, on your badge), `mentions` (the default) or `none` (nothing, not
  even answers in your threads). A channel says your level as `notificationLevel`.

### Fix — 2026-10-12: a mention is what you see as one (D-101 §7, amended)

- A name in a link — a link labelled `@bob`, or `https://medium.com/@bob` — or glued to the end of code or a link no
  longer notifies anybody, and is not highlighted. What notifies, what the composer refuses as a
  broadcast, and what is drawn as a mention are now one reading of the message.

### Fix — 2026-10-12: a tab left open across a deployment offers a reload (D-102)

- When a part of the interface the server no longer has is asked for, a bar says Purlay was updated
  and offers Reload; drafts are kept.
- A language whose words did not arrive is no longer remembered for the next visit, and the page
  stays in the language it had; English not arriving at the start is an error, not a page left on its
  skeleton.

### Testing — 2026-10-12: a visible focus ring is checked, not remembered (`UX.md` §7)

- A browser test tabs through a channel with a thread open, in both themes and at both widths, and
  fails on any stop without a ring at least the focus stroke wide — on the control, or on the box
  that draws it for its field.

### Performance — 2026-10-12: a message is read once a session (D-36)

- Going back to a channel no longer parses its messages again: each body's reading is kept for the
  session, keyed by its text, and bounded.

### Fix — 2026-10-12: a clamped code block shows that there is more (`ARCHITECTURE.md` §8.2)

- A block over twelve lines now fades into its background at the clamp, instead of ending on a cut
  line that looks like the end of the code.

### Feature — 2026-10-12: search, in the client (D-105)

- Search, under Inbox in the sidebar: type, press Enter, and the words are found as typed, ignoring
  case, in every channel you can see — replies and resolved threads too — newest first, each taking you
  to its channel or thread. The words stay in the address, so Back and a reload keep them. Too few
  characters are said in the field and never sent; searching is shown in the field, nothing found says
  where it looked, and a failure keeps your words with a Retry.

### Feature — 2026-10-12: reading the inbox (D-106)

- Opening a notification marks it read; Mark all read reads up to the newest on screen, so what arrives
  after you looked still waits. Both are painted before the server answers; refused, the toast says
  why and the list is read again. The channels' mention badges come down on every device.

### Feature — 2026-10-12: the inbox, in the client (D-106)

- Inbox, under Open questions in the sidebar: what you were told — named, written to, answered in your
  thread, your question resolved — newest first, each saying who and where; unread in full ink, as
  the sidebar says it. Opening one takes you to the message or its thread. A new mention arriving
  while it is open appears in it. Loading, failure (with Retry) and nothing waiting are each said in
  words.

### Fix — 2026-10-12: deleting a message no longer deadlocks with somebody reading (D-106, amended)

- A person reading a channel, or their inbox, at the moment its author deleted a message naming them
  could make one of the two fail. The writers now take their locks in one order.

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
