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
| `GITHUB_CLIENT_ID` | ✅ | — | OAuth app client id |
| `GITHUB_CLIENT_SECRET` | ✅ | — | **Secret.** Never logged |
| `SESSION_TTL_DAYS` | — | `30` | Cookie and `sessions.expires_at` lifetime |
| `ENCRYPTION_KEY` | ✅ | — | **Secret.** 32 bytes, base64. Encrypts `github_integrations.access_token_encrypted`. Rotating it invalidates stored integration tokens |

The OAuth callback URL registered with GitHub must be `${APP_URL}/auth/github/callback`.

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

**Production checklist:** `APP_URL` is `https://` · `ENCRYPTION_KEY` generated with a CSPRNG and
backed up · `DATABASE_SSL=true` on managed PostgreSQL · `TRUST_PROXY=true` behind a proxy ·
`LOG_LEVEL=info` or higher, never `debug` (it is verbose, not secret-leaking, but noisy).
