# D-206. The workspace is drawn once, at the head of the sidebar; the dark theme is layered greys, not black — amends D-110, D-184

*Amended by D-318: the dark theme's layered greys are deeper and carry a faint cool tint.*

*Amended by D-317: the rail and the sidebar no longer begin below an empty strip; they start on the header's line.*

*Amended by D-209: Reactions are soft pills, and the workspace's door is a card over a vertical list.*

**Decided (the owner, 2026-10-30).** Signed in, the workspace was drawn twice a hand's width apart: its tile at
the top of the rail and its tile and name at the top of the sidebar, two doors to the same menu. A person is
in one workspace at a time (`UX.md` §2), so the rail's tile was never a column of workspaces to choose from,
only an echo. And the dark theme's rail was pure black (`#000000`) beside a near-black sidebar and content,
which the owner found too black.

- **One door.** The workspace's mark (its initials on the accent), its name and the chevron head the sidebar
  and open the workspace menu, as before; the rail no longer holds the workspace. The rail is the places —
  channels, inbox, open questions, search, saved — and Settings at its foot, its first place level with the
  sidebar's header row. The button is heard as the name and then what it does (*Acme Switch workspace*), so
  what is seen starts what is heard. The prerendered frame drops the rail's accent square with it.
- **Dark is layered dark greys** (in the manner of Apple's elevated dark surfaces and of VS Code's and
  Discord's dark themes): window `#0e0e10`, rail `#131315`, sidebar `#171719`, content `#1a1a1d`, a hovered
  message `#222225`, a hovered row or input `#29292d`, code `#131315`, hairlines `#2e2e33`, navigation hover
  `#26262a` and hairline `#2a2a2e`. Each step is one visible layer: the navigation recedes, the conversation
  comes forward, and no large surface is pure black, which smears on OLED panels and makes light text halo.
  Text, accent and status colours are unchanged; every contrast pair still passes. Midnight and Light are
  unchanged.

**Considered and rejected.** Keeping both doors with different menus, as Slack does — it still draws the
workspace twice for someone in one; removing the name from the sidebar instead — the column would have no
title and the mark alone does not say which workspace; lifting only the rail — a grey rail beside a black
sidebar and content is the two-palette mismatch D-183 removed.

**Cost of reversing.** The tile's markup in `workspace-menu.tsx` and its place in `rail.tsx`, the skeleton's
square, and ten dark values in `tokens.json`; generated files follow.
