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

### Security

- **Accounts** — Erasing an account now also revokes its GitHub App authorization at GitHub when the saved access token has expired, by renewing it with the saved refresh token first, so the grant no longer stays behind (D-246, D-256)

### Changed

- **Operations** — a workspace export and a person's export now carry which message and channel a file was sent with in `message_attachments.ndjson`, and `attachments.ndjson` no longer has `message_id` and `channel_id` (D-250)
- **Operations** — the upgrade drops `attachments.message_id` and `attachments.channel_id`, and stops with a count, changing nothing, if a sent file's link is missing from chat's table; restore the backup and fix the data before deploying again (D-250)

---
