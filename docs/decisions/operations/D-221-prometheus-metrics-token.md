# D-221. A Prometheus page for the operator, off until it has a token — amends D-44

**Decided (the owner, 2026-10-31).** D-44 said *no metrics stack yet*: logs, health checks and error tracking
answer *is it up* and *what broke*, and nobody was asking *how is it trending*. Self-hosters now are, and they
already run Prometheus beside everything else they host. So the API answers `GET /metrics` in Prometheus's text
format (0.0.4) — and nothing about D-44's other half changes: **nothing leaves a self-hosted server**. The page is
pulled by a scraper the operator runs; nobody is sent anything.

- **Off by default, and absent to a stranger.** Without `METRICS_TOKEN` the page does not exist. With it, a request
  must carry `Authorization: Bearer <token>`, compared in constant time over SHA-256 of both sides, so neither where
  they differ nor the token's length can be timed. No token, a wrong one, another scheme: each is the `404
  ROUTE_NOT_FOUND` of a path nothing serves, byte for byte, as the server's administration answers everybody but its
  administrator and a resource in another workspace is `404` (`CONTRIBUTING.md` §1.2). A `401` would tell a stranger
  that the page is there and worth guessing at. `/metrics` is one of the API's own prefixes, so with the client
  served a path under it is still that `404`, never the client's shell. The operator is told of a refused scrape in
  the log, at `info`, without what was sent. The token is at least 32 characters of a token's alphabet, refused at
  boot otherwise and never quoted; no rate limit is put on the route, since a `429` there would itself say the
  page exists.
- **Defence in depth.** The production proxy answers `/metrics` and anything under it `404` itself
  (`docker/Caddyfile`; measured: `/METRICS`, `/%6Detrics` and `//metrics` too), so a token that leaked is still no
  use from the internet; a Prometheus on the stack's network scrapes `api:3001` (`CONFIG.md`, *Metrics for
  Prometheus*).
- **No dependency.** The format is a page of rules: HELP and TYPE, three escapes, `+Inf`/`-Inf`/`NaN`, cumulative
  buckets. It is written in `platform/exposition.ts` and held by a strict reader in the tests that refuses what the
  format does not allow.
- **What is counted is what the code can see honestly, per process.** Uptime and resident memory (*measured for #1028:
  Bun's `process.memoryUsage().rss` is the physical footprint on macOS; under load on a Mac the gauge read 125.6 MiB
  where `footprint` said 125.6 MiB and `ps` 420 MiB, the difference being 266 MiB the process had freed that the
  system had not yet reclaimed. The gauge is what the process holds; `ps` on macOS is not; the help line says so*); sockets open on
  this process (several nodes are several targets, which Prometheus adds up — D-201 does not change that); each HTTP
  request as one histogram by method, route **as registered** and status class, whose `_count` is the request
  counter, so a second counter would be the same number twice; refusals for the rate at each door; pushes that did
  not reach their service, by why (`refused`, `not_taken`, `error`, `dropped`); letters the relay did not take. Each
  counter's series exist from the start at zero, so the first failure is a rate and not a new series.
- **The jobs are read, not counted.** They run in the scheduler's container, one process per run, so nothing the API
  holds in memory would ever see one. Their record is `job_runs`, what `jobs:status` reads: each planned job's last
  success and its failures since are read per scrape, within two seconds. A record that cannot be read leaves the
  rest of the page and says `purlay_jobs_status_readable 0`, logged once until it reads again. A count of every run
  ever is kept nowhere, so the page does not invent one.
- **No label is a person's.** Label values are words the code spells: a method (anything unregistered is `OTHER`),
  a route as registered (`/*` for the catch-all, `(edge)` for a request refused before routing, `(unmatched)` for a
  method no route takes), a status class, a door, a reason, a job's planned name. A thousand paths with ids,
  addresses and names in them are one series and none of their words; a test signs a person in, has them write, and
  finds none of their name, address, ids, workspace or words on the page.
- **One registry per process**, made by the composition root and handed in like every other dependency
  (`platform/metrics.ts`); a module is handed a `Counter`, never the registry. A name declared twice, a name or label
  Prometheus could not read, a counter going down or an observation that is not a number is a defect, thrown.

**Considered and rejected.** `prom-client` (a dependency and its own global default registry for a page of format);
a `401` for a wrong token (it confirms the page to anybody who asks); serving the page on a second port (a second
listener to configure and expose correctly, where one path, one token and the proxy's refusal already keep it in);
counting job runs in the API (they are not the API's to see); the database pool's in-use and idle connections
(`@purlay/db` hands out Kysely and keeps the pool inside it; widening that package's surface for two gauges is left
for when somebody needs them); per-workspace or per-user series (cardinality, and a list of who is active).

**Cost of reversing.** Remove the route, `METRICS_TOKEN` from the loader, the compose file and the example env file,
the three new files and their tests, the counters handed to the push sender, the mail ledger and the socket, and the
proxy's two lines. No data, contract or migration is involved; an operator's scraper starts seeing `404`.
