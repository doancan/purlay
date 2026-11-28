# D-343. One neutral family for every grey, light and dark, on even steps — changes D-180's light navigation tint

*Amended by D-361: the light navigation is two cool blue tones again, calibrated; the dark and Midnight themes and every other grey stand.*

**Decided (the owner, 2026-11-26).** The segmented control's rail did not read against the page: `surface-200` was
#f2f2f4 on a `surface-000` of #f5f5f7, 1.03:1, a smudge rather than a groove. Measured in OKLCH, the light theme also
had three families of grey side by side: the content's at hue 286 (chroma 2.7), `surface-050`/`100` at no hue, and the
navigation's at hue 270 with chroma 7 to 22 (`nav-border` a visible blue), so the sidebar, at the page's own lightness
(L 97.0 against 97.1), read as a different grey rather than a different step. The dark theme drifted between hue 264
and 286 with chroma up to 15.

**What changed.** Every neutral surface, hairline and the control edge in the light and dark themes is one hue (286,
the inks' own) at a low chroma, on lightness steps chosen to read apart:

| Light | L | | Dark | L |
|---|---|---|---|---|
| `surface-100` (cards, conversation) | 100 | | `nav-rail` | 13.0 |
| `surface-050` (hover on white) | 98.6 | | `surface-000` | 13.8 |
| `code-bg` | 97.6 | | `code-bg` | 15.4 |
| `surface-000` (page) | 97.4 | | `nav-surface` | 15.8 |
| `nav-surface` | 96.4 | | `surface-100` | 18.2 |
| `nav-rail` | 95.2 | | `surface-050` | 20.6 |
| `surface-200` (rail, input, hover row) | 94.8 | | `nav-border` | 22.4 |
| `nav-hover` | 92.8 | | `nav-hover` | 25.0 |
| `border-subtle` | 91.6 | | `surface-200` | 25.6 |
| `nav-border` | 91.2 | | `accent-subtle` (accent hue) | 26.0 |
| `border-strong` | 79.6 | | `border-subtle` | 28.0 |

The light navigation's inks are the content's (`nav-ink` = `ink`, `nav-ink-muted` = `ink-muted`). `nav-selected`
stays in the accent's family: "you are here" is still the one coloured row (D-207). In the dark theme `surface-200`,
`accent-subtle` and the hairline sit a clear step above `surface-100`: the design audit the same day found a palette
tile, a selected row and a card edge at the first values read as nothing. Midnight is a deliberately saturated theme
and is untouched. Every pair in `pairs.ts` still passes; the closest is `border-strong` on
`surface-200` at the control edge's 1.6:1.

**Rejected.** Keeping the light navigation cool and only lowering its chroma: two temperatures of grey side by side was
the complaint, and a step of lightness separates the regions without a second hue.

**Cost of reversing.** Low: the values are in `packages/tokens/tokens.json` alone; restoring the earlier ones and
running `bun run tokens:generate` brings the old greys back, and `pairs.ts` judges them as it judges these.
