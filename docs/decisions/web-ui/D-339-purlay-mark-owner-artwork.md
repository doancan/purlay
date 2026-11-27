# D-339. The Purlay mark is the owner's artwork on a white tile, and a token-built letter no more — amends D-148, D-230

**Decided (the owner, 2026-11-26).** The owner supplied the mark as an SVG: three gradient paths on a transparent
ground. It replaces the white P on an accent tile everywhere the web product shows its identity — the tab's icon, its
waiting variant, the installed application's pictures, the Home Screen picture and the mark inside the interface.

1. **One source.** `apps/web/public/purlay-mark.svg` is the owner's file as it was given, served as `/purlay-mark.svg`.
   Everything else is drawn from it by `bun run icons`: `favicon.svg`, `favicon-waiting.svg` and the four PNGs, by
   the pure functions of `apps/web/scripts/app-icon-art.ts`. `apps/web/src/favicon.test.ts` requires that what is committed is exactly
   what those functions make of the file, so a hand edit, or a new mark that was not drawn again, fails. The file is
   read as gradients and paths only; anything active in it (a script, a handler, a reference outside itself) is
   refused rather than cleaned, because the favicon ships on every page.
2. **A white tile, the `on-accent` token.** The mark is light blue, so it needs a ground: on a white tab strip the tile
   disappears and the mark reads alone; on a dark or grey one it is a clear rounded square. The mark's own colours are
   the brand's and bound to no token: `tokens.json` is the native applications' contract too, and seven stops of one
   picture the web alone draws are not worth a change to what they pin.
3. **In the interface, `LogoMark` shows the file** as an image on a `bg-on-accent` tile with a `border-subtle` hairline, which
   keeps it a shape on the light theme's white card, where a bare white tile disappears; it is the one component and
   every screen that had the letter uses it. It is decoration, beside a visible title or name on each screen, so it is
   hidden from a screen reader.
4. **The safe zone is measured.** The mark is drawn at 1.04 of the brand file: its farthest point is then 402 from the
   centre of a box whose maskable safe circle is 409.6. `apps/web/src/app-icons.test.ts` scans the maskable and Home Screen
   pictures for any mark outside it.
5. **What a deploy changes in a browser.** Nothing here is cached beyond a revalidation: every file outside `/assets/`
   (the icons, the mark, `manifest.webmanifest`, `index.html`) is `no-cache` with a size-and-time tag (`client.ts`), and
   the push worker caches nothing (D-230). A returning person gets the new tab icon, the mark on the sign-in card and
   the manifest on the next load, without a hard reload. What is not ours: a browser keeps its own store of tab icons,
   and an iPhone copies the Home Screen picture when Purlay is added, so only people who add it after this release
   have the new one there (how an installed Android icon refreshes is the platform's schedule; not verified here).

**Rejected.** *An accent-blue tile:* the pale ribbon disappears in it. *A tinted tile (`#eef3fa`):* a clearer shape on
white, but no token, so no test could bind it. *A transparent favicon:* the ribbon vanishes on a light tab strip.
*A dark tile:* the deep blue of the fold and the stem vanish. *The mark drawn inline in `LogoMark`:* the lint rule of
D-97 refuses a literal colour, and making the stops tokens is the change above. *A generated module of the paths:* a
second copy of the artwork. *The file imported as a bundled asset:* Vite writes a small SVG into the page as a `data:`
address, which the policy's `img-src 'self'` refuses (D-39), and the import is Vite's alone while every test renders
this component.

**Not decided here.** *The notification icon:* `apps/web/worker/notice.ts` and `apps/web/src/features/push/notifier.ts` still name `/favicon.svg`, and
which browsers draw an SVG there was not checked. *The sidebar and the workspace header* show the workspace's own
identity and carry no product mark; adding one is a design choice, not a replacement.

**Cost of reversing.** Low: one file, one script and the pictures it writes; the tests move with them.
