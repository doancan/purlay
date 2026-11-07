# Deploying Purlay

Keep the application, Dockerfile and deployment configuration in this repository. No second
repository or Docker Hub account is needed. GitHub Actions builds and smoke-tests the application,
publishes it to `ghcr.io/<owner>/<repo>-api`, then the server pulls that image by digest. The server
does not build the application. API and web assets ship together in the same image.

## First installation

Use a Linux **amd64** server with Docker Engine, the Compose plugin, Git, Bash, curl and OpenSSL.
The current image workflow builds amd64; ARM servers require a native ARM image build first.
Point a domain at the server and allow ports 80 and 443 for Caddy's HTTPS certificates.

1. Let the repository's `image` workflow finish successfully on `main`. Copy that run's full commit
   hash. For a private package, authenticate on the server with `docker login ghcr.io`; outside
   Actions, use a classic personal access token with `read:packages`. Public packages can be pulled
   anonymously. A newly published GHCR package is private by default.
2. In a checkout of that exact commit on the server, prepare the deployment directory. Replace the
   example repository and commit with your own values. Run these as the account that owns the
   deployment and can use Docker; choose a writable directory instead of `/srv/purlay` if needed.

   ```bash
   git checkout <full-commit-hash>
   export DEPLOY_ROOT=/srv/purlay
   export IMAGE_REPOSITORY=ghcr.io/<owner>/<repo>-api
   commit=$(git rev-parse HEAD)
   release="$DEPLOY_ROOT/releases/${commit:0:8}"
   mkdir -p "$release"
   git archive "$commit" docker docker-compose.production.yml scripts | tar -x -C "$release"
   cp "$release/docker/production.env.example" "$DEPLOY_ROOT/production.env"
   chmod 600 "$DEPLOY_ROOT/production.env"
   docker pull "$IMAGE_REPOSITORY:sha-$commit"
   docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE_REPOSITORY:sha-$commit"
   ```

3. Edit `production.env`: put the printed digest reference in `PURLAY_IMAGE`, set `APP_URL` to your
   HTTPS domain and fill in every empty required value. The template provides generation commands;
   [CONFIG.md](CONFIG.md#production-deployment) explains the settings. Keep the encryption key in a
   password manager separately from backups.
4. Start the stack, then create the `current` link **only after startup succeeds**:

   ```bash
   docker compose -f "$release/docker-compose.production.yml" \
     --env-file "$DEPLOY_ROOT/production.env" up -d --wait --wait-timeout 900
   ln -s "releases/${commit:0:8}" "$DEPLOY_ROOT/current"
   docker compose -f "$DEPLOY_ROOT/current/docker-compose.production.yml" \
     --env-file "$DEPLOY_ROOT/production.env" logs api | grep 'SETUP CODE'
   ```

5. Open `https://<your-domain>/setup` and complete the setup wizard. PostgreSQL, Garage storage,
   migrations and HTTPS are prepared by the stack. No separate storage initialization command is
   needed.

This first installation has no previous release to restore. If startup fails, inspect the logs and
correct the configuration before enabling automated deployment; preserve any data volumes.

## Automatic updates

Register a GitHub Actions self-hosted runner on the Linux amd64 server, under the same account,
with the extra label `purlay-server`. Install GitHub CLI (`gh`) for the commit ancestry check.
The account needs access to Docker and the deployment directory. Bun is not required on the host;
backup operations use Bun inside the application container. The release packaging job runs on
GitHub's hosted runner.

In the repository's **Settings → Secrets and variables → Actions → Variables**, set:

| Variable | Value |
| --- | --- |
| `DEPLOY_ROOT` | `/srv/purlay` (or the directory used above) |
| `ENV_FILE` | Optional; defaults to `$DEPLOY_ROOT/production.env` |
| `COMPOSE_OVERRIDES` | Optional; space-separated absolute paths to server-specific Compose files |

Allow Actions to read the GHCR package; packages published by this repository's workflow normally
inherit that access. The deploy job uses its temporary `GITHUB_TOKEN` with `packages: read`, so no
long-lived registry secret is needed in Actions. Its Docker credentials are isolated to a temporary
directory and removed after deployment.

For each push to `main`:

1. `image` builds once, tests the published digest and gives it the full commit tag.
2. Deployment starts when both the `ci` run and the `image` run of that push have succeeded
   (D-229). Whichever finishes second starts it; a failed, cancelled or missing run of either stops
   it before the server is touched.
3. `deploy` checks out that run's exact commit, pulls its image, resolves the digest, checks the
   revision label and smoke-tests it. A missing image or failed check leaves the live site alone.
4. Immediately before switching, it backs up the database and attachments. It records the digest
   in `production.env`, switches `current` and waits for healthy services.
5. If startup or the running revision check fails, it restores the database backup and previous
   release. On success, the release job publishes a GitHub Release if the version is new.

The retained release directories contain deployment files and maintenance scripts. GitHub's runner
also keeps its working checkout; the production containers run the downloaded image. Old Docker
images are left in the host cache so deployment does not delete an image another installation uses.
Retain the previous image when managing that cache.

## Manual updates and recovery

For an ordinary retry, use **Actions → deploy → Run workflow** from `main`, optionally supplying a
full commit hash on `main` that was the tip of a push, whose `ci` and `image` runs both succeeded. A
commit inside a rebased merge has no runs of its own and is refused. A manual run never publishes a
GitHub Release. Automatic runs deploy the commit of the run that started them, rather than whatever
happens to be the latest `main` when the runner starts.

A manual deploy of an older commit does **not** undo database migrations. To recover from an
upgrade with a newer schema, use the database restore procedure in
[ARCHITECTURE.md](ARCHITECTURE.md#11-deployment), under “Upgrading and rolling back”. The script's
automatic recovery restores the backup it took immediately before its failed switch. A rollback
loses database writes made after that backup. A failure of the restore itself exits with code 2,
reports the backup directory and leaves `.switching` for an operator to investigate.

## On a server managed with Dockhand

For a server where [Dockhand](https://dockhand.pro) runs the containers and Nginx Proxy Manager — on that
server or another — ends TLS (D-258). `docker-compose.dockhand.yml` is the production stack in one file,
without Caddy: nothing is mounted from a checkout, so it can be pasted into Dockhand's editor or deployed
from this repository with Git, and the API's own port is published for Nginx Proxy Manager. Linux
**amd64** only, as above.

1. **Let Dockhand pull the image.** A GHCR package is private unless made public: either add `ghcr.io` as
   a registry in Dockhand with a GitHub username and a classic token with `read:packages`, or make the
   package public in its settings on GitHub. Take the digest of a successful `image` run on `main`:
   `ghcr.io/<owner>/<repo>-api@sha256:…`.
2. **Pick a free port** on the server for the API, e.g. `8190`.
3. **Make the secrets** once, anywhere with OpenSSL, and keep them in a password manager. Losing
   `ENCRYPTION_KEY` makes the stored integration secrets unreadable:

   ```bash
   echo POSTGRES_PASSWORD=$(openssl rand -hex 16)
   echo GARAGE_RPC_SECRET=$(openssl rand -hex 32)
   echo GARAGE_ADMIN_TOKEN=$(openssl rand -hex 32)
   echo S3_ACCESS_KEY_ID=GK$(openssl rand -hex 12)
   echo S3_SECRET_ACCESS_KEY=$(openssl rand -hex 32)
   echo ENCRYPTION_KEY=$(openssl rand -base64 32)
   ```

4. **Create the stack** in Dockhand, from Git (this repository, compose file `docker-compose.dockhand.yml`)
   or by pasting the file. Set its environment: `PURLAY_IMAGE` (the digest), `APP_URL` (the public
   `https://` address, no path), `PURLAY_HTTP_PORT`, and the six values above. Any optional variable of
   [CONFIG.md](CONFIG.md#production-deployment) can be added the same way. Deploy it, then read the
   setup code in the `api` container's logs (`SETUP CODE`).
5. **Add a proxy host** in Nginx Proxy Manager: the domain of `APP_URL`, scheme `http`, the server's
   address and `PURLAY_HTTP_PORT`, **Websockets Support on** (without it the page loads but messages
   arrive only on a reload). On its SSL tab, request a certificate and turn on *Force SSL*. With
   Cloudflare in front of Nginx Proxy Manager, add the client-address lines of
   [CONFIG.md](CONFIG.md#production-deployment) to its *Advanced* tab.
6. Open `https://<your-domain>/setup` and complete the setup wizard.

To check the client address, sign in, then in the `postgres` container
`psql -U purlay -c 'SELECT ip_address FROM sessions ORDER BY created_at DESC LIMIT 1'` must be your address,
not Nginx Proxy Manager's or Cloudflare's.

**Updating to each release, by itself** (D-262). Every release's image is also named `:release` (and
`:vX.Y.Z`) by the `release-image` workflow, and nothing else ever is. Set `PURLAY_IMAGE` to
`ghcr.io/<owner>/<repo>-api:release`, redeploy, then turn on Dockhand's auto-update for the `api`, `scheduler`
and `storage-init` containers with a short schedule (`*/15 * * * *`): Dockhand compares the digest and pulls
only when a new release is out, so the server runs it within a quarter of an hour. A digest pinned instead
is never updated: set a newer one by hand.

Dockhand does not do what `scripts/deploy.sh` does: there is **no backup taken at the switch and no automatic
way back**, and the database migrates as the new API starts. The stack's `backup` service is the answer: it
dumps the database every `BACKUP_EVERY_MINUTES` (60) into the `backups` volume and keeps the newest
`BACKUP_KEEP` (48), so a dump is at most an hour old when an update lands; it shows *unhealthy* in Dockhand if
dumps stop. To go back after a bad release, stop `api` and `scheduler`, restore the newest dump from before it,
and pin `PURLAY_IMAGE` to the previous release's tag:

```bash
docker exec <stack>-backup-1 ls -1t /backups                      # newest first
docker exec <stack>-backup-1 pg_restore --clean --if-exists --no-owner -d purlay /backups/purlay-<time>.dump
```

A restore loses what was written after the dump. Attachments live in the stack's `garage-data` volume; back it
and `backups` up off the server with the server's volume backups. Point-in-time recovery (WAL archiving,
D-202) is not offered by this file; use `docker-compose.production.yml` where it is wanted.

## Modules (operator runbook)

Purlay is a core and modules, and `MODULES` says which a process runs. What a module is and how one is built is in
[MODULES.md](MODULES.md); this is what an operator does. The variable is in [CONFIG.md](CONFIG.md); the decisions are
D-250, D-254 and D-255.

**The values.** Unset or blank is every module the build carries (`chat`, `issues`). `none` is the core alone: sign-in,
workspaces, members, invitations, exports and the trail. Otherwise a comma-separated list of ids, `MODULES=chat` or
`MODULES=chat,issues`, with no empty item and no repeat. Put it in `production.env`; every node of a cluster runs the same
value.

**Check what a node runs.**

- the boot logs one `info` line, `the modules this process runs`, with `running` and `notRun` (the modules the build
  carries and this process leaves out);
- `/metrics` (behind `METRICS_TOKEN`) carries `purlay_modules_info{module="<id>"} 1` for each running module, and every HTTP request and scheduled-job series carries the `module` that owns its route or job;
- signed in, `GET /api/me` answers `modules`, the ids this server runs (the page draws the screens of those only);
- a path of a module that is off answers the plain `404` of any unknown path, for example
  `GET /api/workspaces/<id>/issues` with a session on a node that does not run `issues`; the public `GET /api/client`
  lists no module, though `capabilities` (`scheduledMessages`, `messageReminders`, `personalMessageDeletion`) are
  true only when chat runs, and a caller with no session gets `401` from a route of a module that runs and `404`
  from one that does not (`MODULES.md` §3);
- the value the container was started with: `docker compose -f "$DEPLOY_ROOT/current/docker-compose.production.yml" --env-file "$DEPLOY_ROOT/production.env" exec api printenv MODULES` (nothing printed is every module);
- with `REDIS_URL`, each live node's set is in the hash `<REDIS_KEY_PREFIX>:modules` (`HGETALL`; `purlay:modules` when it is unset), one field per node.

**Turn a module off or on.** Change `MODULES` and restart the API (`up -d --wait`). Off: its routes, socket operations
and events, and the jobs that act for its users, are closed and its screens are gone from the page. **Its rows stay**,
untouched and kept whole: an account's erasure, a deleted workspace's purge, the exports and the retention purge still
reach them, so nothing in them outlives a person's right to be erased because a setting changed. Nothing is dropped; if
you want the tables gone, drop them by hand, knowing that a later turn-on will not recreate them (the set is recorded as
applied). On: the module's migration set applies on start with `MIGRATE_ON_START=true`, or with `bun run db:migrate`
first; a node that runs a module whose set is not applied is not ready (below). Turning chat on later does **not** make a
first channel for a workspace that was made while chat was off: a member sees "Choose one from the list, or create the
first", and the new-channel button makes it.

**Adding issues later.** Set `MODULES` to include `issues` (or unset it, if it already named everything) and restart; the
set `issues/0001_issues` applies and the screen appears for every workspace on the instance, unless the server administrator
withholds it from a workspace (below, *Workspaces and modules*).

**A fresh install under `MODULES=none`, then adding chat.** The install works with the core alone. The core's own
migrations also create chat's original tables, which stay empty and inert; chat's own set (`chat/0001` to `chat/0004`) is
applied when `chat` joins `MODULES`. Exports and an erasure under `none` find no chat rows and say nothing about them.

**Rolling deploys with different sets.** Changing `MODULES` rolls node by node, and for as long as the roll takes two sets
are live. Nothing stops: a node keeps serving, `/health/ready` stays green and no node refuses its peer. What an operator
sees: a request that reaches a node without the module gets a `404` for the module's paths (so a client behind a load
balancer sees them come and go until the roll ends), a socket on that node does not hear the module's events, and one
`warn` line in the log of a node that sees a peer with another set (`the nodes of this cluster do not run the same
modules; serving on, as in a rolling deploy`, with `thisNode` and `otherNodes`), and an `info` line when they agree again.
A page open during the roll that meets the `404 ROUTE_NOT_FOUND` of a node without the module reads `GET /api/me` again, once (a burst of them is one read); if the session no longer lists the module the page hides its screens, and if it still does (a mixed cluster) the page does nothing more.
That line needs `REDIS_URL`; without Redis there is one node. **Finish the roll**: a set that stays mixed is a service that
answers differently by node. A migration that a new module brings applies when the first node of the new set starts.

**Backup evidence in server administration (D-278).** Dockhand writes an atomic receipt after `pg_dump` and `pg_restore --list` succeed, and mounts only the separate `backup-status` volume read-only into the API. Its receipt explicitly covers the database only: attachment volumes still need their own backup. A receipt older than two configured intervals plus five minutes is stale.

The production Compose stack passes this optional variable but does not mount a host directory by default. Add the metadata-only read-only API volume through a Compose override and set the container path in `production.env`; setting a path alone does not provide evidence.

For `scripts/backup.sh` and `scripts/restore.sh`, export `BACKUP_STATUS_DIRECTORY` to a metadata-only host directory before running the script. Mount that directory read-only into the API and set the API's variable to its container path. Files are atomically renamed and readable by the API; no archive or credential is published. `BACKUP_REPORT_MAX_AGE_SECONDS` sets the script receipt's expected maximum age (60–31536000, default 172800). It describes the operator's schedule and does not install one. A reporting failure fails the script but keeps a completed backup.

A backup receipt identifies the actual dump by SHA-256 and size and says whether a bucket snapshot is included. A restore receipt is written only after checksum verification, SQL restoration with `--exit-on-error`, the table-count check and any requested bucket import complete. The console matches both the artifact and scope: a database-only restore does not verify a backup's attachment snapshot. This evidence does not replace application-level smoke tests, off-site recovery rehearsals or `scripts/compare-databases.sh`. Missing, malformed, oversized and future-dated receipts never become a success indicator. No web restore operation is provided.

**Backup, restore and D-86.** A backup (`scripts/backup.sh`) holds every table of every set, whether the module runs or
not, and the migration table with each applied file as `<module>/<file>`. There is no down migration (D-86): going back is
restoring the backup taken before the upgrade, as in [ARCHITECTURE.md](ARCHITECTURE.md#11-deployment) under "Upgrading and
rolling back", never starting an older image on a newer database; that is refused with `corrupted migrations: previously
applied migration <name> is missing`. A restore into a database for a process with another `MODULES` is fine: the rows are
there, and a module that is off leaves them inert.

**Boot failures, and what each says.**

- `MODULES cannot be run; exiting`, exit `1`, with `problems`, each one sentence: `MODULES names "<id>", which this build
  does not have (it has: <ids>)`; `MODULES names "<id>" twice`; `MODULES has an empty item: a doubled or trailing comma`;
  `"<id>" requires "<other>", which MODULES does not enable`. Every problem is listed at once, and `bun run db:migrate` refuses the same value with the same sentences (exit `1`, before it applies anything). Fix the value and restart.
- `migrating on start failed at <file>` (exit `1`; the cause is attached): a migration of the core or of a module's set
  failed. The node does not serve half a schema; compose restarts it and it fails the same way until the cause is fixed.
- `/health/ready` is `503` and the log says why: `migrations not applied: <files>` (for example
  `issues/0001_issues`: this node runs a module whose set is not applied, run `bun run db:migrate` or start with
  `MIGRATE_ON_START=true`), or a history that does not match the files, or columns that must compare byte-wise do not
  (D-40), or the sign-in library cannot find its tables. A node that does not migrate logs `waiting for the migrations
  before reading the settings` once per kind of reason and waits for another node or `db:migrate` to finish.

**`MODULES=none` does not save memory.** The process loads the same code, and the resident memory measured with `none`
and with every module was about the same. Turning a module off is for what is served and kept, not for the size of the
process.

**Workspaces and modules (D-289, D-292).** `MODULES` says what a node runs; the server administrator says what each workspace may
use of it, by `POST /api/server/workspaces/:workspaceId/modules`. `WORKSPACE_MODULES` is what a workspace with no word of its own
gets: `open` (the default; a server you run yourself has every module it runs) or `managed` (only what is granted, for a server that
sells modules). A workspace that may not use a module answers its paths as a module that is not run, shows no rail place, search
result or inbox line for it, and keeps every row, which is still exported, erased and purged. Granting it back brings everything
back. A file of editions (`{ "editions": { "team": ["chat", "issues"] }, "workspaces": { "acme": { "edition": "team" } } }`, `validUntil` optional) is applied by `bun run entitlements:apply --file editions.json`, `--dry-run` first (on a server with `REDIS_URL`, a file that takes grants away also needs `--cluster-ready`, said once every node runs a release that reads grants). Chat is not a grant yet. Turn on `managed`, or withdraw a module, only after every node runs a release that has the table: a
node that predates it serves the module to every workspace, and rolling back lifts every restriction (data is not lost).

**Not supported.** Third-party modules: a module is first-party code in this repository, and loading one from elsewhere is not supported.

## Sizing an upgrade that backfills

A migration file runs in one transaction, and the locks it takes are held until it commits. `chat/0001`
(the first start with a build that has it, on every existing install, and the first start of a node that
adds chat to a database that never had it) creates `message_attachments` with keys to `messages` and
`attachments`, then copies every attached file's link into it. That holds `SHARE ROW EXCLUSIVE` on both
tables for the whole copy: **reads go on, writes to messages and attachments wait.**

Measured on a private database of 1,000,000 messages and 200,000 attachments linked to a message (one
machine, PostgreSQL on the same host): the file took 8.3 s, and a writer probing every 100 ms waited 10.9 s
at worst. The cost is the copy, about 40 µs per attached file, so 1,000,000 attachments is roughly 40 s of
refused writes. Nothing is lost and nothing fails: the migrating connection has no statement timeout
(D-87), and a waiting writer is served when the file commits. But the other nodes' pools hold a connection
for each blocked writer, and a pool of ten that is all blocked answers everything else `503` after three
seconds. So, for an install with more than a few hundred thousand attachments, upgrade in a quiet hour, or
stop the other nodes first. A `lock_timeout` is not the remedy for that: it bounds the wait to *get* a lock, not how long
the lock is held once taken.

**A migration that cannot get its lock fails instead of queueing.** An `ALTER TABLE` waits for every transaction
already using the table, and while it waits every later query on that table waits behind it (measured: a plain
`SELECT` was held 8 s by one long transaction and one queued `ALTER`). A migration that runs in a transaction therefore
waits at most ten seconds for any one lock (`lock_timeout`, D-86) and then stops with `migration <file> could not get
a lock it needs in time`. Nothing it did is recorded; a node that migrates as it starts exits and tries again at the
next start. Before upgrading, look for what is holding the table: `select pid, state, xact_start, query from
pg_stat_activity where xact_start < now() - interval '10 seconds' order by xact_start;` (a long `idle in
transaction` session is the usual cause), let it finish or end it with `pg_terminate_backend(pid)`, and start again.

## Sizing a node's sockets

`SOCKET_MAX_CONNECTIONS` (default 2000) is how many WebSockets one API process holds; the next handshake is
answered `503` and the client retries. It is per node, so three nodes behind one balancer hold three times
the number. It is a CPU and fan-out decision, not a promise: every message is written to every socket
subscribed to its channel, so what a node carries depends on how many sockets, how many messages a second
and how many listeners each one reaches.

What one run measured (a single node, no Redis, loopback, one laptop core; your hardware and traffic
will differ):

- 1,990 sockets held at 10 messages a second: p99 delivery 312 ms.
- 4,990 sockets at 5 messages a second: every delivery arrived (559,503 of 559,503), p99 502 ms. At 10
  messages a second the node fell behind for about 12 s before it caught up.

So the default is a safe starting point, not the ceiling, and a larger number is not free: **size by the
fan-out you measure** (`purlay_websocket_connections` on `/metrics` against your own message rate and CPU),
raise it in steps, and watch delivery latency before the next step. A node past its CPU does not fail
loudly; its sockets get later. A buffer that a stalled reader fills is closed at 4 MB (`RESYNC`), so many
slow readers also cost memory.

**Refused handshakes are not free, and the order is a decision.** The node checks the session before it
checks the cap, so a client refused with `503` has still cost one session read; during a reconnection storm
against a full node, live users' requests slow down (about 6 times in the run that measured it, before an
accepted handshake stopped reading the session twice). The owner decided to keep this order: a `503` before
the session check would tell a caller who is not signed in that the node is full (#1027). If a full node's
refusals ever need to be cheaper, the lever is the cap itself, raised in measured steps.

**The connection pool.** `DATABASE_POOL_MAX` (default 10) is the other ceiling a busy node meets. In the
load runs a node saturated at about 340 requests a second on one core with the pool at 10 and at about 426
with 30, while Postgres stayed far from busy: the process, not the database, was the limit, so a bigger pool
buys a little and raising it is a decision for the number of nodes times the pool against the database's
`max_connections`, not for speed alone. Every request reads its session from the database, a refused write
included; that cost was measured and is accepted, not cached, because a cache would delay a revoked
session taking effect.

**Memory after a mass reconnect.** Budget the container for the storm, not the steady state. One run
(2,000 sockets reconnecting with replay, three times in one process, macOS) took the process
from about 380 MB to 1.2 GB on the first storm and added only 20-50 MB on each of the next two. The
JavaScript heap came back to 36 MB each time, objects returned to baseline, and nothing leaked; the
allocator keeps the pages it had committed, so the figure from `ps` stays near its peak until the process
restarts. Replay is what costs: each reconnecting socket replays up to 1,000 frames or 1 MiB at once, about
0.4 MB of memory per socket. A reconnect that read all of them at the same moment is what took the process to its peak.

**A node now replays only so many sockets at once.** `SOCKET_REPLAY_CONCURRENCY` (default 50) is how many
subscriptions of one node may be reading and building a replay at the same moment. The rest wait in the order
they asked, and the client sees only a later answer; one that has waited 15 seconds is told the service is busy
(`DATABASE_UNAVAILABLE`) and sends again after a growing wait, as it does for any busy server. A first
subscription (no cursor, nothing to replay) and a lone reconnect never wait. The same storm, 2,000 sockets
reconnecting with replay at once against a node that also carries 20 messages a second (one run each unless two
are shown, macOS, PostgreSQL, the clients and the node on one machine, a fresh process for each row):

| `SOCKET_REPLAY_CONCURRENCY` | Peak `ps` RSS (MB) | Peak resident metric on `/metrics` (MB) | Peak JS heap (MB) | Every socket subscribed again (s) | Subscriptions refused and sent again |
| --- | --- | --- | --- | --- | --- |
| no limit (100000) | 1262, 1539 | 660, 861 | 424, 454 | 35, 28 | 0 |
| 200 | 893 | 522 | 357 | 31 | 0 |
| 100 | 840, 941 | 518, 644 | 359, 335 | 31, 31 | 282, 281 |
| **50 (default)** | 927, 731 | 576, 478 | 386, 268 | 37, 38 | 522, 528 |
| 25 | 925, 764 | 544, 480 | 277, 258 | 59, 45 | 1399, 805 |
| 10 | 721 | 500 | 307 | 84 | 2080 |

Before the storm the process held 270-390 MB (`ps`) and a 38-45 MB heap, and the heap returned to that after every
run. What the numbers say, and do not:

- The default takes the peak down by about 40% by `ps` and by about 35% by the process's own resident metric
  (the `ps` figure includes pages the allocator freed and the system has not reclaimed, so it stays at its peak
  until the process restarts), at the price of about 6 seconds on a 30-second recovery. Below 50 the
  recovery gets slower faster than the node gets lighter (25 took half as long again; 10 two and a half times
  as long); above it the saving fades (100 and 200 peaked 5% to 10% higher). **Take it as a measurement of one laptop, not as a
  promise:** the runs of one value differ by up to 20% from each other, and the clients shared the machine.
- **It does not remove the peak, only the part the replay added.** The first seconds of the storm, when two
  thousand handshakes arrive together, put the heap at 250-300 MB by themselves in every run with a limit of 10 to 50, before any replay is read. Lowering
  the limit further cannot go below that. A node that must stay under a hard container limit needs headroom for
  it, and fewer sockets per node (`SOCKET_MAX_CONNECTIONS`).
- A limit too low for the storm shows as `replay refused: too many sockets replaying at once` lines in the log:
  nothing is lost, each client sends again, but the recovery is longer. Raise it, in steps, if you see many.
- Leave headroom above the steady state, do not alarm on a high figure that stays flat after a storm, and let
  routine restarts or deploys reset it. This was not measured on Linux (glibc or musl), which may release memory
  differently.

## References

- [GitHub: publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub: Container registry authentication and pulling by digest](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [GitHub: workflow_run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Docker: Compose health waiting](https://docs.docker.com/reference/cli/docker/compose/up/)
