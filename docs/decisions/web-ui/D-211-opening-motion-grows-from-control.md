# D-211. What opens from a control grows out of it, and leaves faster than it came — amends UX §9

**Decided (the owner, 2026-10-30).** The owner asked for smooth, well-made transitions in the right places,
without overdoing it. UX §9 keeps motion quiet and only the palette animated as it opened; menus, the
inbox panel, tips and dialogs appeared and vanished in one frame, which read as abrupt beside the
palette's open.

- **A menu, a submenu, the inbox panel and a tip** open with `pop-in` — from 0.96 with a fade, in
  `duration-overlay` (150ms) — from the origin Radix computes for the side they opened on, so each grows
  out of the control that opened it; they close with `pop-out` in a new, shorter `duration-exit` (100ms):
  what leaves does not need the eye.
- **A dialog** opens as the palette does (`overlay-in`) over a backdrop that fades; both leave in
  `duration-exit`.
- **A toast** rises a little into its corner (`rise-in`): it arrives where the eye is not.
- **Unchanged:** no message entry animation; hover and focus stay 120ms colour transitions.
- **Reduced motion** sets every duration token to 0ms, the new one included, so each of these is
  instant without any component remembering to check; Radix waits for a closing animation before it
  removes the element, and a zero-length one ends at once.

**Considered and rejected.** Animating message arrival, list reordering or the feed (reads as lag, and
moves content under the reader, UX §1); springs and longer durations (more motion than a working tool
wants); a motion library (CSS keyframes and the tokens already do it, with no runtime cost).

**Cost of reversing.** Four keyframe pairs in `index.css`, one duration token, and the classes on the
menu, tip, dialog, toast and panel.
