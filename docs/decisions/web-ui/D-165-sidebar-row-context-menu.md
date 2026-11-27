# D-165. A sidebar row has a context menu: the row's own actions, without opening it

**Context.** Everything a person could do to a channel from the sidebar meant opening it first: star
it in its header, set its level in the header's bell, leave it from its details' Danger zone, copy its
address from the browser's bar. Slack and Linear both answer a right click on a sidebar row with that
row's actions, and the owner asked for the same (2026-10-19). How it is built was decided under their
standing instruction to decide and proceed, and is open to their reversal.

**Decided.**

1. **What it holds is the row's, and only what applies and the person may do.** *Mark as read* while
   the row is unread; *Star* / *Unstar* for a channel (a conversation has none, D-132); the
   notification level as the header's three choices (D-107), one radio group, not a submenu; *Copy
   link*, the channel's whole address; *Channel details…* for a channel and *Conversation details…*
   for a group (a conversation of two has no details, `UX.md` §2); *Leave channel…* for a public or a
   private channel, never for a conversation, whose people never change (D-127). Each reuses what the
   header and the details already do — `useStar`, `useChooseLevel`, `actions.leaveChannel`, the same
   strings and the same refusal for the last member of a private channel — and calls only endpoints
   that already exist.
2. **Mark as read reads the feed, as reaching its bottom does.** `PUT …/read` with the channel's newest
   root, asked for by `GET …/messages?limit=1` because the cache's feed may not be loaded or current.
   A reply still waiting in a thread stays unread (D-147): the row is painted read at once and then
   shows what the server counted, which may be *still unread*, for that reason. Reading every waiting
   notification as well would make a press in the sidebar read answers nobody looked at — the failure
   D-147 exists to prevent.
3. **Leave asks first, in a dialog** (the menu has no room for the details' in-place question), says
   what leaving costs for a public and for a private channel, and says a refusal inside the dialog.
   Done, a toast says so; the person is taken to the workspace only when they left the channel they
   were reading.
4. **Opened the platform's three ways.** A right click opens it at the pointer; Shift+F10 or the
   ContextMenu key on a focused row opens it under the row (caught on `keydown`, so the menu does not
   land wherever a browser puts a keyboard's `contextmenu`); a finger held still for 500 ms opens it
   at the finger, and the tap that ends the press does not follow the link. Escape gives focus back
   to the row, and a dialog an item opened gives it back there too.
5. **The existing dropdown, anchored to a point** — `AnchoredMenu` in `ui/menu.tsx`, Radix's dropdown
   opened from an invisible box at the pointer or around the row, drawn on the page's body. Its items,
   keys, look and `min-w-sidebar` are the account menu's, because they are the same component.
6. **Its body is deferred** (`app/deferred.ts`, D-49): the door in every row costs the first page
   0.34 KB gzipped; drawn statically, the menu measured 1.87 KB, more than half the room the budget
   had left. The chunk is fetched when a pointer enters a row or the keyboard reaches one; a chunk that
   does not arrive is said in a toast and asked for again next time.

**Rejected.**

- *`@radix-ui/react-context-menu`.* It is the primitive for this, and it is one more runtime
  dependency (§1.12) for what the dropdown already does once it is anchored; its trigger must also
  wrap the row in the first page's code, so the menu could not be deferred.
- *The row itself as the dropdown's trigger.* A trigger opens on a press and on Enter, which are the
  link's; and every row would be announced as a menu button.
- *A More (`…`) button revealed on hover*, as Slack also draws. A control that appears only under a
  pointer is one a newcomer never finds, the reason the section headings' buttons are always shown
  (`UX.md` §2); the context menu is the desktop's convention and adds nothing to the row's look.
- *The level as a submenu.* A second primitive (`MenuSub`) for three choices that fit in the menu.

**Cost of reversing:** `features/sidebar/row-menu.tsx` and `row-menu-body.tsx`, `AnchoredMenu`, the
row's handlers, the export in `app/deferred.ts`, the strings and their tests. No contract, route or
stored fact depends on any of it.
