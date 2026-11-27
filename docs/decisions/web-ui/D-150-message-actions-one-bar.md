# D-150. A message's actions: one bar, in the empty corner of its own row

*Amended by D-209: Reactions are soft pills, and the workspace's door is a card over a vertical list.*

**Amends D-119 §6 and `UX.md` §3.** The owner's audit of the message row (2026-10-19): the bar hung
above the bubble (`-top-8`, #653) and covered the author's name and the last line or reaction of the
row above; a focused row and a hovered row each drew a bar; React and Reply had no tooltip, Save and
Pin only a slow native one; only one's own message had More; nothing said who reacted; the quick
reactions were a seven-line text menu that opened over the composer; "edited" and "Pinned" ran
together; on a phone Reply stood taller than the rest.

**Decided.**

1. **The bar sits on its own row's top edge, in the corner the message is not in** — the right for
   everyone else's, the left for your own — the way Slack and Linear put it top-right, mirrored for
   the second edge D-119 drew. *Amended 2026-10-26 by D-187:* there is one edge now, so it is the right for every message. It starts at the row's top and never reaches above it, so nothing of
   another message is ever under it, on any window; a message under a name has a band above its
   bubble and the bar stays inside it. A *grouped* message has no band: there a wide bubble's first
   line may lose its corner to its own bar while that row is the one. Accepted: the alternatives
   cover another message (a bar hung into the row above) or move the row (a band opened on hover).
2. **One bar on the page.** Which row shows it is one fact for the document
   (`features/messages/active-row.ts`), read by every row in the feed and the thread panel: the row
   under the pointer, or the focused row while the keyboard is the last thing used; a row whose menu
   is open keeps it; on a phone, the row tapped. A row reads only whether it is the one, so a move
   re-renders two rows.
3. **Its controls are one square, on every window** (`IconButton` size `bar`, `h-control`): React ·
   Reply · Save · Pin · More, each with the product's tooltip and its key where it has one (Reply `R`;
   Edit `E` in More). A finger-tall (`size-touch`) control made the bar taller than the band and it
   covered the name on a phone; 28px is above the 24px WCAG 2.5.8 minimum, and the menus a control
   opens keep their finger-tall items. The bar is the float surface: `surface-100`, a hairline,
   `shadow-float`.
4. **More is on every message.** Copy text (the words as written, through the content ports' clipboard),
   Save and Pin again for whoever looks there, then Edit and Delete on one's own. An owner or an admin
   gets Delete on anybody's — the API already allows it and puts it on the audit trail (D-103 §7,
   D-26) — and the question before it says so. **Copy link** is first in More, the message's own address (D-149): the two were built side by side and met at that one item.
5. **A reaction chip says who** in its tooltip: "You, Alice and Bob reacted with 👍", the person first
   as You, past three two names and "N others" — names from the workspace's members as the screen
   already read them, joined by `Intl.ListFormat` in the interface's language.
6. **The quick reactions are one row of tiles** (`MenuTiles`, `MenuTile`: checkbox items, so one
   already yours says so in `aria-checked` and not only by its tint; ←/→ move along the row), the
   name of the tile reached written under it. Still the seven: `UX.md` §10 allows a recent/frequent
   row, which needs a record of use the client does not keep, and seven is what fits one row on a
   phone. The picker and More open upward and are held inside the message list
   (`data-message-list`, Radix's collision boundary), so neither covers the composer.
7. **Edited and Pinned are one line under the words**, `gap-3` apart, not drawn when neither applies.

**Rejected.**

- *The bar hung above the row*, as #653 had it and Slack does: it covers the row above whenever that
  row's content reaches the corner — always true of your own messages, which sit on the right.
- *Top-right for every row*, your own included: your own bubble *is* the top-right corner, so the bar
  covered its time or its words; the left corner of your own row is the one that is always empty.
- *Each row deciding for itself* with `:hover` and `:focus-within`: that is how two bars were drawn.
- *A full emoji picker*: `UX.md` §10.

**Cost of reversing:** `message-actions.tsx`, `active-row.ts`, the tiles in `ui/menu.tsx`, the `bar`
size, and the chip's tooltip; no contract, route or stored fact depends on any of it.
