# D-345. Interface primitives after the design audit: pressed states, nested segment radii, tooltips, submenus, list skeletons and error states

**Decided (the owner, 2026-11-26).** The owner asked for every screen and component to be brought to the standard of
the best SaaS products, each area by one design expert and checked by an independent reviewer. The shared primitives
in `apps/web/src/ui` came first, because every screen is built from them; what they now promise is recorded here so a
later screen follows it rather than re-deciding it.

**What changed.**

- **Pressed.** `Button` and `IconButton` have a pressed state one step firmer than hover: a neutral fill presses to the
  `border-subtle` colour, a step past `surface-200` and `nav-hover` in every theme; a coloured fill darkens one step
  more than its hover. A toggled toolbar button (`aria-pressed`) reads as on with `surface-200` and the primary ink.
- **Segments.** A segmented control's segments and its sliding mark are `rounded-sm` inside a `rounded-lg` track with
  `p-1`, so the radii nest (4 + 4 = 8). In the dark theme the chosen chip carries a hairline, as it read as a hole in
  the `surface-200` rail without one. On a phone a `ListFilter` is the column's width and hides its glyphs; its choices
  share the width equally, the chosen one widening only as far as its whole word needs, an unchosen word too long for
  its share is cut short, and every choice keeps its whole word as its name.
- **Tooltips** do not open while their trigger's menu is open or behind an open dialog, and close on every press of
  their trigger, also one whose press a menu cancels: a tip left open above a menu, or opened as focus came back to a
  trigger, became the top layer and took the next Escape.
- **Submenus** open beside their menu when a menu's width fits on that side, and otherwise over their own menu just
  under the item that opened them: placed by the room measured, not by the narrow breakpoint, so `ui` does not depend
  on `features`.
- **Loading and errors in a list.** `ListSkeleton` (in `ui/list-column`) is a card of rows shaped like the loaded ones,
  used by every list screen. `ErrorState` has a `framed` form for list screens, as `GlyphEmptyState` has; unframed, it
  has no side inset of its own and the panel that holds it gives it its content's inset.
- **Smaller pieces.** A `Skeleton`'s caller may size and round it. The dialog's close button sits on the title's line.
  Menu items are `rounded-lg` inside the menu's corner and padding. A disabled control does not react to hover. Date
  pickers write weekdays in sentence case. The key-hint row is 32px with its hairline: the spacing scale has no 36px
  step. A 20px avatar shows one initial, as two wide letters do not fit.

**Rejected.**

- New colour tokens for the pressed state: the ramp already has the next step (D-342), and a new token per state is a
  palette nobody can hold in their head.
- A `rounded-xl` track for segments: it is the radius of cards inside a message, and segments are controls.
- Scrolling a phone's segmented control sideways: a choice that cannot be seen is a choice that is not offered.
- Sharing a phone's segment width by word length: it cut the chosen word short.

**Cost of reversing.** Low: each is one primitive in `apps/web/src/ui` with its tests; the screens follow the primitive.
