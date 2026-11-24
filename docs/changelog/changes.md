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
- **API** — the workspace find says of each source whether it had more than the hits shown, and whether the answer is partial because a source was slow or failed (D-328)
- **Notifications** — a channel or conversation can be muted for 15 minutes, 1 hour, 8 hours, 24 hours or until tomorrow morning; the bell says "Muted until 14:00", and the mute ends by itself on every device at once (D-329)
- **Profile** — a status line can clear itself after 30 minutes, 1 hour, 4 hours, today or this week, and carry one emoji; it disappears on every device at its end, and native apps can now set it (D-330)

### Changed

- **Release notes** — the fireworks that greet a release are smaller and smoother: comets rise and open into rings of two-coloured sparks, over about four and a half seconds
- **Sign-in and errors** — the sign-in, invitation, setup, letter and two-factor screens, the missing page and the failure screen stand on one shared canvas, and the last two are framed in the same card
- **Settings** — the settings navigation gives the authenticator, people access, roles and server pages marks of their own
- **Administration** — a scheduled job's state is a tinted mark with its words (up to date, never succeeded, needs attention), and *Grant administrator access* says why when it is unavailable
- **Settings** — the access pages' filter bars line up with their cards, and an empty list says "Nothing to show yet" instead of suggesting a search that was never made
- **Account menu** — the menu under your name now has Theme and Language, each a short list with the one in use checked, applied as you choose (D-331)
- **Release notes** — the window no longer shows a count beside each category or a "View on GitHub" button
- **Shell** — the icon rail is drawn in the full navigation ink and its current place in the accent; its inbox dot is red and its count blue; the workspace switcher is a white card with its own line at rest, a tinted fill on hover and the accent line while its menu is open, with room around it; the Jump-to field is a white box that tints under the pointer
- **Composer** — the message box has one fine, light grey edge that firms a hair under the pointer and turns one step firmer grey when you click into it (no blue edge, no thicker ring), and its placeholder is a lighter grey
- **Accessibility** — the keyboard focus ring is drawn inward in the rail, the sidebar and the lists of Settings and the console, so it never lands on the row beside it
- **Notifications** — a toast (Link copied, Scheduled message cancelled…) rises above the sidebar's account row instead of covering the person's name (D-322)
- **Messages** — a mention of you is a pale tint behind the accent text instead of a solid blue chip, so a feed with several of them is no longer led by them (D-321)
- **Search** — the results say how many were found ("2 results", or "20 results so far" while there is more), announced to a screen reader (D-320)
- **Reminders and Send later** — the menus that offer "In 20 minutes", "In 1 hour" and "In 3 hours" now say the clock time each comes to, as "Tomorrow at 09:00" already did (D-319)
- **Profile** — an empty Time zone field shows the zone this device would fill in, so the button beside it says what it does
- **Administration** — the server console's navigation is Settings' navigation: a header on the same line, a mark beside each section, an arrow on the way back, Sign out at the foot, and it stays in place while a long page scrolls
- **Settings and Administration** — a button under a field or a value (Save settings, Refresh, Enable on this server, Send test email) keeps its own width instead of filling the card

### Fixed

- **Accessibility** — the keyboard focus ring is the ring's blue from its first frame; it no longer fades in from the text's own colour (near-black in the light theme, near-white in the dark), which flashed the wrong colour at every Tab stop
- **Errors** — the "Nothing here" and "Something went wrong" pages sit on the app's own background instead of a lighter one
- **Channels** — while other people are writing, the channel list is no longer asked for again at every unread count it hears while it loads; it loads once and is read once more, so a reloaded channel no longer waits on it

---
