# D-161. A thread can be followed, and let go — amends D-29

**Context.** A notifications audit (B5) found no way out of a thread. Replying once made a person one
of the up to fifty earlier repliers every later reply tells (D-29, D-99 §2): a drive-by "+1" in a long
incident thread meant every reply after it, for good. The only exit was setting the whole channel to
*Nothing* (D-107), which silences everything else in it too. And the other way round, somebody who
wanted to watch a question they had not answered had no way in short of writing in it. Slack and
Linear both let a person follow and unfollow. Decided in the owner's standing instruction to decide
and proceed, and open to their reversal.

**Decided.**

1. **Follow is per person, per thread.** Without a choice, participation decides, as D-29 always has:
   the root's author and whoever has a live reply follow it, nobody else does. A choice, either way, is
   a `thread_follows` row (`SCHEMA.md` §7.7), and it stands until the person makes another.
2. **Replying after letting a thread go does not follow it again.** Slack re-follows on reply; here
   the one thing the person said about this thread was *stop*, and a reply — often the last word,
   "thanks", "shipped" — is not a request to be interrupted again. Quiet is the product (D-12): of the
   two mistakes, the one that is noisy behind the person's back is the worse, because they cannot see
   it happen; the quiet one shows on the panel's toggle, one press from undone.
3. **What a choice moves is only the thread's own reasons to tell somebody.** Let go: no
   `thread_reply`, and no `channel_message` for a reply in that thread at level `all` — the thread is
   more specific than the channel. Followed: `thread_reply` for each reply, under the same conditions
   as a participant (can still see the channel, D-34; the 50 most recent followers by choice, beside
   the 50 most recent repliers, the bound D-99 §2 puts on what one reply writes). A person who let it
   go does not take a replier's place under that bound. **A mention still arrives**, and a direct
   message is still told: both are addressed to the person, not to the thread. A channel at `none`
   stays silent for a thread followed (D-107 §1: nothing at all). Deep Work, the counters, `NEEDS_YOU`
   and D-147's reading are unchanged; not retroactive.
4. **`GET` and `PUT /api/messages/:messageId/follow`** (`ThreadFollow`, `SetThreadFollowRequest`).
   Anybody who can see the root may — a member of the channel or not: it is the person's own, as a
   save is (D-156 §3); a reply has no thread, `404` as `GET …/thread` answers. Idempotent; told to
   nobody, and not yet to the caller's other devices, which read it when they open the thread (as
   D-107 left the level).
5. **Its own endpoint, not a field on the thread's page.** `ThreadPage` is a page of messages the
   socket writes into for everyone in the room; a per-person fact on it would need one page to be the
   one that says it, and a reply arriving would have to know which. The panel reads it beside the
   replies, under its own key, and reads it again when the person's own reply lands — answering a
   thread one had made no choice about follows it.
6. **The control** is in the thread panel's header (`UX.md` §4.2): **Follow**, a toggle with one name,
   its tooltip in Slack's words. Not in a root's More menu: the feed's messages do not carry the state,
   so the menu would have to ask for it on every opening; the panel is where the thread is.

**Rejected.** *Re-follow on reply* (Slack) — see 2. *A `mute` state only, no explicit follow* — the
person who wants to watch a question without writing "+1" in it is the other half of the audit's
finding. *Muting the thread in the inbox too, so its old notifications vanish* — what was told stays
told (D-107 §3); the badge comes down by reading. *Following everything one can see by default* — the
broadcast D-12 exists to prevent.

**Accepted.** The panel says *following* for a replier older than the 50 most recent, whom a reply does
not tell (D-99 §2's bound); the state is the person's relation to the thread, the bound is what one
reply writes.

**Cost of reversing:** `thread_follows` (migration `0044`), `features/chat/messages/follow.ts`, the choices
read in `delivery.ts`, the two routes and their contract, the panel's `follow-toggle.tsx`, and their
tests.
