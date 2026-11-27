# D-153. The inbox is for triage: an unread view, days, and reading without going

**Context.** The inbox was one flat list, hung from the left at 760px with half the window empty, with
"Mark all read" and "Load more" and nothing else: no way to see only what waits, nothing to tell this
morning from last week, and a row could only be read by opening it. The notifications audit
(2026-10-19) compared it with Slack's Activity and Linear's inbox.

**Decided.**

1. **All and Unread.** Unread is `GET /api/notifications?unreadOnly=true` (D-106 already serves it),
   kept under the same cache prefix as All (`['notifications', workspaceId, 'unread']`), so every
   refresh the inbox already hears refreshes both.
2. **A row read stays where it is.** Marked read in the Unread view, it turns muted and stays until the
   person looks again; dropping it at once would move the next row under the pointer that was aiming at
   it.
3. **Today and Earlier**, by the person's own day, each a card — the column centred like the feed's
   (D-119), not hung from the left.
4. **Mark read on the row**, beside its button rather than inside it, so each is its own control for a
   keyboard and a screen reader.

**Rejected.** *Filtering the loaded pages in the client* — an unread row older than what is loaded would
not be found, and "Load more" could add pages that show nothing. *Grouping by thread* — the row carries
the reply, not its root, so a group could not name what it groups without another read per row; left
for when the contract carries the root's first line. *(Lifted 2026-10-19 by D-162: it now does.)* *Archive and snooze* — PRD §6 refuses reminders,
and an archive is a second "read".

**Cost of reversing:** the filter control, the sections and the per-row button in `inbox-screen.tsx`.
