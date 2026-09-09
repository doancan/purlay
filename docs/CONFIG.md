# Purlay — Configuration (`CONFIG.md`)

Single source of truth for environment variables. `ARCHITECTURE.md` requires the config loader
to **validate every variable at boot and refuse to start otherwise** — a missing secret must
fail loudly at startup, never at 3am on the first request that needs it.

Variables marked **required** have no default. Anything holding a secret is never logged.

---

## Core

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | — | `development` | `development` \| `test` \| `production` |
| `PORT` | — | `3001` | API listen port |
| `APP_URL` | ✅ | — | Public origin of the web client. Used for OAuth redirects and CORS. Must be `https://` in production. |
| `LOG_LEVEL` | — | `info` | `debug` \| `info` \| `warn` \| `error` |
| `TRUST_PROXY` | — | `false` | Set `true` behind a reverse proxy so client IPs in `sessions.ip_address` are real |

## Database

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | `postgres://user:pass@host:5432/purlay` |
| `DATABASE_POOL_MAX` | — | `10` | Connection pool ceiling |
| `DATABASE_SSL` | — | `false` | Required by most managed PostgreSQL providers |

## Authentication

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GITHUB_CLIENT_ID` | ✅ | — | OAuth app client id. Requested scopes are `read:user user:email` and nothing more (D-38) |
| `GITHUB_CLIENT_SECRET` | ✅ | — | **Secret.** Never logged |
| `SESSION_TTL_DAYS` | — | `30` | Cookie and `sessions.expires_at` lifetime |
| `ENCRYPTION_KEY` | ✅ | — | **Secret.** 32 bytes, base64. Encrypts `github_integrations.access_token_encrypted`. Rotating it invalidates stored integration tokens |
| `WORKSPACE_OPEN_JOIN_SLUG` | — | — | When set, any authenticated user is joined to that workspace as `member` on sign-in. Unset means the instance is closed. (D-37) |
| `ENCRYPTION_ALGORITHM` | — | `aes-256-gcm` | Fixed. Documented so two call sites cannot encrypt differently (D-39) |

The OAuth callback URL registered with GitHub must be `${APP_URL}/auth/github/callback`.

**On `WORKSPACE_OPEN_JOIN_SLUG`.** Phase 0 cannot reach its exit criterion without it —
invitations are Phase 1, so a second user otherwise has no way into a workspace. The boot log
states which workspace is open: an instance that quietly accepts anyone with a GitHub account is
not something an operator should discover by accident.

## Object storage

| Variable | Required | Default | Notes |
|---|---|---|---|
| `STORAGE_DRIVER` | — | `s3` | `s3` \| `filesystem` |
| `STORAGE_LOCAL_PATH` | driver=filesystem | — | Absolute path; must survive container restarts |
| `S3_ENDPOINT` | driver=s3 | — | MinIO locally, any S3-compatible endpoint in production |
| `S3_REGION` | driver=s3 | `us-east-1` | |
| `S3_BUCKET` | driver=s3 | — | |
| `S3_ACCESS_KEY_ID` | driver=s3 | — | **Secret** |
| `S3_SECRET_ACCESS_KEY` | driver=s3 | — | **Secret** |

Storage keys are opaque and never served as public URLs — downloads are brokered by the API so
workspace membership is actually checked (`ARCHITECTURE.md` §9).

## Interface

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DEFAULT_LOCALE` | — | `en` | `en` \| `tr`. The fallback when the browser asks for neither (D-41) |

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
| `WS_RATE_LIMIT_PER_SECOND` | — | `10` | Provisional pending **O-4** |
| `WS_RATE_LIMIT_BURST` | — | `20` | Provisional pending **O-4** |
| `WS_MAX_FRAME_BYTES` | — | `65536` | 64 KB (`ARCHITECTURE.md` §5.5) |
| `UNFURL_CACHE_TTL_SECONDS` | — | `300` | Positive cache (`ARCHITECTURE.md` §8.3) |
| `UNFURL_NEGATIVE_TTL_SECONDS` | — | `3600` | Negative cache — without it one dead link re-hits the GitHub API forever |

> Attachment size is **not** configurable here: it is enforced by the `attachment_size_limit`
> CHECK constraint in `SCHEMA.md` §7.2. Changing it is a migration, deliberately — a limit the
> database enforces cannot be silently widened by an environment variable.
> Per-workspace storage quota is a column (`workspaces.storage_quota_bytes`), not an env var,
> because it varies per workspace.

---

## Local development

`docker compose` provides PostgreSQL and MinIO. A `.env.example` ships with Phase 0 and must
list every variable above — a variable added to the loader without being added there is a bug.

**Database provisioning.** Identifier columns declare `COLLATE "C"` in the migrations, so the
server locale cannot change how channel names or emails compare (D-40). `/health/ready` asserts
this and refuses to report ready if the applied schema disagrees.

**Production checklist:** `WORKSPACE_OPEN_JOIN_SLUG` is unset unless open join is genuinely
intended · `APP_URL` is `https://` · `ENCRYPTION_KEY` generated with a CSPRNG and
backed up · `DATABASE_SSL=true` on managed PostgreSQL · `TRUST_PROXY=true` behind a proxy ·
`LOG_LEVEL=info` or higher, never `debug` (it is verbose, not secret-leaking, but noisy).
