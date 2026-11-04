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
- `/metrics` (behind `METRICS_TOKEN`) carries `purlay_modules_info{module="<id>"} 1` for each running module;
- signed in, `GET /api/me` answers `modules`, the ids this server runs (the page draws the screens of those only);
- a path of a module that is off answers the plain `404` of any unknown path, for example
  `GET /api/workspaces/<id>/issues` with a session on a node that does not run `issues`; the public `GET /api/client`
  lists no module, though `capabilities` (`scheduledMessages`, `messageReminders`, `personalMessageDeletion`) are
  true only when chat runs, and a caller with no session gets `401` from a route of a module that runs and `404`
  from one that does not (`MODULES.md` §3);
- the value the container was started with: `docker compose -f "$DEPLOY_ROOT/current/docker-compose.production.yml" --env-file "$DEPLOY_ROOT/production.env" exec api printenv MODULES` (nothing printed is every module);
- with `REDIS_URL`, each live node's set is in the hash `purlay:modules` (`HGETALL`), one field per node.

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
set `issues/0001_issues` applies and the screen appears for every workspace on the instance. There is no per-workspace
switch yet.

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

**Backup, restore and D-86.** A backup (`scripts/backup.sh`) holds every table of every set, whether the module runs or
not, and the migration table with each applied file as `<module>/<file>`. There is no down migration (D-86): going back is
restoring the backup taken before the upgrade, as in [ARCHITECTURE.md](ARCHITECTURE.md#11-deployment) under "Upgrading and
rolling back", never starting an older image on a newer database; that is refused with `corrupted migrations: previously
applied migration <name> is missing`. A restore into a database for a process with another `MODULES` is fine: the rows are
there, and a module that is off leaves them inert.

**Boot failures, and what each says.**

- `MODULES cannot be run; exiting`, exit `1`, with `problems`, each one sentence: `MODULES names "<id>", which this build
  does not have (it has: <ids>)`; `MODULES names "<id>" twice`; `MODULES has an empty item: a doubled or trailing comma`;
  `"<id>" requires "<other>", which MODULES does not enable`. Every problem is listed at once. Fix the value and restart.
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

**Not supported.** Different packages for different workspaces on one instance (a module is on for the whole process;
per-workspace enablement is a precondition of selling a package, D-250 rule 9), and third-party modules: a module is
first-party code in this repository, and loading one from elsewhere is not supported.

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
stop the other nodes first. A `lock_timeout` is not the remedy: it bounds the wait to *get* a lock, not how long the
lock is held once taken.

## References

- [GitHub: publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub: Container registry authentication and pulling by digest](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [GitHub: workflow_run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Docker: Compose health waiting](https://docs.docker.com/reference/cli/docker/compose/up/)
