# D-190. A server tells a client what it is, and refuses one it can no longer serve — builds on D-186

**Context.** A browser client is served by the server it talks to, so it can never be too old. The macOS
application (D-186) is installed by people and updated on its own schedule, and a server is upgraded on its
operator's: the two meet in every combination. Nothing said what each side speaks, and the one thing a server
may have to do — stop serving an application that can no longer work, because a release was broken or a
contract changed — had no word the application could act on.

**Decided.**

- **`GET /api/client`**, public and uncached, answers `ClientInfo`: the server's version (the root manifest's, D-185),
  `contractVersion`, the canonical `appUrl`, the minimum an installed client must meet, and `AuthMethods` — so one
  call draws the sign-in screen. `appUrl` is there because the socket's `Origin` check is an equality with it
  (D-39): a client learns the one string that will be accepted from the server, never from what a person typed.
- **`CONTRACT_VERSION`** in `@purlay/types` is the wire contract's version. It is bumped when a client built
  against the old contract would misbehave against the new server — a field removed or retyped, a meaning
  changed, a frame removed — and **not** for an addition (responses may gain fields, D-58). A bump is a one-way
  door and is decided in this document before it is a number.
- **`X-Purlay-Client: macos/<semver> contract/<n>`**, sent on every request and on the socket upgrade. A
  header that is not exactly that shape — and a browser sends none — is no client, and is served: a refusal
  that fires on a typo locks a person out of their own server.
- **`426 CLIENT_TOO_OLD`** when the operator has set a minimum (`MIN_CLIENT_MACOS_CONTRACT`,
  `MIN_CLIENT_MACOS_VERSION`, `MACOS_DOWNLOAD_URL`; none set is no limit, the default) and the client is below
  either. Answered at the edge before the body is read or a session looked up, with `Upgrade: purlay-client` as
  the status requires and `details` saying what is still served and where to get it; to the socket upgrade as the
  status, not as a socket that closes for a reason a client must guess. Never to `GET /api/client` and `/health*`,
  however the path is spelled: they are how a client learns to update.
- **A minimum above this server's own contract is refused at boot**: it would refuse every client, and the first
  person to sign in would be the one to find out. The download address must be `https://`.

**Rejected.**

- *A version in the URL* (`/api/v1`). Every route would be spelled twice for a number most deployments never move.
- *Refusing a header that is not the shape.* A typo, a proxy that rewrites headers, a future platform name: each
  would lock someone out, for the sake of a check nothing needs (this is not a security boundary).
- *The server's commit in the answer.* The process does not carry it — the image does, as a label — and a field the
  server cannot fill honestly is worse than none.
- *A per-request check by the handler.* Every handler would carry it, one would forget, and the refusal would come
  after a session lookup and a body read.

**Accepted.** The application and the web are served by contracts that are the same number today and will not be
forever; the minimum is an operator's lever, not an automatic one. An older application against a newer server
relies on responses being additive and on its own tolerance of what it does not know.

**Reverses if** the only installed client is withdrawn (D-186's reversal): then the header, the route and the
three variables are removed and nothing else moves.
