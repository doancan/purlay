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

### Changed

- **Search** — the Search button is the screen's primary action, and Advanced filters, Search operators and Saved searches open with the product's own chevron, left-aligned like the others, instead of the browser's triangle or a centred label
- **Inbox** — the read-state filter (All, Unread) sits apart from the kinds (All, Mentions, Direct, Threads, Updates), so the second "All" is no longer read as a sixth kind
- **Shell** — the rail, the sidebar's workspace row and the screen's header now start on one line and end on the same hairline, where the first two began below an empty 28px strip kept for a desktop shell (D-317)
- **Settings** — the workspace pages of the menu each carry their own mark (shield, link, table, sliders, group) where four of them shared one key and three shared one pair of people
- **Appearance** — the dark theme is a near-black with a faint cool tint instead of charcoal grey, and the focus ring and the composer's edge are one moderate blue in both themes, neither loud nor dull (D-318)

### Fixed

- **Open questions** — a question that has waited one day says "Waiting 1 day" instead of "Waiting 1 days"

---
