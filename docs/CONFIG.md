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
| `GITHUB_CLIENT_ID` | — | unset | OAuth app client id. Requested scopes are `read:user user:email` and nothing more (D-38). **A seed**: read on the first start only, into the server's settings, and ignored after (below). **Both of this and `GITHUB_CLIENT_SECRET`, or neither**: one without the other refuses to start. Neither is how a fresh server starts: it waits in setup mode, and the setup page connects GitHub |
| `GITHUB_CLIENT_SECRET` | — | unset | **Secret.** Never logged. **A seed**, as `GITHUB_CLIENT_ID`, and set with it or not at all; kept encrypted in the settings |
| `GITHUB_URL` | — | `https://github.com` | Where a GitHub sign-in is sent to authorise and its code is redeemed (`/login/oauth/…`). Another only for a GitHub Enterprise Server, or for a stand-in for GitHub on this machine in a run that cannot reach the real one. `https://`, or `http://` to `localhost`, `127.0.0.1` or `[::1]` alone, in any environment; a path is kept, a trailing slash dropped, and credentials, a query or a fragment refused. A deployment's shape, not a setting: never in the browser (D-179) |
| `GITHUB_API_URL` | — | `https://api.github.com` | GitHub's API, where a sign-in reads the person and their addresses (`/user`, `/user/emails`): `https://<host>/api/v3` on an Enterprise Server. Checked as `GITHUB_URL` is |
| `SESSION_TTL_DAYS` | — | `30` | Cookie and `sessions.expires_at` lifetime |
| `WORKSPACE_CREATORS` | — | unset | **A seed**, as `GITHUB_CLIENT_ID`. Who may make a workspace (D-155): GitHub logins, comma-separated, matched in any case against the login GitHub last gave each account signed in with it — never its username here, which may carry a `-N` (D-169); an account made by an email link has no login, or `*` for anybody signed in. **Unset, nobody may but the first person to sign in, and only while the instance has no workspace** — the one-command install. Signing in stays open, so an invited person can; anybody else signed in is told to ask for an invitation. Set it before an instance is first started if more than its first person should make workspaces; a malformed value refuses to start |
| `ENCRYPTION_KEY` | ✅ | — | **Secret.** 32 bytes, base64 (44 characters, one `=`): `openssl rand -base64 32`. Decoded at boot; canonical base64 only; a key that is a pattern (repeated, sequential, few distinct bytes) is refused, and production refuses the public development key (D-79). Encrypts `github_integrations.access_token_encrypted` and the secrets of the server's settings (below). Rotating it invalidates stored integration tokens and those secrets |
| `ENCRYPTION_ALGORITHM` | — | `aes-256-gcm` | Fixed. Documented so two call sites cannot encrypt differently (D-39) |

The OAuth callback URL registered with GitHub must be `${APP_URL}/auth/callback/github` (D-179; the
setup wizard shows it, computed from the server address). That is
the client's origin **and** the API's: the browser talks to one origin, and development is
proxied so it matches (D-61). There is no separate API URL to configure.

**Nobody is joined to a workspace by signing in.** The first person creates one; everyone after
is invited with a link (D-115), and makes a workspace of their own only if the server's setting —
first `WORKSPACE_CREATORS` — names them (D-155). `WORKSPACE_OPEN_JOIN_SLUG`, which joined every signed-in user to
one workspace in Phase 0 (D-37), is retired: set, the API refuses to start and says so, rather than
ignoring it and leaving an operator to wonder why nobody is let in.

### What leaves the environment (D-179)

A server is set up in the browser, so what a person can type there stops being an environment variable.
Its home is the database's `server_settings` row (`SCHEMA.md`), read by the server as it starts, once
its migrations are in.

| A seed of the settings | Where it is changed after the first start |
|---|---|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | the setup wizard's GitHub step, then Administration → Server; the secret is stored encrypted and never shown again |
| `SMTP_URL`, `MAIL_FROM`, `SMTP_ALLOW_PLAINTEXT` | the wizard's email step, then Administration → Server; the address is stored encrypted, since it carries the relay's password, and shown only as its host — not even the user, which for some relays is the token |
| `WORKSPACE_CREATORS` | Administration → Server; the rule is D-155's |
| Who may sign up (`invite-only` or `open`) | no variable: one choice in setup, then Administration → Server; `invite-only` by default |

**Imported once.** On the first start of a database — no settings yet — the values above are copied
into the settings in one transaction, and from then on **the database is the only home**: changing a
variable afterwards does nothing, and every start names the ones still set, in one line of the log
(`settings are the database's; these variables are ignored`), never their values. Two nodes starting
together import once. A variable left unset is a setting left at its default: **a server started with no
GitHub variable imports a row with no GitHub app**, and starts in setup mode — it serves, its sign-in
screen says it is not set up yet, and `/auth/github` answers `404` — until the setup page connects GitHub
or mail. Nothing in the environment but the database, `ENCRYPTION_KEY`, `APP_URL` and the storage is
needed to start one.

**Applied at once, without a restart.** Every setting in the table above takes effect from the next
request once it is saved through the setup page or Administration → Server (both land together with this
mechanism; nothing else saves them): the server builds a new sign-in library and mail relay from what it
saved, checks them, and swaps them in, while a request already in flight finishes on the old ones. GitHub
and email sign-in appear and disappear with their settings; sessions are kept. A change that cannot be
built or checked saves nothing and the server serves as before, and none is taken while the server shuts
down. One visible edge: somebody halfway through a GitHub sign-in when the GitHub app itself is replaced
comes back to the sign-in screen with an error — the code GitHub gave was for the old app — and simply
signs in again.
If the page says to **restart the server** (`docker compose … restart api`), the database did not confirm
the save, or the replaced relay could not be let go: a start serves exactly what the database holds
(D-179 §4.9). Editing `server_settings` by hand, as the recovery below does, is read at the next start
only.

**What stays in the environment** is what the process needs before it can read a setting or serve at
all: `DATABASE_URL` and the database variables, `ENCRYPTION_KEY`, the storage (`S3_*` and the stack's
own), `PORT`, `TRUST_PROXY`, logging, `GITHUB_URL` and `GITHUB_API_URL` (where GitHub is: the shape of
the deployment, not a choice in the browser), and **`APP_URL`**: the cookies, the origin checks and the
sign-in library are fixed by it when they are built, so the server's address is a deployment setting —
the wizard shows it, and the callback GitHub needs, and does not change it. The secret Better Auth signs
cookies with is derived from `ENCRYPTION_KEY`, so no variable is added, and is **never a server
setting** and never edited in the browser, because changing it signs everyone out (D-179 §3).
`ENCRYPTION_KEY` also opens the settings' secrets: rotating it leaves the GitHub secret and the relay's
address unreadable. The server **still starts**, in setup mode, with those two read as unset: one
`warn` line in the log names which (`github`, `smtp`) and points here, never a value. **Nothing is
deleted**: the unreadable value stays in the database until a new one is saved over it. A value that is
truncated or corrupt is treated the same as one sealed under another key. **The recovery is in the browser** where the administrator can still sign in — and the
password always works, whichever way the server's other sign-in methods stand: **Settings → Server**
(Administration → Server, `API.md` §2 `/api/server/*`) lists `needsReentry` and says on the card of each
affected secret *This secret could not be opened with the current key — enter it again*; entering it tries
it with GitHub or the relay and seals it under the current key. Nothing else is needed. Without a
browser to hand, or for every case at once: put the old `ENCRYPTION_KEY` back, and everything opens as it
did; or clear the two **and reopen the import**, so the next start copies every seed variable above in
again from the environment — `WORKSPACE_CREATORS` too, so set it as it should be, and the GitHub and mail
variables must be in the environment of that start — sealed under the new key:
`UPDATE server_settings SET github_client_id = NULL, github_client_secret_encrypted = NULL, smtp_url_encrypted = NULL, mail_from = NULL, imported_from_env_at = NULL WHERE id;`
Without `imported_from_env_at = NULL` the next start would ignore the environment and stay without them.
A test runs this statement as written here. A row that fails to decode for any other reason still
refuses to start.

**A forgotten administrator password** is set again on the server, by whoever runs it — no mail and no
browser can do it:

```
docker compose … exec api bun run admin:reset-password admin@example.com
```

(or `bun run admin:reset-password <email>` where the repository is checked out, with `DATABASE_URL`
naming the database). It is for the **server's administrator** only — the account the setup made; any
other address is refused, in the words an unknown address gets. The new password is typed at the prompt,
with nothing shown and asked twice, or — standard input not being a terminal — read from its first line,
as in `printf '%s\n' "$NEW" | bun run …`. It is **never read from an argument or from the
environment**, which the shell, the process table and the logs keep: a second argument is refused without
being repeated. The password policy applies. It prints `Password changed for <email>` and nothing else of
it, and **ends every session of that account** in the same transaction, so a session that was stolen dies
with the old password. An administrator who came in only through GitHub is given a password by it. It leaves a row on the
server's own trail (`server.admin_password_reset`). A connection the account holds open in a browser is
ended by the server within about half a minute — the command has no way to tell it, so the server asks
the database every thirty seconds which sessions still exist — and the same is true of a session removed
by SQL.

**The setup code** (D-179 §4). A server with no user is set up in the browser at `APP_URL/setup`, which
asks first for a one-time code. The code is in the API's log, never anywhere else — not in the database
(it keeps a digest), not in a response:

```sh
docker compose -f docker-compose.production.yml --env-file production.env logs api | grep 'SETUP CODE'
```

It is one line at `warn`, its field `setupCode`, twenty letters and digits in five groups
(`7KQ2-…`); case, spaces and dashes do not matter when it is typed. It opens for **one hour**. **Every
start writes a new one** while the server is open to setup, and the newest is the only one that opens it;
with `LOG_LEVEL=error` the line is not written, so leave the level at `info` or `warn` until setup is
done. A code is spent by the browser it lets in, and that browser carries on from where it stopped
whenever it comes back. Lost that browser — another one, cookies cleared, or a day without it — wait
until it has been idle **fifteen minutes**, **restart the API** (`docker compose … restart api`) and
enter the new code: it takes the unfinished setup over at the step it had reached. A setup whose browser
was seen within fifteen minutes cannot be taken by any code, so a code found later in a kept log cannot
take a setup from someone at work on it.

Five wrong codes lock setup for fifteen minutes, for everybody, the right code included. The lock
belongs to the code: **a restart clears it** with the new code it writes — which helps only against a
slow guesser. Somebody sending wrong codes without pause locks each new code five requests after the
start, and neither a restart nor the statement below lets you in. The `/setup` endpoints limit each
client — ten codes in fifteen minutes from one address, or one IPv6 /64 (D-179 §4.10) — so one client
cannot do it fast; many clients still can, and the way out is to block the sources (or keep `/setup` off
the public network until setup is done). Behind a proxy, set `TRUST_PROXY` so the limit sees the client's
address and not the proxy's.
To clear a lock without a restart:
`UPDATE setup_state SET failed_attempts = 0, locked_until = NULL WHERE id;` (a test runs this statement
as written here). Once the server has a user other than the administrator an unfinished setup made, or
the setup is finished, every start says `setup is closed` instead and no code is written again; only a
server with no user at all — a fresh install — is open to setup.

### Upgrading a server from before the sign-in library (D-179 §7)

Start the new version with the old environment and `MIGRATE_ON_START` (or run `bun run db:migrate`
first): migrations 0047 to 0055 apply to the data as it is — people, workspaces, messages and
invitations are kept — and the server is **closed to setup from the first start** (it has users), so no
setup code is written. `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `SMTP_URL` and `MAIL_FROM` already in
the environment are copied into the settings on that first start, once; keep them there for it. Three
things the operator should know:

- **Everyone signs in again.** The library's cookie is a signed value that the old opaque cookie is not;
  every old session is refused (`401`) and its row is left to the sweep. Nothing is lost but the session.
- **Nobody is the server's administrator yet**, so no one can open Administration → Server (`404`). Name
  one, as in *Recovery when there is no server administrator* below, then sign in: the guard reads the
  column on every request, so no restart is needed.
- **GitHub people and email people sign in as before**: migration 0055 gives each user with a `github_id`
  the account row the library finds them by, and marks the address of everyone who existed before the
  upgrade as verified — each proved it then, by GitHub's verified address or a spent link.

### Recovery when there is no server administrator

The server's administrator can be erased (the only one, from Account), and an upgraded install starts
without one. Nobody can then open Administration → Server (`404`), and no screen can name one. It is
named on the server, in the database, for an account that exists:

```sql
UPDATE users SET is_server_admin = TRUE WHERE email = '<address>' AND deleted_at IS NULL;
```

The guard reads the column on every request, so no restart is needed. If that account has no password
(it came in through GitHub or a link), give it one afterwards with
`bun run admin:reset-password <address>` (`docker compose … exec api bun run admin:reset-password <address>`
in the image): the command is the break-glass for the server's administrator, and it refuses any other
address, which is why the statement comes first.

## Object storage

| Variable | Required | Default | Notes |
|---|---|---|---|
| `S3_ENDPOINT` | production | — | Garage locally (`http://localhost:9000` after `bun run db:up`), any S3-compatible endpoint in production |
| `S3_REGION` | — | `us-east-1` | |
| `S3_BUCKET` | production | — | |
| `S3_ACCESS_KEY_ID` | production | — | Garage's format: `GK` and 24 hex digits |
| `S3_SECRET_ACCESS_KEY` | production | — | **Secret** |
| `STORAGE_DIRECTORY` | — | — | A directory attachments are kept in **instead of a bucket** — the demonstration and the browser suite (D-117). Production refuses to start with it; with the `S3_*` variables it is refused too: one store or the other |
| `VAPID_PUBLIC_KEY` | — | — | Web Push's application-server public key: the uncompressed P-256 point, base64url (RFC 8292, #78). With `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`, all three or none; **none switches push off** and the API says so — production starts without it, since the in-app inbox is the record (D-12). `bun run push:keys` prints a pair; the API refuses to start on a key spelled other than canonically, or on halves of two pairs |
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
| `SMTP_URL` | — | — | **Secret.** The SMTP server sign-in links are sent through, `smtp://` or `smtps://` with its credentials; with `MAIL_FROM`, or neither — neither is email sign-in off (D-138 §6). Mail to a relay past this machine goes only over TLS — `smtps://`, or STARTTLS required on `smtp://` — unless `SMTP_ALLOW_PLAINTEXT=true`: every message carries a sign-in link. Invitations are links, not email (D-115) |
| `MAIL_FROM` | — | — | The address sign-in links come from; set with `SMTP_URL`, or neither (D-138) |
| `SMTP_ALLOW_PLAINTEXT` | — | `false` | Says that the link to a relay past this machine is private, so `smtp://` need not upgrade to TLS — as `DATABASE_ALLOW_PLAINTEXT` does for the database (D-138 §6). A relay whose certificate no public authority signed is refused, the wizard's try included (`tls-failed`); nothing turns the check off. Give the server the authority instead: `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in its environment, read by the runtime at start (measured with Bun and nodemailer, `probes.integration.test.ts`) — or use a relay with a public certificate (D-179 §4.4) |

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
> Per-workspace storage quota is a column (`workspaces.storage_quota_bytes`, 5 GiB by default), not an
> env var, because it varies per workspace. It is the operator's to set, never an owner's (D-173):
> `bun run storage:quota <workspace slug>` prints what the workspace uses of it, and
> `bun run storage:quota <workspace slug> 20GiB` sets it — whole bytes or a whole number of `KiB`,
> `MiB`, `GiB` or `TiB`, decimal units refused. It runs with the server's environment, as the jobs do,
> and takes the workspace row's lock as an upload does. A quota below what is used deletes nothing;
> uploads are refused until there is room. Owners see the same numbers on Settings → Data & retention,
> and each change on the audit log as `storage.quota_changed`, from and to, by nobody in the workspace.

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
above, plus the four the stack itself needs:

| Variable | Required | Notes |
|---|---|---|
| `PURLAY_IMAGE` | ✅ | The API image: `ghcr.io/<owner>/purlay-api@sha256:…` (a digest) or `:sha-<commit>`. Never a moving tag. Published by `image.yml` from main; while the pipeline cannot run, `scripts/release-image.sh` publishes a merged commit from a machine of the server's architecture (Bun does not survive emulation, so it refuses another) and prints the digest — without the workflow's attestations (D-92) |
| `POSTGRES_PASSWORD` | ✅ | **Secret.** Used as-is inside `DATABASE_URL`, so it must be URL-safe: `openssl rand -hex 16` |
| `GARAGE_RPC_SECRET` | ✅ | **Secret.** 64 hex characters: `openssl rand -hex 32` |
| `GARAGE_ADMIN_TOKEN` | ✅ | **Secret.** Garage's admin API, which the one-shot `storage-init` uses to prepare the store on `up`; reachable inside the stack only: `openssl rand -hex 32` (D-144) |

Production refuses an unsafe configuration at boot (D-79), so the stack sets what that asks of a
private network and an operator must supply the rest. The stack sets `NODE_ENV=production`, `PORT`,
`TRUST_PROXY=true` (Caddy is the one proxy and sets `X-Forwarded-For`, D-81), `DATABASE_URL` (from
`POSTGRES_PASSWORD`), `DATABASE_SSL=false` with `DATABASE_ALLOW_PLAINTEXT=true` (the database is on the
stack's private network and nothing else joins it; `DATABASE_SSL_CA_FILE` is therefore not set),
`MIGRATE_ON_START=true` and `S3_ENDPOINT`. It passes through `APP_URL` (**`https://`**),
`ENCRYPTION_KEY` (**32 random bytes in base64**:
`openssl rand -base64 32`; production refuses the development key and a repeated value),
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (required) and `LOG_LEVEL`, `ERROR_TRACKING_DSN`, `DATABASE_POOL_MAX`,
`SESSION_TTL_DAYS`, `WORKSPACE_CREATORS`, `S3_REGION`, `S3_BUCKET`, the three `VAPID_*` (Web Push, off while empty) and
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (both or neither; empty is neither, and the server waits in setup mode), `SMTP_URL`, `MAIL_FROM`, `SMTP_ALLOW_PLAINTEXT` (email sign-in, off while empty), `GITHUB_URL`, `GITHUB_API_URL` (github.com while empty), all optional. `docker compose`
refuses to start with a required one missing, and names it. `--env-file` only fills the compose file's
placeholders: a variable it does not name never reaches the container, so the test that holds the stack
fails on any variable the API reads that is neither passed nor named there with the reason it is
withheld (`CLIENT_DIST`, set by the image; `STORAGE_DIRECTORY`; `DATABASE_SSL_CA_FILE`). Garage wants its own key format:
`S3_ACCESS_KEY_ID` is `GK` plus 24 hex digits (`echo GK$(openssl rand -hex 12)`) and
`S3_SECRET_ACCESS_KEY` is 64 hex digits.

`docker/production.env.example` is the file to start from: every required variable is in it, the
secrets empty (so an unedited copy stops `docker compose` and names the first, instead of starting a stack
with a default password), the optional ones commented with their defaults. A test keeps it and the
compose file in step.

```
cp docker/production.env.example production.env      # fill in the empty values; keep it private
docker compose -f docker-compose.production.yml --env-file production.env up -d --wait
```

That is the whole of it (#76, D-144). As it comes up, the one-shot `storage-init` service prepares
the object store — the node's place in the layout, the bucket, the application's key and its rights,
each only if missing — and checks that an anonymous read of the bucket is refused; the API starts only
once it has, and migrates the database as it starts. Every later `up` runs it again and it finds
nothing to do. Its output is `docker compose … logs storage-init`. `scripts/production-init.sh` does
the same by hand, through Garage's CLI, and is kept for a stack from before this service.

**The first person in** signs in with GitHub and makes the first workspace from the screen they land
on; they are its owner. Who else may join is decided by them, with invitation links (D-115). Nobody
else may make a workspace unless the server's setting names them — `WORKSPACE_CREATORS` on the first
start, the setting after (D-155, D-179 §6): somebody who finds the
address and signs in is told to ask for an invitation.

**Memory and processes are bounded per container** (#639): `API_MEMORY_LIMIT` (default `768m`),
`SCHEDULER_MEMORY_LIMIT` (`512m`), `STORAGE_INIT_MEMORY_LIMIT` (`256m`), `POSTGRES_MEMORY_LIMIT`
(`1536m`), `GARAGE_MEMORY_LIMIT` (`512m`) and `PROXY_MEMORY_LIMIT` (`256m`), each with a process limit.
Each default is several times what that container was measured to use — the API at 136 MiB under
the build target's load, 166 MiB at twice it — so a normal day never meets them, and a runaway takes its
own container down, which `restart` brings back, rather than the host (`docs/spikes/resources.md`).
Raise one on a larger server. No CPU limit is set: a throttled API answers late, which is worse
than one that shares.

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

It exits non-zero when a job is overdue or has failed since it last succeeded, and it is the
`scheduler` container's healthcheck, every minute after a ten-minute start (#635): such a job shows the
container as `unhealthy` in `docker ps` and to anything that watches container health. Unhealthy is a
signal, not a restart — the jobs are tried again on their own schedule. A job that fails is also logged
at `error`, and so reported to `ERROR_TRACKING_DSN` like the API's errors.

**Every container's log is bounded**: five files of 50 MB each per service, so the server's disk is
never filled by its own logs. For the API that is weeks of a team's requests; the stretch `bun run
report:frames` needs (O-4) is exported with `docker compose … logs api` before it rolls over.

**The proxy's access log** records the path and never the query string: an OAuth callback carries a
one-time `code` and the signed `state` there, and a search carries what was searched for.

**A restart is not an outage.** A request that arrives while the API restarts is held by the proxy for
up to 30 s until a ready node answers, rather than failing (`lb_try_duration`, #636); the proxy only
retries a request it could not hand over, so nothing is sent twice. `/health/ready` stays public — an
uptime monitor may point at it — and answers from a check at most a second old, however often it is
asked.

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
0 1 * * * cd /srv/purlay && scripts/backup.sh /srv/purlay-backups >>/srv/purlay-backups/backup.log 2>&1
45 1 * * * find /srv/purlay-backups -mindepth 1 -maxdepth 1 -type d -name 'purlay-*' -mtime +14 -exec rm -rf {} +
```

**The times are the host's; the stack's jobs are UTC** (`modules/jobs/schedule.ts`), and the nightly
ones — the retention purge first, at 02:30 — must not run while a backup does, or a file can be removed
between the database dump and the bucket copy and the backup names a file it does not hold (#637).
On a host whose clock is UTC the lines above start at 01:00, clear of every nightly job; on another zone,
move them so the backup starts between 00:00 and 01:30 UTC. The hourly sweeps still run in that window;
the most they can do is remove a file somebody deleted while the backup ran, which the restore then lacks.

**A backup on the server dies with the server.** `backup.sh` exits non-zero and leaves nothing that looks
like a backup when it fails, but a disk that fails takes the data and every night's backup with it. Copy
each night off the host, and be told when a night fails. For example (an example, not rehearsed against
the stack: the copy line was run alone under the same bare environment, and keeps the backup's `0700`
and `0600`):

```
# the first line, mirroring the backups to another machine you control over SSH once a backup has
# succeeded (never a half-written one), and saying so when either fails: cron mails what a job prints,
# if the host can send mail
MAILTO=ops@example.com
0 1 * * * cd /srv/purlay && scripts/backup.sh /srv/purlay-backups >>/srv/purlay-backups/backup.log 2>&1 && rsync -a --delete /srv/purlay-backups/ backup@other-host:/srv/purlay-backups/ >>/srv/purlay-backups/backup.log 2>&1 || echo "purlay backup failed: see /srv/purlay-backups/backup.log"
```

Encrypting the copy where it lands is the operator's choice of tool (`docs/spikes/backup-restore.md`);
it holds every message in the clear. A host that cannot send mail can instead call an uptime monitor's
check-in address after a backup that succeeded (`&& curl -fsS -m 10 <address>`), which also notices a
cron that stopped running at all. A backup nobody restored is a belief (D-44). Before the
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
