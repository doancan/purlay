# D-207. The account door reads as a menu, the menu opens with who you are, and "you are here" has one tone — amends D-124

*Amended by D-318: the focus ring and the composer's edge are a moderate blue in both themes.*

**Decided (the owner, 2026-10-30).** Measured against the account switchers of Linear, Vercel, GitHub and
Slack, the sidebar's foot fell short in three ways, and the place you are was drawn two ways:

- **The door.** Its trailing glyph was the sliders — the same glyph as **Sidebar options** beside the
  workspace's name — so it read as a setting, not a menu. It is the up-and-down chevron the workspace's door
  has, and the avatar carries your own online dot (D-136), as your row in People does; *online* is said to a
  screen reader after the name.
- **Who you are.** The menu opens with a card — the avatar, the name, the handle — as every one of those
  apps does, so the menu says whose it is before what it offers.
- **Deep Work's whiles are a submenu.** Four of the menu's seven items were the whiles; they are one item,
  **Deep Work ▸**, which opens them (ArrowRight or Enter). While it is on, how long is left and **End Deep
  Work** stay in the menu itself, one step away. The palette still offers every while directly.
- **One selected tone.** The channel you are in was filled with the accent, the rail's current place with
  the hover's grey, Settings' current section with the accent again. All three are now `nav-selected` — a
  quiet tint of the accent's family, distinct from hover in every theme — with the text in `nav-ink` and
  the glyph in `accent-text`. The loudest mark in the column is now a mention's badge, which is what needs
  you, not the row you already know you are in. The light theme's `accent-subtle` was not reused: on the
  light navigation it cannot be told from the column (1.02:1). Every pair drawn on it is in the contrast
  gate (`pairs.ts`).

- **The composer's edge.** Focused, the composer was framed in the focus ring's colour, which in the dark
  themes is the bright `accent-text` — held for as long as somebody types, it was the brightest thing on
  the screen. It has its own token, `composer-edge`: the focus ring's blue in the light theme, a calm
  slate-blue in Dark and an indigo in Midnight, each in the contrast gate as a control's boundary. The
  focus ring itself is unchanged everywhere else.

**Considered and rejected.** Keeping the accent fill (Slack's) — it competes with the badges and, in the dark
themes, is the brightest thing on the screen; the hover's grey for selection — hover and selection then
cannot be told apart; a separate Deep Work button beside the account — one more control in the corner for
something the palette and the menu both reach.

**Cost of reversing.** One token in `tokens.json` and `pairs.ts`; four class strings (`channel-row.tsx`,
`rail-item.tsx`, `settings-nav.tsx`, `group-face.tsx`); the trigger and the submenu in `account-menu.tsx`
and `MenuSub` in `ui/menu.tsx`.
