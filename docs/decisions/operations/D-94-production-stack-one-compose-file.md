# D-94. The production stack is one compose file, one proxy, and nothing that names a server

D-73 put an internal deployment into Phase 1 and made it a condition that nothing assume the server
it first runs on (#248). The shape had to be decided before the file: where TLS ends, what is
published, and what the operator must supply.

**Decided: `docker-compose.production.yml` — API, PostgreSQL, Garage and Caddy.** Caddy is the only
service with published ports (80 and 443, UDP 443 for HTTP/3), and its site address *is* `APP_URL`,
so the origin it answers for and the one the API checks sockets against cannot differ. Certificates
are issued and renewed by Caddy itself (ACME); for `https://localhost` it uses its internal CA, which
is how the file was exercised without a domain. WebSockets pass through `reverse_proxy` unchanged.
The proxy starts only when the API reports ready, and the API only when PostgreSQL and Garage are
healthy. The API runs with the image's read-only, capability-free profile (D-92) and migrates itself
(D-93). Every image but the API's is pinned by digest; the API's is a variable (`PURLAY_IMAGE`), so a
deployment names a commit or a digest, never a moving tag.

**Inputs are variables, and only those.** The tables in `CONFIG.md` plus three the stack needs
(`PURLAY_IMAGE`, `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`). A required one that is missing stops
`docker compose` with its name. A test asks `docker compose config` itself for the resolved model and
fails if a port other than 80/443 is published, an image lacks a digest, the API loses its read-only
profile, a host path other than this repository's read-only config files appears, or a variable the
file reads is missing from `CONFIG.md`. The one-time storage layout, bucket and key are created by
`scripts/production-init.sh` from the same variables — Garage's image has no shell to do it in compose.

**Its own Compose project name** (`purlay-production`), so its volumes cannot be a developer's.

**Rejected: Traefik, nginx, or the platform's ingress.** Caddy's automatic TLS is the whole point for a
self-hoster who will not run certbot; nginx needs a second tool for certificates, Traefik needs a
dynamic configuration model for one upstream. A platform ingress is the PaaS D-73 declined for now.
**Rejected: publishing PostgreSQL or Garage "for convenience".** Backups run inside the network
(`docker compose exec`), and a published database port on a server that holds a team's conversations
is the incident the stack exists to prevent. **Rejected: a `.env.example` for production.** A second
list of the variables beside `CONFIG.md`, which owns them; the test binds the file to the document.

*(Amended 2026-10-11: the built client is served by the API itself (D-102), so the proxy keeps one
upstream. Compression is the proxy's — `encode zstd gzip` — and the API sends bodies as they are.
Rejected: compressing in the API, which a self-hoster behind a proxy of their own would pay for twice,
in the process whose memory is budgeted.)*

**Not here, deliberately:** the scheduler container (D-30; there are no jobs yet), and multiple API nodes (D-25; the
compose file is the single-node shape, and a second node is `--scale api=2` behind a sticky balancer
only after Phase 3 builds the shared adapters).

**Reversibility:** free. The volumes (database, bucket, certificates) outlive the file.


*Amended 2026-10-09 (a second-round audit that ran it):* (1) Caddy's access log recorded the full URI, so
`/auth/github/callback?code=...&state=...` was written to a file that is shipped and kept; it now logs the
path and removes everything from the `?` on, checked on a real run. (2) 80 and 443 were written into the
file; `HTTP_PORT` and `HTTPS_PORT` move them, with the caveats in `CONFIG.md` (the HTTPS port must also be in
`APP_URL`, and a public certificate needs the standard ports). (3) The variables were only in a table;
`docker/production.env.example` is the file to copy, bound to the compose file by a test, with secrets
left empty so an unedited copy fails by name instead of starting with a default.
