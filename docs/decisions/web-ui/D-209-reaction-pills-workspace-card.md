# D-209. Reactions are soft pills, and the workspace's door is a card over a vertical list — amends D-150, D-206

*Amended by D-347: the workspace's door is one 32px row (mark, name, chevron); the role and member count head the workspace menu.*

*Amended by D-317: the workspace's row lives in a band as tall as the header, without the card's frame and shadow.*

**Decided (the owner, 2026-10-30).** Two surfaces the owner found plain or hard-edged:

- **Reactions.** A chip was a near-square box with a hairline frame, and yours a bright accent frame. It is a
  pill, as Slack's, Discord's and Linear's are: no frame at rest, the surface's raised fill; under the
  pointer the accent's tint — what a click would make it; yours in that tint, in the accent's text and the
  heavier weight. The tooltip that says who is unchanged (D-150).
- **The workspace's door** (D-206) is a card at the head of the sidebar: framed in the navigation's
  hairline and lifted with the card's shadow, the workspace's mark, its name, and under it who the person
  is in it and how many are — *Owner · 4 members* — seen and not heard, so the button's name stays the
  workspace and what it does. Under the pointer its fill takes `nav-selected`, the accent's family; open,
  its frame is the accent. That is the edges' grammar (D-188): hover changes the fill, never the line,
  and an edge that says *selected* is the accent. The count is the People list's query, so no request is
  added.
- **The workspace menu lists the workspaces as radios** — each with its mark, the one the person is in
  checked and in the accent, the others in their own tint — so a screen reader says which is current,
  not only the eye.

**Considered and rejected.** A coloured frame that changes on hover (D-188 refuses a line that changes
with the pointer); opacity colours (`accent-text/40`) for the edge and the chip's ring — they build to a
raw `color-mix`, outside the token vocabulary; a column of workspace tiles on the rail (D-206: a person is
in one workspace at a time).

**Cost of reversing.** Two class strings in `reactions.tsx`; the card and the radios in
`workspace-menu.tsx`, and one string.
