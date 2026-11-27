# D-184. Dark is black, and the indigo is a theme of its own, Midnight

*Amended by D-206: The workspace is drawn once, at the head of the sidebar; the dark theme is layered greys, not black.*

**Decided (the owner, 2026-10-24), refines D-183.** D-183 put the whole dark theme in the navigation's
indigo. The owner asked for that indigo to be a theme called Midnight, and for the default dark to be a
black one. So there are three themes — `dark`, `light`, `midnight` — and four choices (`system`, `light`,
`dark`, `midnight`):

- **Dark** (the default dark, and what `system` gives when the device is dark) is neutral black in the
  manner of Apple's dark mode: window `#050506`, content `#0e0e10`, a raised fill `#1c1c1f`, hairlines
  `#252528`, text `#f5f5f7` / `#a9a9b1` / `#9696a0`, a black navigation (rail `#000000`, sidebar `#0d0d0f`),
  and quiet, neutral avatar tints.
- **Midnight** is D-183's indigo exactly as it was decided (every dark token and the navigation in the one
  hue, in layers) and is chosen from Settings → Preferences; the operating system has no word for it, so
  `system` never gives it.
- **Light** is unchanged.

Every colour and shadow has a value in each of the three, a theme never inherits (the token file refuses
one that does), and the contrast pairs are computed in all three; Midnight is told to the platform as a dark
`color-scheme`. The choice is the same `data-theme` switch and the same per-device storage as before; the
script that runs before first paint knows `midnight`, so it does not flash black first.

**Considered and rejected.** Keeping the indigo as the only dark (what D-183 made, and the owner did not
want as the default); a fourth, "OLED" theme beside it (black is the default, one is enough); reading
Midnight from the device (no such setting exists).

**Cost of reversing.** One theme entry and its values in `tokens.json`, three lines in `theme.ts` and
`theme-init.js`, a glyph, two strings, and the gallery's third frame. No contract, route or stored data
beyond the device's `purlay.theme`.
