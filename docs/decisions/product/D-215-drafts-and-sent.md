# D-215. Drafts and sent: a place for what was started, and what went

**Decided (the owner, 2026-10-30).** Fourth of the core features the owner asked for (Slack's "Drafts &
sent").

- **A place on the rail**, after Saved, and a view in the palette: two tabs over one column, in the shape
  the list screens share (D-158).
- **Drafts** are this device's: what the composers already keep in `localStorage` (D-41), listed from
  the entries' names (`listDrafts`), so nothing is stored beside them; only this person's — the key
  carries the user, so another person on the same browser is never listed (#694). Each says its channel
  and whether it is a thread's, opens its composer (which reads it back), and is deleted with Undo. A
  draft written in another tab arrives through the browser's `storage` event. One in a channel the person
  can no longer see is left out: there is nowhere to open it.
- **Sent** is search narrowed to the person — `senderId`, no words, which search already takes as a filter
  that stands alone (D-105) — so what is listed is exactly what they may still see, by the server's one
  rule, newest first, a page at a time. **No endpoint was added.**

**Considered and rejected.** Keeping drafts on the server (a sync and a table for what is a convenience of
one device, D-41); a new "my messages" endpoint (search already answers it, with the visibility it must
have).

**Cost of reversing.** `listDrafts`, the screen and its link, a route, a palette entry and the strings.
