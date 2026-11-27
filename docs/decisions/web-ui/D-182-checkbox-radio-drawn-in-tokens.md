# D-182. One check box and one radio, the browser's input drawn in tokens

**Decided (the owner, 2026-10-23).** Walking the dark theme, the new-channel dialog's "Private" box was the
operating system's own: a light grey square in a dark window, a different size in each browser, sitting
above the baseline of its label. Eight screens drew their own native `<input type="checkbox">` or
`type="radio"`. There is now `ui/checkbox.tsx` — `Checkbox` and `Radio` — and the screens use it.

It stays the browser's input (`appearance-none`, drawn by hand), so the keyboard, the wrapping label, forms
and the screen reader are the platform's and nothing is reimplemented; the tick and the dot are shown by
`peer-checked`, so the screen can only show what the input holds. The edge is `border-strong`, which the
contrast gate holds to 3:1; the keyboard ring is the global one, inset over the edge (one line, not two).
`ui/checkbox.test.tsx` scans the screens and fails on a native check box or radio outside the primitive.

**Considered and rejected.** `accent-color` on the native input (still a light box in the dark theme and
sized by the browser); a Radix checkbox (a button with a role: it loses the form, the label and the
platform's keys, and adds a dependency for what one input does).

**Cost of reversing.** One file and eight call sites; no contract, route or key.
