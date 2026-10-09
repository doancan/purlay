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
| `TRUST_PROXY` | — | `false` | Set `true` behind **exactly one** reverse proxy that sets `X-Forwarded-For`; the last entry is then the client (D-81). Without it the socket's peer address is the client and the header is ignored, because anyone can write it. It keys the sign-in rate limit and fills `sessions.ip_address`. Wrong either way hurts: `false` behind a proxy puts every user in one bucket; `true` with none lets a caller choose its own address |

## Database

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | `postgres://user:pass@host:5432/purlay` |
| `DATABASE_POOL_MAX` | — | `10` | Connection pool ceiling |
| `DATABASE_SSL` | — | `false` | Required by most managed PostgreSQL providers. **Production refuses `false`** unless `DATABASE_ALLOW_PLAINTEXT` is set (D-79) |
| `DATABASE_ALLOW_PLAINTEXT` | — | `false` | Production only: acknowledges that the database link is not encrypted because the network is private (a compose network, a unix socket). Without it production will not start on `DATABASE_SSL=false`. It does not turn TLS off by itself |

## Authentication

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GITHUB_CLIENT_ID` | ✅ | — | OAuth app client id. Requested scopes are `read:user user:email` and nothing more (D-38) |
| `GITHUB_CLIENT_SECRET` | ✅ | — | **Secret.** Never logged |
| `SESSION_TTL_DAYS` | — | `30` | Cookie and `sessions.expires_at` lifetime |
| `ENCRYPTION_KEY` | ✅ | — | **Secret.** 32 bytes, base64 (44 characters, one `=`): `openssl rand -base64 32`. Decoded at boot; a key of one repeated value is refused, and production refuses the public development key (D-79). Encrypts `github_integrations.access_token_encrypted`. Rotating it invalidates stored integration tokens |
| `WORKSPACE_OPEN_JOIN_SLUG` | — | — | When set, any authenticated user is joined to that workspace as `member` on sign-in. Unset means the instance is closed. (D-37) |
| `ENCRYPTION_ALGORITHM` | — | `aes-256-gcm` | Fixed. Documented so two call sites cannot encrypt differently (D-39) |

The OAuth callback URL registered with GitHub must be `${APP_URL}/auth/github/callback`. That is
the client's origin **and** the API's: the browser talks to one origin, and development is
proxied so it matches (D-61). There is no separate API URL to configure.

**On `WORKSPACE_OPEN_JOIN_SLUG`.** Phase 0 cannot reach its exit criterion without it —
invitations are Phase 1, so a second user otherwise has no way into a workspace. The boot log
states which workspace is open, and says so when none is: an instance that quietly accepts anyone
with a GitHub account is not something an operator should discover by accident.

A slug that names no workspace yet admits nobody, and does not stop anyone signing in — it is the
normal state before the operator creates the workspace. Whoever **first** creates a workspace with
that slug owns the one everyone then joins, so create it before telling anyone the URL. An existing
membership is never changed by signing in: the owner stays the owner.

## Object storage

| Variable | Required | Default | Notes |
|---|---|---|---|
| `STORAGE_DRIVER` | — | `s3` | `s3` \| `filesystem` |
| `STORAGE_LOCAL_PATH` | driver=filesystem | — | Absolute path; must survive container restarts |
| `S3_ENDPOINT` | driver=s3 | — | Garage locally, any S3-compatible endpoint in production |
| `S3_REGION` | driver=s3 | `us-east-1` | |
| `S3_BUCKET` | driver=s3 | — | |
| `S3_ACCESS_KEY_ID` | driver=s3 | — | **Secret** |
| `S3_SECRET_ACCESS_KEY` | driver=s3 | — | **Secret** |

Storage keys are opaque and never served as public URLs — downloads are brokered by the API so
workspace membership is actually checked (`ARCHITECTURE.md` §9).

## Interface

| Variable | Required | Default | Notes |
|---|---|---|---|
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
| `SMTP_URL` | cloud | — | **Secret.** Transactional email: invitations, receipts, and Phase 2 magic links |
| `ERROR_TRACKING_DSN` | cloud | — | Sentry-compatible. **No telemetry is ever collected from a self-hosted deployment** (D-44) |

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

`.env.example` lists exactly the variables the loader reads. It is generated from the loader
(`bun run config:example`), and CI fails if the committed file differs, so it cannot list a
variable the application ignores or miss one it reads.

**Database provisioning.** Identifier columns declare `COLLATE "C"` in the migrations, so the
server locale cannot change how channel names or emails compare (D-40). `/health/ready` asserts
this and refuses to report ready if the applied schema disagrees.

**Production checklist:** `WORKSPACE_OPEN_JOIN_SLUG` is unset unless open join is genuinely
intended · `APP_URL` is `https://` · `ENCRYPTION_KEY` generated with a CSPRNG and
backed up · `DATABASE_SSL=true` on managed PostgreSQL · `TRUST_PROXY=true` behind a proxy ·
`LOG_LEVEL=info` or higher, never `debug` (it is verbose, not secret-leaking, but noisy).
