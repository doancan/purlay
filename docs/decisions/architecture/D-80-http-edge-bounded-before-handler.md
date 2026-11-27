# D-80. The HTTP edge is bounded before a handler runs

An audit found a 60 MB JSON `POST` fully parsed and answered `200` (the body is read before
authentication), the `Origin` check D-39 promised absent from HTTP, no `nosniff`, HSTS,
referrer or framing policy on a response, and an inbound `x-request-id` discarded (#234).

**Decided: the body limit is the socket's frame, 64 KiB, enforced by the server.** A message over
HTTP is the message the socket would carry (D-67), and every other body is a few hundred bytes, so one
number — `JSON_BODY_MAX_BYTES` in `ingress/http/edge.ts`, equal to `MAX_FRAME_BYTES` and tested to be —
is both generous and exact. It is Bun's `maxRequestBodySize`, not a handler check, because only the
server refuses *before buffering*. **Measured** on Bun 1.4.2 / Elysia 1.4: a 60 MB body answered `200`
in 27 ms with no limit; with it, `413` in 2 ms with no request hook run, for a `Content-Length`
body and for a chunked one alike. When attachments arrive their route raises the server cap and
holds the JSON routes to this number itself.

**Decided: `Origin` is checked on `POST`/`PUT`/`PATCH`/`DELETE`, before the body is read.** Present,
it must be `APP_URL`'s (the equality the socket upgrade uses, now `platform/origin.ts`). Absent,
`Sec-Fetch-Site` decides: only `same-origin` and `none` pass. Neither header: not a browser, and
allowed — CSRF needs a browser holding an ambient cookie, and every browser that can send a
cross-site `POST` sends `Origin` on it. When both are present both must hold. The OAuth callback
and sign-in are `GET`s and unaffected; the cost of `SameSite=Lax` alone was that a sibling subdomain
could sign every device out.

**Decided: every response carries** `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
`Cache-Control: no-store`, and `Strict-Transport-Security: max-age=15552000` when `APP_URL` is
https. No `includeSubDomains` and no `preload`: both bind a domain this product does not own.
*(Amended 2026-10-11 by D-102: the client's files are the exception — the HTML document carries its
own policy, a hashed asset is cached for good and every other file is revalidated by entity tag; every
API response keeps the headers above.)*

**Decided: an inbound `x-request-id` matching `[A-Za-z0-9._-]{1,64}` is kept**; anything else is
replaced by a fresh id. It is a label for correlating an edge trace — never trusted as identity.

*Rejected: a CSRF token.* D-39 item 2's argument stands. *Rejected: requiring `Origin` on every
mutation.* It would refuse every non-browser client for a threat that only exists in a browser.
*Rejected: a body limit per route in the handler,* which runs after the buffering it is meant to
prevent. *Rejected: a larger limit "for headroom":* the frame is the bound the product already chose.

**Amended 2026-10-09 (second-round attack): the JSON-only claim is now enforced.** D-39 item 2
rests on every mutation being `application/json`, which a cross-site form cannot send — but nothing
refused the types a form can: with neither `Origin` nor `Sec-Fetch-Site`, an
`application/x-www-form-urlencoded` post created a workspace (`201`). A mutation whose body is not
`application/json`, or has no content type, is now `415 UNSUPPORTED_MEDIA_TYPE`, at the edge, before
a session is looked up or the body parsed. A request with no body at all (logout, join) is not
affected; a form with no fields still carries its type and is refused. `415` joins the contract's
statuses. *Rejected: also requiring `Origin`* — the same reasoning as above.

**Reversibility:** free; nothing is stored.


> **Amended 2026-10-12 by D-109 §4.** The server's own limit rises to what an upload needs; the 64 KiB
> bound on every other body is kept at the edge, by `Content-Length`, before parsing — and a bodied
> request with no length is refused.
