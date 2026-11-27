# D-135. A message's earlier versions — #82

**Context.** D-103 §2 kept no history in Phase 1 and said so; Phase 2 lists edit history (`PRD.md` §4).
The record is trusted because an edit can be seen for what it changed — D-103 §1 gave the author no
window on that promise.

**Decision.**
1. **Every edit keeps the words it replaced** as a version of the message (`message_versions`, 0034),
   written in the edit's transaction under the row lock the edit already takes, at the edit's one
   instant — the message's `edited_at` and the version's `replaced_at` are the same. The same words
   again are not an edit (D-103 §6) and keep nothing; A → B → A keeps both changes.
2. **Read by anybody who can read the message** — the history is the channel's as the message is —
   newest first, a page at a time (`Page`, `PAGE_LIMIT`), keyset on each version's UUIDv7 id. The
   message itself is the current version. **The author may remove one version**: the remedy for words
   edited out that should never be read — a token pasted and taken back — which would otherwise stay
   in the history for the whole channel. The edit box says so, in both languages. Accepted: an author
   who can no longer see the message — they left the private channel, or the workspace — cannot remove
   a version of it; an admin can delete the whole message, which removes them all.
3. **Bounded:** the latest `MESSAGE_VERSIONS_KEPT` (100) of a message are kept; an edit past it lets
   the oldest go. Accepted: a message edited more than a hundred times does not show its first words.
4. **Deleting a message removes its versions**, with its words, mentions and pin
   (`messages/delete.ts`): a tombstone hides what was said, and its history must not show it. D-9 is
   about the row and its thread surviving, which they do. Erasure (#83) tombstones bodies rather than
   deleting rows, so it removes versions too, and the cascade alone would not.
5. **Words only**: a version is never searched and never parsed for mentions (D-103 §5 told whom an
   edit named). A client's open history is read again when `MESSAGE_REVISED` arrives — an edit adds a
   version, a delete takes them all — and when `MESSAGE_VERSIONS_UPDATED` does: a version removed, on
   the channel's topic, so words taken out leave every screen that shows them.
6. **Messages edited before this** have no versions, nor has a message whose author removed every
   one: its history says there are none — not kept, or removed. A message deleted while its history is
   open says so there, rather than the dialog vanishing under the person.

**Rejected.** *A version per message state (`state_version`)* — it also counts reactions, threads and
deletes, so its numbers have gaps and say nothing about words. *Refusing edits past the bound* — a
lock on one's own words, which D-103 §1 rejected. *Only an admin removes a version* — the person who
pasted the secret is the one who knows it is there, and should not have to ask.

**Cost of reversing:** migration 0034, two routes, the history dialog.
