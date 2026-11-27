# D-62. The state cookie is signed with a key derived from `ENCRYPTION_KEY`

The OAuth `state` cookie must be signed (D-39), and no document named a key for it.

**Rejected: not signing, and comparing the cookie to the query parameter.** Sound only while
nothing else can write a cookie for this origin. A sibling subdomain can, and *cookie tossing*
plus an attacker-chosen `state` is a login-CSRF: the victim ends up signed into the attacker's
account. A signature the attacker cannot produce closes it; a bare comparison does not.

**Rejected: a second secret in `CONFIG.md`.** Every additional key is another thing an operator
generates, stores and rotates — and the failure mode of *one more secret* is the one nobody
rotates.

**Decided: derive it.** `ENCRYPTION_KEY` is the root secret; the signing key is
`HMAC(ENCRYPTION_KEY, "purlay:oauth-state:v1")`. Domain separation means the state signature and
the integration-token cipher cannot interact, and rotating the root invalidates in-flight sign-ins
— a ten-minute window, which is the intended cost of rotating a root secret.

**Corrected 2026-10-08 (#199): the signature does not stop cookie tossing, and the first paragraph
said it did.** An attacker can ask `/auth/github` for a validly signed state of their own, plant that
cookie from a sibling subdomain, and send the victim to the callback with their own code — the victim
is signed into the attacker's account. The signature proves the server issued the state; it cannot
prove the server issued it *to this browser*. What stops the planting is the cookie's name: both the
state and the session cookie are `__Host-`-prefixed, which a browser accepts only from this origin,
`Secure`, with `Path=/` and no `Domain`. The state is also spent by every callback, accepted or
refused, so it cannot be replayed within its ten minutes. The signature stays: it is what keeps a
cookie this server did not issue from being accepted at all.
