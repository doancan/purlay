# D-166. A search can be narrowed to who wrote it

**Context.** `PRD.md` §4.6 narrowed a search to a workspace and a channel. "What did Ayşe say about the
retry budget?" was answered by reading every result for her name. The owner asked for a *From* beside
*Where* (2026-10-19); how it is built was decided under their standing instruction to decide and
proceed, and is open to their reversal.

**Decided.**

1. **`senderId` on `GET …/search`, a filter on the visible set, never a way round it.** It narrows the
   channels the caller can see (D-105 §4) to one person's words, in the same query; it never widens
   them. An author's words in a private channel or a conversation the caller is not in stay unseen.
2. **A person who wrote nothing there is an empty page, not a 404.** `channelId` names a resource and
   is refused when it cannot be seen (D-105); `senderId` names nothing the caller is shown: a person of
   another workspace, one who left, and an id nobody has are answered alike, and what is answered comes
   only from the caller's own channels — so the empty page confirms nothing. Somebody who left is still
   found by what they wrote while they were here (D-152), which a 404 for a non-member would have lost.
3. **No new index.** `idx_messages_sender` already exists (0005). Measured on a million messages in
   twenty workspaces (2026-10-19, PostgreSQL 18.6): without `senderId` the plan is unchanged, a bitmap
   scan of `idx_messages_search_folded`; with it, for a person of five thousand messages, a `BitmapAnd`
   of `idx_messages_sender`, the workspace and the channels (13–21 ms); for a person who wrote all fifty
   thousand of a workspace's messages, the trigram index again (2 ms). No sequential scan in any.
4. **On the screen: *From*, beside *Where*, kept in the address as `?from=`** with the person's id, so
   Back and a shared link keep it as they keep `?q=` and `?in=`. *Anyone* first, then the person
   themself, then everybody by name, each with their avatar — the workspace's people the sidebar lists.
   Somebody the address names who is no longer listed is still searched for and shown as *Someone*.
   The palette's *Search messages for "…"* opens a search of the words alone (D-157).
5. **The menu's radio items, not the native select *Where* uses.** A native select cannot draw a face,
   and a face is how a person is found in a list of thirty; the menu is already on the first page (the
   account menu), so it costs no dependency and little weight, and its keys — arrows, typing a name,
   Escape — are a picker's. Typing reaches a name by its words, not by its avatar's letters.

**Rejected.**

- *`?from=` as a username.* The handle is display-only and follows a rename on GitHub (D-38), so a
  shared link would come to name somebody else or nobody; the id is what the API takes.
- *A 404 for a person who is not a member.* It would hide what a person who left wrote, and a 404 on a
  filter says nothing a 404 on the workspace does not already.
- *A combined `(workspace_id, sender_id)` index.* The planner reached a cheap plan with the indexes
  there are in every case measured; an index is paid on every send (D-10).

**Cost of reversing:** `senderId` in `SearchQuery`, the route's parameter list and one `where` in
`features/chat/search/search.ts`; `?from=`, `features/search/author-picker.tsx` and the strings on the web.
