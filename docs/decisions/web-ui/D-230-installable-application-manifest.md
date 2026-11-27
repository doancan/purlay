# D-230. Purlay installs as an application: a manifest, pictures drawn from the favicon, and no offline copy — builds on D-51, D-126, D-148; closes #89

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** D-51 made mobile an installable web
application, and iOS delivers Web Push only to a site added to the Home Screen (16.4+). Purlay had no manifest, so
an iPhone could not install it and with Purlay closed heard nothing, whatever the person turned on.

- **`public/manifest.webmanifest`** opens the whole origin (`/`) as a standalone application. Its colours are the
  dark theme's `surface-100`, which the shell starts in; `index.html` also gives the browser's bar `surface-100`
  for each colour scheme.
- **The pictures are the favicon, drawn again.** `bun run icons` (`apps/web/scripts/app-icons.ts`) renders
  `favicon.svg` at 192 and 512 as it is, and full-bleed at 512 (maskable) and 180 (`apple-touch-icon`), where the
  launcher cuts its own shape; the glyph already lies inside the maskable safe zone. `src/app-icons.test.ts`
  decodes each PNG and holds its colours to the accent tokens and its sizes to the manifest, so a changed favicon
  or accent fails until they are drawn again.
- **iOS's Safari outside the Home Screen says what to do.** Where the browser has no push and `navigator.standalone`
  is `false` (iOS's alone), the notifications page says to add Purlay to the Home Screen instead of "this browser
  cannot show notifications", which there is not the whole truth.
- **No offline copy and no fetch handler.** The push worker (D-126) stays registered only when somebody turns
  notifications on; installation needs neither in current Chrome and Safari (Chrome's installability check on the
  built client reports no errors). A chat client with a stale cache shows a conversation that is not true.

**Considered and rejected.** A service worker that caches the shell for offline use (a second copy of the client
whose staleness must then be managed, for a product that is useless without the server). Hand-drawn PNG icons
(a second source of the brand that drifts). `apple-mobile-web-app-capable` and the other pre-manifest iOS meta tags
(iOS 16.4+ reads the manifest's `display`). An in-page install prompt (`beforeinstallprompt` is Chromium's alone,
and the browser's own menu already offers it).

**Cost of reversing.** Remove the manifest, the four PNGs and the two `<link>`s; the push worker is untouched.

**Amended 2026-11-26 (D-339).** The pictures are now the owner's mark on a white tile, drawn from
`apps/web/public/purlay-mark.svg` by the same `bun run icons`, which also writes `favicon.svg` and `favicon-waiting.svg`: the
favicon is no longer the pictures' one source, the brand file is. `apps/web/src/app-icons.test.ts` holds their tile to the
`on-accent` token, the mark to the brand file's colours at its place, and the maskable safe zone by measuring it.
