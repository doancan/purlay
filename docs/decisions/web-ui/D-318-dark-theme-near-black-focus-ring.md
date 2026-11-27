# D-318. The dark theme is a near-black with a cool tint, and the focus ring is one moderate blue in both themes — amends D-206, D-207

**Decided by the owner, 2026-11-19**, after a live review of both themes. The dark theme's grounds were neutral zinc greys (`#1a1a1d` for the page, `#171719` for the navigation) and read as charcoal, not as the near-black a product people sit in all day is drawn in; its focus ring was a pale grey (`#c4c4cc`) that glared on them. In the light theme the ring had been the accent fill's `#2563eb`, which shouted next to the quiet surfaces, and then, since the first pass of this review, a slate `#475f9a` that was too dull to read as the accent's family.

**The dark grounds.** One hue (228°) at 14% saturation, stepped in lightness: ground `#08080a`, navigation rail `#0a0b0d`, navigation `#0d0e11`, page `#101216`, raised `#16171d` and `#1b1d24`, code `#0b0c0f`, edges `#1f2129` and `#191b21`, hover `#17191f`, selected `#1e202f`, the accent's wash `#181b25`. The steps between layers are small and every one is kept above the edge contrast the build computes; the midnight theme (`#12122a` and its indigo) stays the saturated blue one, so the two dark themes are still two.

**The ring.** `#4a74dc` in light (between the loud fill and the dull slate: 3.5 to 4.4 against every surface it sits on) and `#6f8fe8` in dark (5.2 to 6.4: seen at once, not glaring). The composer's edge is the same blue in light and `#4f6ac2` in dark, one step calmer, as D-207 wanted. All of it is checked by the token file's contrast table, not by eye.

**Rejected.** A ring drawn as a translucent halo: it cannot be held to the 3:1 the focus ring must keep over every surface, and a shadow would fight the cards that already carry one. Pure `#000` for the ground: it makes the raised layers look lit from inside and every edge look cut; a faint tint keeps the layers one family. Moving the dark theme to a tinted navy: that is the midnight theme.

**Cost of reversing.** The fourteen values in `tokens.json` and the generated CSS; no component names a colour.
