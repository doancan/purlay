# D-162. One busy thread is one row in the inbox, named by its root — lifts D-153's *Rejected*

**Context.** The notifications audit (B4, C6) found one busy thread turning the inbox into
"Alice Chen replied in your thread · api" six times over, none of which said *which* thread — and every
reply said "your thread", even to somebody who had only answered in it. D-153 refused grouping by
thread because a notification carried the reply and not its root, so a group could not name what it
gathered without a read per row.

**Decided.**

1. **The contract carries the root in brief.** A reply's `Notification` has
   `thread: { rootId, excerpt, authorId }` (`NotificationThread`), null for anything that is not a
   reply. `excerpt` is the root's text as every excerpt is (#651) — plain, on one line — cut to
   `THREAD_EXCERPT_MAX` (120) characters with an ellipsis, and null when the root is deleted (D-9: its
   words are not shown anywhere) or says nothing in words. It is read by joining the root into the
   inbox's own statement: a page costs the same whatever threads it names, and the root is in the
   reply's channel, so the visibility the inbox already applies (D-106 §2) is the root's.
2. **Whose thread.** `authorId === me` is *replied in your thread*; anything else is *replied in a
   thread you're in* (D-29 tells both). The inbox, a background tab's notice (D-148) and a push
   (D-126) say it alike; a push reads the root's author in its own statement.
3. **One thread's replies of one day are one row** (`features/inbox/group.ts`). Only `thread_reply` is
   gathered — a mention, a direct message or a resolution is about the person and stands alone, even
   in a thread. The row sits where its newest member sat, so nothing above it moves; it says how many
   (*3 new replies in “…”*, without *new* once all are read), the newest replier's avatar, who
   (*Alice, Bob and 1 other*), the newest time and words, and is unread while any member is. Opening
   it or its Mark read reads every member that waits, by id. A single reply names its thread too:
   *In “…”* above its words.

**Rejected.** *Gathering across days* — a row in Today would carry yesterday's replies under today's
time, and Earlier would hold one row spanning a week. *Gathering mentions in a thread with its
replies* — a mention is the one notification that is about the person by name; folding it under
"3 new replies" hides it. *Fetching roots in the client* — a read per thread, which is exactly the
N+1 D-153 refused; or the whole root as a `Message`, which ships what a row never draws. *Counting
only the unread members* in the headline — "1 new reply" over three names would contradict itself.

**Cost of reversing:** the `thread` field and `NotificationThread`, the join in `inboxOf`, the
root's author in the push sender's statement, `group.ts`, the row's thread line, and their tests.
No schema or stored value depends on it.
