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

## References

- [GitHub: publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub: Container registry authentication and pulling by digest](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [GitHub: workflow_run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Docker: Compose health waiting](https://docs.docker.com/reference/cli/docker/compose/up/)
