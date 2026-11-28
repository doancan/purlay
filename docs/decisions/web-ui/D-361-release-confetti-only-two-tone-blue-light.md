# D-361. Release confetti only, a two-tone blue light navigation, and no row for yourself under People — amends D-343, D-261, D-247

**Decided (the owner, 2026-11-28).** Three things seen in the running client. The fireworks were not liked, and a 🎉 in
a chat message was setting them off. The light navigation had gone grey (D-343) and no longer looked like the product the
owner knew: they wanted the earlier two cool blue tones back, the rail the deeper and the sidebar the lighter. And the
People section listed the person themself, a row they never need: who you are is the account menu at the foot.

**What changed.**

- **Confetti, release only.** The fireworks are gone. Opening a release's notes throws confetti from the two bottom
  corners of the window, one run of `duration-celebrate` (3600ms), not drawn under reduced motion, hidden from assistive
  technology, taking no pointer. Sending 🎉, or reacting with it, sets off nothing. `duration-celebrate-grand` and the
  three `size-spark-*` tokens are removed; the gate that lets a celebration run past 200ms stays, for the one that is left.
- **Light navigation, blue again.** `nav-rail` #e5e9f4, `nav-surface` #f3f5fa, `nav-hover` #d9deef, `nav-selected`
  #d2defb, `nav-border` #ccd2e4, `nav-ink` #1b1c2e, `nav-ink-muted` #4c5072. These are the values before D-343, calibrated
  a little: the separation between rail, sidebar, hover and selected rows is one step stronger, and the secondary ink
  darker (7.1:1 on the sidebar), the hue untouched. The selected tone is the lightest that keeps the focus ring at 3:1.
  The dark and Midnight themes, and every other grey D-343 set, are unchanged.
- **No bar on the open row.** The vertical accent bar at the edge of the place you are in (sidebar, rail, All unreads,
  Followed) is gone; the selected tone, the semibold label and the accent glyph say where you are, as the settings column already did.
- **People without yourself.** The section lists everyone else. The conversation with yourself stays one `⌘K` away. A
  workspace with nobody else says so under an empty list.
- **The composer.** The hint in an empty field is its own token, `ink-placeholder`, dimmer than typed text and still 4.5:1
  on the field's grounds. The Markdown toggle is an icon alone (a file with code brackets, named and explained in its tooltip), at the row's end. Inline code is `</>` and
  labelled so, the code block keeps its boxed glyph, so the two no longer read as one. The edit hint prints its keys as caps,
  ⌘ ⇧ ↵ on a Mac.

**Rejected.** Keeping a small firework for 🎉 messages: the owner asked for the celebration in one place only. Placing a
placeholder at `ink-subtle` with opacity: it would hide the contrast from the audit; a token is judged by it.

**Cost of reversing.** Low. The values are in `packages/tokens/tokens.json` and `ui/confetti.tsx` alone; the earlier
fireworks are in git history (`ui/fireworks.tsx`).
