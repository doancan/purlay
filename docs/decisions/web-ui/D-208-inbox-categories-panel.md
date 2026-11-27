# D-208. The inbox has categories and a panel, and reading in it is never painted back — builds on D-106, D-153, D-162

*Amended 2026-11-26 (the owner): the panel is gone. The rail's Inbox is the link to the page on every width; a popover of
the newest ten was a second, smaller inbox in front of the page, which already has the categories, the reading and Mark
all read. `inbox-panel.tsx`, `useNotificationsPanel`, `PANEL_LIMIT`, the panel's key and the `size-inbox-panel` token
went with it; the categories, `read.ts` and its hardening stay, and the hardening's tests moved to the page's.*

**Decided (the owner, 2026-10-30).** The inbox was a page only, with All and Unread. The owner asked for
the notifications to be split into categories, for a bounded view with a way to all of it, and for the
live path to be hardened.

- **Categories**, as server queries (D-153: never a filter over loaded pages): **All**, **Mentions**
  (`mention`), **Direct** (`direct_message`), **Threads** (`thread_reply` and `thread_resolved`). They
  are sent as the `types` the API already takes (D-106 #787), so no endpoint or schema changed. A
  channel's every message (D-107) is the weakest reason and stays in All. The page keeps the category in
  its address (`?category=`), so a reload, Back and the panel's See all agree.
- **The panel.** The rail's Inbox opens, on a wide window, a popover of the newest ten of a category
  (`PANEL_LIMIT`), and **See all** opens the page on the same category. It has no count (D-110). It is a
  new UI primitive's first use: `@radix-ui/react-popover`, the Radix family the app already uses; every
  package it needs was already in the lockfile at the same versions, so it adds only its own code.
  Narrow, the rail lives in the navigation's overlay and the Inbox stays the link to the page.
- **Live, and cheap.** The panel reads one page, so a `NOTIFICATIONS_UPDATED` frame costs one request of
  ten rows while it is open and none while it is closed, where the page's infinite list reads every
  page it has loaded again.
- **Reading, hardened.** One module (`read.ts`) reads for the page and the panel and paints every cached
  view of the inbox, both shapes. An answer already on its way when the person reads is cancelled before
  the paint, and the paint is laid again when the server answers, so a frame's read-again that landed on
  the server's old state cannot draw the row unread under the pointer. Reading by ids is sent in chunks
  of the server's page limit, so a thread that gathered more replies than that is not refused. In a
  category, Mark all read reads the rows shown, never "up to the newest", which is the whole inbox's.

**Considered and rejected.** Counting per category (a second badge, D-110); filtering the loaded pages
by type in the client (D-153); a panel on narrow windows (a popover over an overlay); a keyboard shortcut
for the page (`Ctrl+Shift+I` opens the browser's developer tools on Windows and Linux).

**Accepted, not yet.** The late-commit window D-106 accepted is unchanged: ordering the inbox by commit
order needs a server key, not a client change.

**Cost of reversing.** `inbox-panel.tsx` and the Inbox link's two shapes; the categories module and
its strings; `useNotificationsPanel` and the keys' category segment; two size tokens. `read.ts` is worth
keeping either way.
