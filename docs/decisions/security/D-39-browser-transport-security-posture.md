# D-39. Browser and transport security posture

The documents specified `state` verification, an HttpOnly cookie and a hashed session token, and
stopped there. Four surfaces were never covered, and one of them is built in Phase 0.

**1 · `Origin` is validated on the WebSocket upgrade. Phase 0.**
`SameSite=Lax` does not reliably protect a WebSocket handshake — a page on another origin can open
`wss://…/ws` and the browser may attach the cookie. That is cross-site WebSocket hijacking, and it
hands an attacker a live authenticated socket. The upgrade therefore rejects any request whose
`Origin` is not `APP_URL`, before the session is even looked up.

**2 · CSRF is defended by `SameSite=Lax` plus an `Origin` check on state-changing requests, not by
a token.** Every mutation is `POST`/`PATCH`/`PUT`/`DELETE` with `Content-Type: application/json`,
which a cross-site form cannot produce, and CORS is restricted to `APP_URL` with credentials. A
token would add a mechanism without adding a guarantee. The OAuth `state` cookie stays signed and
short-lived, which is a different problem with a different answer (`ARCHITECTURE.md` §7.1).

**Amended 2026-10-09 by D-80:** this was promised and not built on HTTP (#234). It is now: `POST`,
`PUT`, `PATCH` and `DELETE` are refused with `FORBIDDEN` unless `Origin` equals `APP_URL`'s, logout
and logout-all included; an absent `Origin` is judged by `Sec-Fetch-Site`. "CORS is restricted to
`APP_URL`" stands corrected by D-61: there is no CORS at all, one origin.

**3 · Attachments are served defensively. Phase 1.**
A user-uploaded SVG or HTML file served from the application's own origin is stored XSS, and D-16
already routes downloads through the API. So: `Content-Disposition: attachment` for everything
that is not an image we re-encoded ourselves, `X-Content-Type-Options: nosniff`, a restrictive
`Content-Security-Policy` on the response, and the stored MIME type is never echoed back for
`text/html` or `image/svg+xml` — SVG uploads are rasterised or refused, never served as SVG.

**4 · The image proxy is a hardened fetcher, not a `fetch()` call. Phase 1.**
`ARCHITECTURE.md` §8.1 says external images are proxied, in one line, with no definition. A proxy
that will fetch any URL a message contains is an SSRF endpoint pointed at the internal network.
It resolves DNS first and refuses any address outside public unicast ranges, follows no redirects,
caps bytes and wall-clock time, sends no credentials, and re-encodes what it returns.

*Rejected: not proxying, and rendering remote images directly.* It leaks every reader's IP address
to whoever hosts the image, which in a private team chat is worse than the SSRF risk we can
actually contain.

**5 · A content security policy baseline. Phase 1.**
`default-src 'self'`, no `unsafe-inline` script, images from `'self'` and the proxy only. It lands
with the content pipeline, because that is when there is user-controlled markup to constrain.
*(Amended 2026-10-11 by D-102: the document carries this baseline, with inline style and GitHub's
avatar host as two measured exceptions; the API's own responses keep `default-src 'none'`.)*

**6 · `ENCRYPTION_KEY` is AES-256-GCM.** A random 96-bit nonce per record, stored as a prefix on
the ciphertext, with the record id as additional authenticated data. `CONFIG.md` named the key and
never named the algorithm, which is how two call sites end up encrypting differently.
*Amended 2026-10-12 (#113): the cipher's key is derived from the root as D-62 derives the state
key — `HMAC(ENCRYPTION_KEY, "purlay:credential:v1")` — so the two cannot interact; a version byte
precedes the nonce so a later key or algorithm is told apart rather than guessed. One helper,
`platform/crypto.ts`, and a test that no other production source encrypts.*

**Reversibility:** items 1 and 6 are free now and expensive after the first session and the first
stored token. The rest arrive with the features they protect.


> **Amended 2026-10-12 by D-109.** §2: the one upload route takes `application/octet-stream` — a type a
> form cannot send either, so the defence stands; every other mutation is still JSON. §3: an image is
> served inline only as Purlay re-encoded it; every other file, SVG included, as a download.
