# D-61. One public origin, and development is proxied so it matches

`CONFIG.md` says the OAuth callback registered with GitHub is `${APP_URL}/auth/github/callback`.
`APP_URL` is documented as *the public origin of the web client*, and the API is a separate process
— in development on another port, and `ARCHITECTURE.md` §11 listed `api` and `web` as separate
containers. As written, the callback lands on the client, which has no such route. The gap was
found while building the handshake, not by reading, because every document was individually
consistent.

**Decided: the browser talks to exactly one origin.** `APP_URL` is that origin. In production the
API serves the built client from it; in development Vite proxies `/auth`, `/api` and `/ws` to the
API process, so what the browser sees is identical in both.

The documents were already assuming this — the callback sentence only makes sense with one origin
— and three separate rules get simpler by it rather than by accident:

- D-39 requires the socket's `Origin` to equal `APP_URL`. Same-origin makes that an equality rather
  than a list.
- The session cookie is `SameSite=Lax` (`ARCHITECTURE.md` §7.1). Same-origin means that setting is
  the whole story, with no cross-site exception to reason about.
- **There is no CORS at all**, so there is no CORS to misconfigure — which for a self-hosted product
  is a support burden removed rather than a feature lost.

**Development and production differ in the one place bugs are hardest to see.** Cookies, origins
and redirect URIs are exactly what a developer cannot test on a machine whose topology is different
from the deployed one. Proxying makes them the same.

**Rejected: two origins with CORS.** Three more things to get right — the CORS policy, a
`SameSite=None` cookie, and the socket's origin list — each of which fails in a way that looks like
a bug in something else.

**Rejected: a reverse-proxy container in front of both.** It works, and it makes the routing table a
second place that has to agree with the application's own. A self-hoster who has to understand a
proxy before signing in has met the friction `PRD.md` §3 exists to remove.

**Reversibility:** changing to two origins later is configuration plus a CORS layer, not a
migration. Cheap to reverse, which is why it is decided now rather than escalated.
