# D-183. The dark theme is one family: the navigation's indigo, in layers — now Midnight (D-184)

**Decided (the owner, 2026-10-23), amends D-180's "dark keeps the navigation's tones".** The dark theme's
content was a neutral near-black (`#0f0f11`, `#161618`) beside a navigation in indigo-navy (`#16162b`,
`#22223f`): two palettes side by side. The owner asked for the whole dark theme in the navigation's tone,
clean and in the manner of Apple's dark mode: deep, calm, layered, no hard edges. Every dark surface, border
and text token now sits in the navigation's hue: the window `#12122a`, the content `#1a1a34`, a raised
fill `#25253f`, a hover `#20203c`, hairlines `#2d2d4b`, a control's edge `#7d7da0`, text `#f1f1f8` /
`#a9a9c6` / `#9696b6`; the avatar tints moved from warm browns to the same family. The light theme and the
navigation's own tokens are unchanged.

The contrast pairs are the gate and were not touched: every pair passes at the new values (`bun run tokens:check`).

**Considered and rejected.** A neutral grey dark with only the navigation in indigo (what it was: the
mismatch the owner saw); a pure black "OLED" ground (harsh against the indigo navigation).

**Cost of reversing.** Eleven dark values in `tokens.json` and the avatar tints; generated files follow.
