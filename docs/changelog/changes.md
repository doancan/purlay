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

- **Operations** — set a minimum iOS app version and wire contract independently of macOS, with an optional HTTPS update address (D-340)
- **Messages** — workspace owners and admins can turn off Urgent delivery in General settings (D-337)

### Changed

- **Interface** — every grey, in the light and dark themes, is one neutral family on even steps, so the navigation, the page and a segmented control read apart (D-343)
- **Interface** — keyboard shortcuts are shown as keys the way the keyboard prints them: ⌘ ⇧ ⌥ on a Mac, Ctrl, Shift and Alt elsewhere (D-344)
- **Documentation** — the decision record is one file per decision, indexed by category, with `bun run decision:new` to start the next one (D-345)

### Fixed

- **Sign-in** — native sign-in in the browser names Purlay for Mac or Purlay for iOS (D-191)
- **Notifications** — the device switch becomes available again when you restore browser permission and return to Purlay (D-126)

---
