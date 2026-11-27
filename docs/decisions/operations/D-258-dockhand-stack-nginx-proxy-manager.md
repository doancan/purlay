# D-258. A one-file stack for Dockhand, behind Nginx Proxy Manager — builds on D-73, D-81, D-94

*Amended by D-262: A Dockhand server follows `:release`, with a database dump every hour.*

**Context.** The owner runs servers with [Dockhand](https://dockhand.pro), a web interface that deploys Compose
stacks, behind an Nginx Proxy Manager that ends TLS — the way purlay.app itself already runs, with the API's
port published and no Caddy (`direct-api.yml`). `docker-compose.production.yml` does not fit Dockhand: it mounts
three files from `docker/` (Dockhand pastes or checks out one compose file, and resolves relative paths in a
directory of its own), and its Caddy publishes 80 and 443 and asks for certificates.

**Decision.** `docker-compose.dockhand.yml`: the production stack in one file, without Caddy.
1. **The same services, held equal by a test.** `dockhand-compose.integration.test.ts` resolves both files with
   `docker compose config` and fails on any difference but the ones below, so a change to the production stack
   that is not made here is caught. Garage's configuration is written inline (`configs: content:`, Compose
   2.23.1 or later) and must be `docker/garage.production.toml` word for word.
2. **No Caddy; the API's port is published** on `PURLAY_HTTP_PORT` (bound to `PURLAY_HTTP_BIND`, every address
   unless set), plain HTTP, for Nginx Proxy Manager on the same server or another. The owner chose this: it is
   how purlay.app already runs, and the proxy is theirs. Nginx Proxy Manager is then the one proxy
   `TRUST_PROXY` means (D-81); with Cloudflare in front of it, it restores the client from `CF-Connecting-IP`,
   as CONFIG.md already asks of any proxy.
3. **What Caddy did is lost or moved**: `/metrics` is the API's alone, 404 while `METRICS_TOKEN` is empty, so the
   token is set only once the proxy refuses the path (D-221); a request made while the API restarts fails
   rather than waits (#636).
4. **No WAL archiving** (D-202): it needs a script mounted into PostgreSQL. The production file remains the
   way to have it.
5. **Updates are the operator's.** Dockhand pulls and restarts; it does not take `scripts/deploy.sh`'s backup
   before the switch or restore one after a failed start. DEPLOY.md says so and gives the dump to take first.

**Rejected.** *A Compose override on the production file*: Dockhand takes one file, and the mounted files are
the problem. *Keeping Caddy behind Nginx Proxy Manager* (the first cut of this decision, on Nginx Proxy Manager's
Docker network): two proxies to configure, and the client address then has to be carried across both — the owner
preferred the shape purlay.app already runs in. *Joining the proxy's Docker network instead of publishing a
port*: it ties the stack to a proxy on the same host.

**Cost of reversing.** One file, its test and a section of DEPLOY.md; a running stack moves to the production
file by mounting its volumes.
