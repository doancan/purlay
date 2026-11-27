# D-168. A list of messages is one Tab stop; a row's own controls are reached from it

**Context.** The feed had one row in the Tab order (roving focus, `UX.md` §7) and its bar went inert
until its row was the one (D-150), but everything *inside* a message was still a stop: reaction chips,
the thread's line, a code block's Wrap and Copy and the block itself, a diff's view and its region,
links, files, GitHub cards. Measured in the demo channel (2026-10-19), Tab from the header's last
control walked **78 stops** inside eleven messages before reaching the composer — and never the
feed's own row — every row's bar joining in once focus had entered its content. The thread panel had no row in the Tab order at all,
and the root's chips and bar were reached directly. Slack's message list and the WAI-ARIA feed
pattern both make the list one stop. How it is built was decided under the owner's standing
instruction to decide and proceed, and is open to their reversal.

**Decided.**

1. **The list is one stop: its current row.** Tab from what is before the list lands on the row the
   keyboard was last on — or, untouched, the feed's newest and the panel's root — and ↑ ↓ Home End
   move between rows as before (`row-keys.ts`). The panel's list now has its own roving row, as the
   feed has.
2. **Tab from the focused row walks that row's controls, then leaves.** Only the row that holds focus
   has stops inside it, in the order they are drawn — its words' links, its code and diff blocks, its
   files and cards, its chips and thread line, then its bar — and after the last one Tab goes on to
   what follows the list (the composer, or in the panel Resolve and then the reply box). Shift+Tab
   from there comes back to the **row**, not to the last control passed: once focus leaves a row its
   controls are out again. Escape on a row still goes to the composer.
3. **Out of the Tab order means `tabindex="-1"` and nothing else** (`features/messages/row-stops.ts`).
   A row's controls are found by what makes an element a stop, whoever drew it; the `tabindex` each
   had is written down, and given back as it was when focus enters the row. What a component draws or
   changes while its row is out — highlighting, a reaction, a block unclamped — is taken out as it
   arrives, and a change its author makes in that time is what is given back. One row holds focus for
   the document, across the feed and the panel; the document's own focus events say which.
4. **Pointer, touch and screen readers lose nothing.** A control out of the Tab order is still
   clicked, tapped and focused by a script (a menu giving focus back, the image viewer giving it back
   to its thumbnail), and focusing it by any of those ways brings its row in. It stays in the
   accessibility tree with its name: browse mode reads every message's links and buttons and presses
   them, and a links list still holds them all. **Nothing is traded.**
5. **A scrolling block in a row that is out is reached through its row.** axe's
   `scrollable-region-focusable` audits the page as it stands and calls a code block, a diff or a
   table in any other row unreachable. The browser tests' audit (`e2e/fixtures.ts`) checks the path
   instead of excusing the rule: it focuses the block's row and drops the finding only when the block
   is then a stop; anything else stays a violation.

**Rejected.**

- *Enter or F2 into the row, Escape back out* (the grid pattern). It is one stop in a stricter sense,
  but a Tab user who does not know the key never reaches a row's link, the bar 8917edc made reachable
  by Tab would need the key too, and Escape already means "to the composer" on a row (`UX.md` §7).
- *`inert` on every other row's content*, as the bar has. It takes the words out of the accessibility
  tree — browse mode would read only the current message — and out of reach of the pointer.
- *Each control asking whether its row is current* (a context read by chips, links, code blocks…). A
  dozen components today and every new one tomorrow would have to remember it; the first to forget is
  back in the Tab order with nothing to say so.
- *Moving focus by hand on Tab* (a key handler that computes the next stop). It has to know the page's
  order outside the list, and Shift+Tab from the composer arrives before any handler of the list's runs.

**Cost of reversing:** `row-stops.ts` and its one call in `message-row.tsx`, the panel's roving row in
`thread.tsx`, and their tests. No contract, route or stored fact depends on any of it.
