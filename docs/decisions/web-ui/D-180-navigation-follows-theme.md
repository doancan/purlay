# D-180. Navigation follows the theme: a light neutral in the light theme, the dark navy in the dark — changes D-118

**Decided (the owner, 2026-10-23).** D-118 drew the rail and the sidebar in dark navy in *both* themes. The
owner, using the product, asked for the left menu to be light in the light theme, and for the dark theme to
keep the tones it has. So the `nav-*` tokens now have a light value of their own (`nav-rail` `#e9ecf5`,
`nav-surface` `#f3f5fa`, `nav-hover` `#dfe3f1`, `nav-border` `#d6dbeb`, `nav-ink` `#1b1c2e`,
`nav-ink-muted` `#555977`) and the dark values are unchanged; the shell no longer forces `data-theme="dark"`
on the rail and the sidebar, so every shared control inside them speaks the inks of the theme it is in, and
`pairs.ts` computes the navigation's pairs in both themes like any other (`inNav` no longer pins the dark one).

**What it cost, and why.** A light navigation that is told apart from the white conversation by tone alone
is a narrow band, and the contrast pairs are computed against it: `accent-text` on `nav-hover` and
`ink-subtle` on the rail would have failed at their old light values. Three light values moved, each a small
step, each helping the rest of the screen too: `accent-text` `#2563eb` → `#1d4ed8` (links and mentions
read at 6.7:1 on white instead of 4.8:1), `ink-subtle` `#6b6b73` → `#63636e`, and `focus-ring` `#3b82f6` →
the accent `#2563eb` (the ring reads at 5.2:1 on white instead of 3.7:1). The accent fill, the dark theme and
every other token are untouched.

**What stays dark.** The full-screen image viewer: a picture is judged on a dark ground, so it sets
`data-theme="dark"` on its own overlay and content in either theme.

**Considered and rejected.** Keeping D-118 and only softening the navy (the owner asked for a light
navigation); tinting the sidebar and leaving the rail dark (two tones that match neither theme); loosening
the contrast pairs to keep the old light values (the pairs are the gate, D-97 §5).

**Cost of reversing.** The six light `nav-*` values, the three moved light values, the two lines in the shell
that no longer force the theme and `inNav`'s pin: tokens and one file each. No contract, route or key.
