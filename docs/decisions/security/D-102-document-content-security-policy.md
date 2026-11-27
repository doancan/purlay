# D-102. The document carries its own security policy, with two measured exceptions — closes #112's baseline

D-39 item 5 fixed the baseline — `default-src 'self'`, no inline script, images from `'self'` and the
proxy — and D-61 put the built client on the API's origin. Until the API served that client (#224) the
question had no response to answer it on: every response carried the API's own policy,
`default-src 'none'`, which on a document would load nothing at all. The demo's front server never sent
a policy, which is why nothing had noticed.

**Decided: two policies, chosen per response, both in `apps/api/src/ingress/http/edge.ts`.** An API
response keeps `default-src 'none'; frame-ancestors 'none'` — it is data, and loads nothing. The client's
HTML document gets `DOCUMENT_SECURITY_POLICY`: `default-src 'self'`, `script-src 'self'` (no inline
script and no `eval`; `theme-init.js` is a file so it needs no hash), `connect-src 'self'` (a same-origin
`wss:` under CSP Level 3), `font-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
`form-action 'self'`, `frame-ancestors 'none'`. The browser suite runs every test under it, on the
production path — the demo's front server sends everything but its login to the API — and fails a
test on any refusal the page reports.

**Two exceptions, each observed rather than argued:**

- **`style-src 'self' 'unsafe-inline'`.** The dialog primitive (Radix, D-52) locks scrolling by writing a
  `<style>` element. With `style-src 'self'` Chromium reports `style-src-elem refused inline` when the
  command palette opens, and the lock silently does not apply. Inline **style** cannot run code; inline
  script stays refused.
- **`img-src` adds `https://avatars.githubusercontent.com`.** Avatars are GitHub's, and the image proxy
  that would serve them from `'self'` is #110. The exception is marked `TODO(#110)` beside the policy and
  is removed with it. *(Removed by D-237: avatars are initials and fetch nothing, D-100.)*

**Rejected: initials instead of avatars until #110.** A stricter policy bought by taking back D-100's
identity for a source that is GitHub's own avatar host. **Rejected: a nonce for the style element.** The
primitive reads one from a global the bundle would have to set per response, which turns a static shell
into a rendered one for a style that cannot execute. **Rejected: the proxy (Caddy) setting the policy.**
Two places would set headers, and a self-hoster running the image behind their own proxy would get none.

**Caching, decided with it.** A file under `/assets` has a content hash in its name and is
`public, max-age=31536000, immutable`; every other file — the shell, `theme-init.js`, the fonts — is
`no-cache` with a weak entity tag made of its size and modification time, answered `304` when it has
not changed. The runtime sends neither an entity tag nor a modification date for a file (measured: a
conditional request was a full `200`), so without the tag every load downloaded the fonts whole. A file
in an image keeps its time for the image's life, so the tag changes with a deployment and not with a
restart. Rejected: hashing each file's bytes per request, which costs a read for an answer the
metadata already gives; a long lifetime for the fonts, whose names carry no hash, so a changed font
would be stale for a year. The document also carries `Cross-Origin-Opener-Policy: same-origin`: sign-in
is a top-level navigation, never a pop-up, so nothing it opens needs a handle back to it.

**Reopened when** #110 lands (drop the avatar host), or when a primitive that needs inline style is
replaced or learns to take a stylesheet.

*Amended 2026-10-15 (#638): the document also carries a `Permissions-Policy`.* Camera, microphone,
geolocation, payment, USB, serial, HID, MIDI, display capture and the Topics API are off — the page uses
none, so anything that ever runs in it cannot either. Two stay the origin's own: `clipboard-write`
(Copy code writes it) and `fullscreen` (a video's own control). Notifications are not governed by the
header; they ask the person (D-126). The list is whole in `edge.ts` and in its test, so a feature
allowed later is a decision; a browser test fails if Chromium objects to an entry or the clipboard stops
working. Rejected: the same header on API responses, which load nothing for it to govern.

*Amended 2026-11-26: `browsing-topics` is no longer in the list.* Chromium deprecated the Topics API in
144 and removes it in 150 together with its `browsing-topics` policy feature, so the Chromium that
Playwright 1.65.1 ships reports the entry as "Unrecognized feature", which is the very objection the
browser test exists to catch. The entry opted the page out of an API that is going away; the page loads no
third-party code (`script-src 'self'`), so nothing in it could have called the API either. The test was not
loosened: the header lost the entry and the whole-list assertion in `serving-the-client.test.ts` says so.
