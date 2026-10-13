# Purlay — Configuration (`CONFIG.md`)

Single source of truth for environment variables. `ARCHITECTURE.md` requires the config loader
to **validate every variable at boot and refuse to start otherwise** — a missing secret must
fail loudly at startup, never at 3am on the first request that needs it.

Variables marked **required** have no default. Anything holding a secret is never logged.

**These tables are the whole set, built and planned.** The variables the application reads *today*
are exactly the ones in `.env.example`, which is generated from the configuration loader and
checked in CI — a variable is read when the feature that needs it is built, never before, because
validating a value nothing acts on tells an operator a setting works when it does not.

---

## Core

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | — | `development` | `development` \| `test` \| `production` |
| `PORT` | — | `3001` | API listen port |
| `APP_URL` | ✅ | — | The one public origin (D-61). Used for the OAuth callback and the socket's `Origin` check — there is no CORS. An origin, not a URL: a trailing slash is dropped, a path, query or fragment is refused. Only `http`/`https`; must be `https://` in production. |
| `LOG_LEVEL` | — | `info` | `debug` \| `info` \| `warn` \| `error`. One JSON line per event on standard output; what is never logged is a list in `apps/api/src/platform/logging.ts` |
| `ERROR_TRACKING_DSN` | — | — | A Sentry-compatible DSN (Sentry, GlitchTip). **Unset means off, and nothing leaves the process.** When set, whatever is logged at `error` is also reported, cleaned exactly as the log is (D-96). A report gives up after five seconds, is never redirected, and carries no absolute path of the machine. Must be `https://` in production; a malformed value refuses to start. **No telemetry is ever collected from a self-hosted deployment** (D-44): there is no default |
| `TRUST_PROXY` | — | `false` | Set `true` behind **exactly one** reverse proxy that sets `X-Forwarded-For`; the last entry is then the client (D-81). Without it the socket's peer address is the client and the header is ignored, because anyone can write it. It keys the sign-in rate limit and fills `sessions.ip_address`. Wrong either way hurts: `false` behind a proxy puts every user in one bucket; `true` with none lets a caller choose its own address |

## Database

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | `postgres://user:pass@host:5432/purlay` |
| `DATABASE_POOL_MAX` | — | `10` | Connection pool ceiling |
| `DATABASE_SSL` | — | `false` | Required by most managed PostgreSQL providers. Verifies the server's certificate. `bun run db:migrate` reads it too. **Production refuses `false`** unless `DATABASE_ALLOW_PLAINTEXT` is set (D-79) |
| `DATABASE_ALLOW_PLAINTEXT` | — | `false` | Production only: acknowledges that the database link is not encrypted because the network is private (a compose network, a unix socket). Without it production will not start on `DATABASE_SSL=false`. It does not turn TLS off by itself |
| `DATABASE_SSL_CA_FILE` | — | — | Path to a PEM file of the certificate authority to trust instead of the system's, for a private or managed root. Needs `DATABASE_SSL=true`; a file that cannot be read stops the boot (D-87) |
| `MIGRATE_ON_START` | — | unset (off) | Apply pending migrations when the process starts. Safe on any number of nodes: the migrator's lock makes them take turns, and the others report not ready until it is done (D-93). Under heavy write load a migration may be retried after a deadlock (logged at `warn`); migrate at low traffic (D-86). Set `true` in a deployment; leave it off in development, where `bun run db:migrate` is explicit |

**The pool's limits are fixed, not configured** (D-87): a number an operator can lower into an outage is
a number to keep out of the environment. They are in `POOL_DEFAULTS` (`packages/db/src/client.ts`).

| Limit | Value | When it trips |
|---|---|---|
| Wait for a free connection | 3 s | The query fails with `DATABASE_UNAVAILABLE` (`503`) instead of queuing |
| `statement_timeout` | 30 s | The server cancels the statement. Not applied to `db:migrate`, whose index builds take as long as they take |
| `idle_in_transaction_session_timeout` | 15 s | The server ends a session that opened a transaction and stopped |
| Idle connection | 30 s | The pool closes a connection nobody has used |
| `application_name` | `purlay-api` | Shown in `pg_stat_activity`, so a stuck session can be traced to this service |

## Authentication

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GITHUB_CLIENT_ID` | ✅ | — | OAuth app client id. Requested scopes are `read:user user:email` and nothing more (D-38) |
| `GITHUB_CLIENT_SECRET` | ✅ | — | **Secret.** Never logged |
| `SESSION_TTL_DAYS` | — | `30` | Cookie and `sessions.expires_at` lifetime |
| `ENCRYPTION_KEY` | ✅ | — | **Secret.** 32 bytes, base64 (44 characters, one `=`): `openssl rand -base64 32`. Decoded at boot; canonical base64 only; a key that is a pattern (repeated, sequential, few distinct bytes) is refused, and production refuses the public development key (D-79). Encrypts `github_integrations.access_token_encrypted`. Rotating it invalidates stored integration tokens |
| `ENCRYPTION_ALGORITHM` | — | `aes-256-gcm` | Fixed. Documented so two call sites cannot encrypt differently (D-39) |

The OAuth callback URL registered with GitHub must be `${APP_URL}/auth/github/callback`. That is
the client's origin **and** the API's: the browser talks to one origin, and development is
proxied so it matches (D-61). There is no separate API URL to configure.

**Nobody is joined to a workspace by signing in.** The first person creates one; everyone after
is invited with a link (D-115). `WORKSPACE_OPEN_JOIN_SLUG`, which joined every signed-in user to
one workspace in Phase 0 (D-37), is retired: set, the API refuses to start and says so, rather than
ignoring it and leaving an operator to wonder why nobody is let in.

## Object storage

| Variable | Required | Default | Notes |
|---|---|---|---|
| `S3_ENDPOINT` | production | — | Garage locally (`http://localhost:9000` after `bun run db:up`), any S3-compatible endpoint in production |
| `S3_REGION` | — | `us-east-1` | |
| `S3_BUCKET` | production | — | |
| `S3_ACCESS_KEY_ID` | production | — | Garage's format: `GK` and 24 hex digits |
| `S3_SECRET_ACCESS_KEY` | production | — | **Secret** |
| `STORAGE_DIRECTORY` | — | — | A directory attachments are kept in **instead of a bucket** — the demonstration and the browser suite (D-117). Production refuses to start with it; with the `S3_*` variables it is refused too: one store or the other |
| `VAPID_PUBLIC_KEY` | — | — | Web Push's application-server public key: the uncompressed P-256 point, base64url (RFC 8292, #78). With `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`, all three or none; **none switches push off** and the API says so — production starts without it, since the in-app inbox is the record (D-12) |
| `VAPID_PRIVATE_KEY` | — | — | Its private scalar, base64url. A secret: kept where the other secrets are, never logged |
| `VAPID_SUBJECT` | — | — | Who runs this server, for a push service that needs to reach them: `mailto:` an address, or the `https:` address of the deployment |

The four without a default are **all set or none** (D-109). None, outside production, is a server that
refuses every upload with `503 STORAGE_UNAVAILABLE` rather than pretending; production does not start
without them. A filesystem store for the simplest self-host (D-16) is not built yet, so
`STORAGE_DRIVER` and `STORAGE_LOCAL_PATH` are not read.

Storage keys are opaque and never served as public URLs — downloads are brokered by the API so
workspace membership is actually checked (`ARCHITECTURE.md` §9).

## Interface

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CLIENT_DIST` | — | — | Absolute path of the built client (`apps/web/dist`), which the API then serves from the one origin (`API.md` §8, D-61). **Set but without an `index.html` refuses to start.** Unset serves no client, as in development, where Vite does. The image sets it |
| `DEFAULT_LOCALE` | — | `en` | `en` \| `tr`. The fallback when the browser asks for neither (D-41). Read once the interface is translated (#109) |

## Cloud only — Phase 2.5

Every variable here is **unset in a self-hosted deployment**, and the features they configure are
inert without them. A self-hoster never holds a payment or telemetry credential, and nothing about
the free path gets harder because the cloud exists. (D-1, D-44)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CLOUD_MODE` | — | `false` | Enables billing, metering and the operator surfaces. Off means the deployment behaves exactly as it did before the cloud existed |
| `REDIS_URL` | cloud | — | Shared `EventBus`, `PresenceRegistry` and `RateLimiter` adapters (D-7, D-25). **Never required for self-hosting** |
| `BILLING_PROVIDER_KEY` | cloud | — | **Secret.** Merchant of record (D-43) |
| `BILLING_WEBHOOK_SECRET` | cloud | — | **Secret.** Signature verification on subscription events |
| `SMTP_URL` | cloud | — | **Secret.** Transactional email: receipts and Phase 2 magic links. Invitations are links, not email (D-115) |

## Limits

Runtime-tunable limits. The **enforced** values live where they are enforced; these only
configure what is not already a database constraint.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `UNFURL_CACHE_TTL_SECONDS` | — | `300` | Positive cache (`ARCHITECTURE.md` §8.3) |
| `UNFURL_NEGATIVE_TTL_SECONDS` | — | `3600` | Negative cache — without it one dead link re-hits the GitHub API forever |

> **HTTP limits are not configurable here either, and are provisional (O-4, D-81).** Sign-in: 30
> requests per client address at once, then one every two seconds. Writes: 10 a second with a burst
> of 20 per signed-in user, the socket's own budget. A refusal is `429` with `Retry-After`. The
> numbers live in `apps/api/src/ingress/http/rate-limit.ts`. The largest JSON body is 64 KiB, the
> socket's frame (D-80).
>
> The socket's limits are **not** configurable here. The frame cap is part of the wire contract —
> `MAX_FRAME_BYTES` in `@purlay/types` — so an operator changing it would part the server from every
> client built against it. The rate budget is one provisional number until **O-4** closes, in
> `apps/api/src/realtime/rate-limiter.ts` (D-66).
>
> Attachment size is **not** configurable here either: it is enforced by the `attachment_size_limit`
> CHECK constraint in `SCHEMA.md` §7.2. Changing it is a migration, deliberately — a limit the
> database enforces cannot be silently widened by an environment variable.
> Per-workspace storage quota is a column (`workspaces.storage_quota_bytes`), not an env var,
> because it varies per workspace.

---

## Local development

`docker compose` provides PostgreSQL and Garage, an S3-compatible object store. `bun run db:up`
starts them, waits for both to report healthy, and runs `scripts/storage-init.sh` to create the
bucket and the development key (`S3_ACCESS_KEY_ID` `GK000000000000000000000001`, secret in the
script); `bun run db:reset` throws the data away and starts again.

**Host ports are overridable**, because 5432 and 9000 are conventional and frequently already
taken — and a port collision is exactly the friction that turns *self-hosts it from the README*
into a support ticket (`PRD.md` §3, S-2):

| Variable | Default | For |
|---|---|---|
| `POSTGRES_PORT` | `5432` | Local development only; not read by the application |
| `STORAGE_PORT` | `9000` | S3 API |

Both are published on the **loopback address only** (`127.0.0.1`): the development database has a
superuser whose password is in the repository and the object store a published key, so a port open to
the network would be an open door on a developer's laptop or a shared CI host. To reach them from
another machine, forward a port (`ssh -L`); do not edit the binding.

`.env.example` lists exactly the variables the loader reads. It is generated from the loader
(`bun run config:example`), and CI fails if the committed file differs, so it cannot list a
variable the application ignores or miss one it reads.

**Database provisioning.** Identifier columns declare `COLLATE "C"` in the migrations, so the
server locale cannot change how channel names or emails compare (D-40). `/health/ready` asserts
this and refuses to report ready if the applied schema disagrees.

## Production deployment

`docker-compose.production.yml` brings up the API, PostgreSQL, Garage and a TLS proxy (Caddy) behind
**one public origin** (D-94, D-73). Its inputs are variables in an env file — the ones in the tables
above, plus the three the stack itself needs:

| Variable | Required | Notes |
|---|---|---|
| `PURLAY_IMAGE` | ✅ | The API image: `ghcr.io/<owner>/purlay-api@sha256:…` (a digest) or `:sha-<commit>`. Never a moving tag. Published by `image.yml` from main; while the pipeline cannot run, `scripts/release-image.sh` publishes a merged commit from a machine and prints the digest — without the workflow's attestations (D-92) |
| `POSTGRES_PASSWORD` | ✅ | **Secret.** Used as-is inside `DATABASE_URL`, so it must be URL-safe: `openssl rand -hex 16` |
| `GARAGE_RPC_SECRET` | ✅ | **Secret.** 64 hex characters: `openssl rand -hex 32` |

Production refuses an unsafe configuration at boot (D-79), so the stack sets what that asks of a
private network and an operator must supply the rest. The stack sets `NODE_ENV=production`, `PORT`,
`TRUST_PROXY=true` (Caddy is the one proxy and sets `X-Forwarded-For`, D-81), `DATABASE_URL` (from
`POSTGRES_PASSWORD`), `DATABASE_SSL=false` with `DATABASE_ALLOW_PLAINTEXT=true` (the database is on the
stack's private network and nothing else joins it; `DATABASE_SSL_CA_FILE` is therefore not set),
`MIGRATE_ON_START=true` and `S3_ENDPOINT`. It passes through `APP_URL` (**`https://`**),
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ENCRYPTION_KEY` (**32 random bytes in base64**:
`openssl rand -base64 32`; production refuses the development key and a repeated value),
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (required) and `LOG_LEVEL`, `ERROR_TRACKING_DSN`, `DATABASE_POOL_MAX`,
`SESSION_TTL_DAYS`, `S3_REGION`, `S3_BUCKET` (optional). `docker compose`
refuses to start with a required one missing, and names it. Garage wants its own key format:
`S3_ACCESS_KEY_ID` is `GK` plus 24 hex digits (`echo GK$(openssl rand -hex 12)`) and
`S3_SECRET_ACCESS_KEY` is 64 hex digits.

`docker/production.env.example` is the file to start from: every required variable is in it, the
secrets empty (so an unedited copy stops `docker compose` and names the first, instead of starting a stack
with a default password), the optional ones commented with their defaults. A test keeps it and the
compose file in step.

```
cp docker/production.env.example production.env      # fill in the empty values; keep it private
docker compose -f docker-compose.production.yml --env-file production.env up -d --wait
scripts/production-init.sh            # once: the storage layout, bucket and key
```

**Ports.** The proxy publishes 80 and 443 (and 443/udp for HTTP/3). `HTTP_PORT` and `HTTPS_PORT`
(optional, defaults 80 and 443) move them on the host. The caveats are real: the HTTPS port is the same
inside and outside the container, because Caddy listens on the port in its site address, which is
`APP_URL`, so `HTTPS_PORT=8443` needs `APP_URL=https://host:8443`; and a certificate from a public CA is
issued only if 80 and 443 can be reached from the internet, so moving them is for a host that already
uses them, a deployment behind another proxy, or one with certificates of its own.

**The scheduled jobs** run in the `scheduler` service, from the same image with the same settings
(D-30): sessions hourly; the orphan sweep, the storage reconciliation and the expired link previews
nightly, in UTC. When it starts it first runs, once, each job that has never succeeded (`jobs:first`), so a
new deployment is proven, and its status is clean, from its first minute (D-30). Every run is
recorded; to see when each last succeeded, and whether one is overdue or has never run:

```
docker compose -f docker-compose.production.yml --env-file production.env \
  exec scheduler bun apps/api/src/cli/jobs.ts jobs:status
```

It exits non-zero when a job is overdue, so a monitor can run it.

**Every container's log is bounded**: five files of 50 MB each per service, so the server's disk is
never filled by its own logs. For the API that is weeks of a team's requests; the stretch `bun run
report:frames` needs (O-4) is exported with `docker compose … logs api` before it rolls over.

**The proxy's access log** records the path and never the query string: an OAuth callback carries a
one-time `code` and the signed `state` there, and a search carries what was searched for.

`APP_URL` is also the proxy's site address, so the origin Caddy answers for and the one the API checks
sockets against cannot differ; with a public name and ports 80 and 443 reachable, the certificate is
issued and renewed automatically. Only the proxy publishes ports.
Back up with `scripts/backup.sh`; restore with `scripts/restore.sh <dir>`, which by default restores
into a **new** database and a **new** bucket (`purlay_restore`, `<S3_BUCKET>-restore`) and touches
nothing live; prove it with `scripts/compare-databases.sh` (D-95). To recover over the live
database, stop the API and run `scripts/restore.sh <dir> --database purlay --replace --bucket live`. `--no-bucket` restores the database alone, which is what rolling back an upgrade needs (attachments are only ever added).

**Backups run from the host's cron**, not from the stack: `backup.sh` drives `docker compose` from
outside, which no container of the stack can do (D-30's scheduler runs application jobs). These two
lines, with the deployment in `/srv/purlay` and backups kept for fourteen days, were run as written
under cron's bare environment (`env -i`, `PATH=/usr/bin:/bin`) against the production stack:

```
# crontab -e, as the user who owns /srv/purlay and may run docker
PATH=/usr/bin:/bin
30 2 * * * cd /srv/purlay && scripts/backup.sh /srv/purlay-backups >>/srv/purlay-backups/backup.log 2>&1
45 2 * * * find /srv/purlay-backups -mindepth 1 -maxdepth 1 -type d -name 'purlay-*' -mtime +14 -exec rm -rf {} +
```

`backup.sh` exits non-zero and leaves nothing that looks like a backup when it fails, so the log is
where a failed night shows; copying the directory off the host, and encrypting it there, is the
operator's (`docs/spikes/backup-restore.md`). A backup nobody restored is a belief (D-44). Before the
team moves in, restore the newest whole — `scripts/restore.sh <dir>`, database and bucket — and judge
it with `scripts/compare-databases.sh purlay purlay_restore`. Then monthly, the database alone, which
repeats cleanly (rehearsed twice in a row):

```
scripts/restore.sh /srv/purlay-backups/<newest> --no-bucket
scripts/compare-databases.sh purlay purlay_restore      # must say "identical"
docker compose -f docker-compose.production.yml --env-file production.env \
  exec -T postgres dropdb -U purlay purlay_restore
```

Without the last line the next rehearsal refuses: `purlay_restore` already has tables, and a restore
never overwrites what it did not make unless told `--replace`.

**Upgrading, rolling back and keeping `ENCRYPTION_KEY`:** `ARCHITECTURE.md` §11, "Upgrading and rolling back".

**Who can read a backup:** only the user who ran `backup.sh` (directory `0700`, files `0600`,
whatever the umask). It holds every message and every e-mail address in the clear, so where it is
copied, and whether it is encrypted there, is the operator's decision. `ENCRYPTION_KEY` is **not** in
the backup, by design: keep it separately.

**Production checklist:** `APP_URL` is `https://` · `ENCRYPTION_KEY` generated with a CSPRNG and
backed up · `DATABASE_SSL=true` on managed PostgreSQL · `TRUST_PROXY=true` behind a proxy ·
`LOG_LEVEL=info` or higher, never `debug` (it is verbose, not secret-leaking, but noisy).
