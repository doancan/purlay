#!/usr/bin/env bash
# Deploy the commit that is checked out to this server (D-185). Run by the `deploy` workflow on the
# server's own runner after a merge to main; the same command is how an operator deploys by hand:
#
#   DEPLOY_ROOT=/srv/purlay scripts/deploy.sh <full commit hash>
#
# What it does, in this order — the order is the point:
#
# 1. Judges what it was given: a full commit hash that IS the checkout, from a clean tree (what
#    runs is what was merged), a deployment that is running a release it can come back to, an env
#    file with an image to replace, a Docker that answers, no deploy cut off half way. One deploy
#    at a time.
# 2. Exports the commit into `releases/<8 hex>`, builds the image there ONCE under a candidate name,
#    labelled with the commit, and runs `scripts/image-smoke.sh` against that image.
# 3. Backs up the database and the bucket (`scripts/backup.sh`) — after the build and the smoke
#    test, so that what a rollback loses is what was written in the seconds before the switch, not
#    in the minutes a build takes, and no backup is made for a build that fails.
#    **A failure up to here changes nothing**: the running site, the env file and `current` are as
#    they were, and nothing is restored — there is nothing to restore.
# 4. Switches: the image gets its commit name, the env file's PURLAY_IMAGE and the `current` link
#    change, `docker compose up -d --wait`. The migration runs as the API starts (D-86), so from here
#    the database is no longer the one that was backed up. `--force-recreate` only when a file the
#    services mount has changed (every service then: a service named on the command line would also
#    start one that a profile switches off).
# 5. Checks that the API and the scheduler are running THIS commit: `up --wait` says a container
#    is healthy, not that it is the one that was just built.
#    **A failure from step 4 on goes back the way docs/ARCHITECTURE.md says**: stop the API,
#    restore the database alone from the backup, put the old env file and release back, start. An
#    older image does not start on a newer schema (D-86), so "run the old image" is not a way back;
#    the backup is. The same happens if the deploy is told to stop (SIGINT, SIGTERM, SIGHUP: a
#    cancelled job, a timeout). A rollback that fails too exits 2 and names the backup that holds
#    the data. A deploy that is killed outright (SIGKILL, power) leaves `.switching` behind, and the
#    next deploy refuses to start until someone has looked.
# 6. Forgets releases, images and backups beyond the ones kept.
#
# Inputs, all from the environment (nothing here names a host or a path on this machine, D-73):
#   DEPLOY_ROOT        required: holds releases/, backups/, the `current` link, deploys.log
#   ENV_FILE           the stack's env file (default $DEPLOY_ROOT/production.env)
#   COMPOSE_OVERRIDES  extra Compose files for this server, space-separated, in order (no spaces
#                      in a path) — e.g. one that switches the proxy off behind another proxy
#   KEEP               releases and backups kept besides the running and the previous (default 5)
#   WAIT_TIMEOUT       seconds `up --wait` may take before the deploy counts as failed (default 900)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }

# ── 1. What it was given ─────────────────────────────────────────────────────
[ -n "${DEPLOY_ROOT:-}" ] || fail "DEPLOY_ROOT is unset: it names the directory that holds releases/, backups/ and the env file"
[ -d "$DEPLOY_ROOT" ] || fail "DEPLOY_ROOT=$DEPLOY_ROOT is not a directory"
DEPLOY_ROOT="$(cd "$DEPLOY_ROOT" && pwd -P)"
ENV_FILE="${ENV_FILE:-$DEPLOY_ROOT/production.env}"
COMPOSE_OVERRIDES="${COMPOSE_OVERRIDES:-}"
KEEP="${KEEP:-5}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-900}"
[[ "$KEEP" =~ ^[0-9]+$ ]] || fail "KEEP must be a number, not '$KEEP'"
[[ "$WAIT_TIMEOUT" =~ ^[0-9]+$ ]] || fail "WAIT_TIMEOUT must be a number of seconds, not '$WAIT_TIMEOUT'"

CHECKED_OUT="$(git rev-parse HEAD)"
SHA="${1:-$CHECKED_OUT}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "give a full 40-digit commit hash, not '$SHA'"
[ "$SHA" = "$CHECKED_OUT" ] || fail "$SHA is not the commit checked out ($CHECKED_OUT): deploy what is on disk, or check it out first"
[ -z "$(git status --porcelain)" ] || fail "the working tree is not clean; deploy a merged commit"
SHORT="${SHA:0:8}"

[ -f "$ENV_FILE" ] || fail "$ENV_FILE does not exist (set ENV_FILE)"
grep -q '^PURLAY_IMAGE=' "$ENV_FILE" || fail "$ENV_FILE has no PURLAY_IMAGE line to replace"

# A rollback relinks `current` to `releases/<name>`, so what is running must BE one of those:
# otherwise the way back would end in a dangling link after the database was already restored.
CURRENT_LINK="$DEPLOY_ROOT/current"
[ -L "$CURRENT_LINK" ] && [ -d "$CURRENT_LINK" ] \
  || fail "no release is running: $CURRENT_LINK is not a link to a release directory, so there is nothing to back up. Link the one that is running there once, by hand"
CURRENT_REAL="$(cd "$CURRENT_LINK" && pwd -P)"
PREVIOUS="$(basename "$CURRENT_REAL")"
[ "$CURRENT_REAL" = "$DEPLOY_ROOT/releases/$PREVIOUS" ] \
  || fail "$CURRENT_LINK points at $CURRENT_REAL, not at a directory under $DEPLOY_ROOT/releases/: move the running release there and relink it, so that a rollback has somewhere to return to"
PREVIOUS_IMAGE="$(sed -n 's/^PURLAY_IMAGE=//p' "$ENV_FILE" | tail -n 1)"

# A deploy that was cut off after the switch (a kill, a power cut) left the stack, the env file and the
# link in a state nobody has judged; deploying on top of it would take that state for "the previous".
MARKER="$DEPLOY_ROOT/.switching"
[ ! -e "$MARKER" ] || fail "an earlier deploy was cut off after it switched ($(cat "$MARKER" 2>/dev/null || true)). Look at the site, roll back by hand if it is wrong (docs/ARCHITECTURE.md), then delete $MARKER"

# One deploy at a time. A directory is the lock because `mkdir` is atomic and exists everywhere
# this runs; the pid inside tells a live deploy from one that was killed. `ps` rather than
# `kill -0`: a deploy started by another user is alive although it cannot be signalled.
LOCK="$DEPLOY_ROOT/.deploy.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  OWNER="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -z "$OWNER" ]; then
    sleep 1 # the deploy that made the directory has not written its pid yet
    OWNER="$(cat "$LOCK/pid" 2>/dev/null || true)"
  fi
  if [ -n "$OWNER" ] && ps -p "$OWNER" >/dev/null 2>&1; then
    fail "another deploy is running (pid $OWNER)"
  fi
  echo "stale lock from pid ${OWNER:-unknown} removed" >&2
  rm -rf "$LOCK"
  mkdir "$LOCK" || fail "cannot take the deploy lock $LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

docker info >/dev/null 2>&1 || fail "Docker does not answer; nothing was changed"

# The log is for the next person; failing to write it must not decide how a deploy ends.
record() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$DEPLOY_ROOT/deploys.log" \
    || echo "warning: could not write $DEPLOY_ROOT/deploys.log" >&2
}

OVERRIDE_ARGS=""
for file in $COMPOSE_OVERRIDES; do OVERRIDE_ARGS="$OVERRIDE_ARGS -f $file"; done
# The stack as the running release defines it, plus this server's overrides. After the switch the
# `current` link points at the new release, so the same words mean the new stack.
compose() {
  # shellcheck disable=SC2086 # the overrides are words on purpose
  docker compose -f "$CURRENT_LINK/docker-compose.production.yml" $OVERRIDE_ARGS --env-file "$ENV_FILE" "$@"
}

RELEASE_DIR="$DEPLOY_ROOT/releases/$SHORT"
IMAGE="purlay-api:sha-$SHORT"
CANDIDATE="purlay-api:candidate-$SHORT"
BACKUP_DIR=""

# A failure before the switch: the site is as it was. Remove what was exported for it, unless it
# is the release that is running (a deploy of the same commit again).
before_switch() {
  echo "FAIL: $1; nothing was changed" >&2
  docker image rm "$CANDIDATE" >/dev/null 2>&1 || true
  [ "$PREVIOUS" = "$SHORT" ] || rm -rf "$RELEASE_DIR"
  record "failed-before-switch $SHORT: $1"
  exit 1
}

# ── 2. The release, built once and tried before it is used ──────────────────
echo "==> exporting $SHORT"
if [ "$PREVIOUS" != "$SHORT" ]; then
  rm -rf "$RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  git archive "$SHA" | tar -x -C "$RELEASE_DIR" || before_switch "the commit could not be exported"
fi

# A bind-mounted file that changed is not seen by a container that is not recreated.
RECREATE=""
if ! diff -rq "$CURRENT_LINK/docker" "$RELEASE_DIR/docker" >/dev/null 2>&1; then
  RECREATE="--force-recreate"
  echo "docker/ differs from the running release: the services will be recreated"
fi

echo "==> building $CANDIDATE"
docker build --label "org.opencontainers.image.revision=$SHA" -t "$CANDIDATE" "$RELEASE_DIR" \
  || before_switch "the image did not build"

echo "==> smoke-testing $CANDIDATE"
# The checkout is the commit being deployed, so its script is the release's own.
"$ROOT/scripts/image-smoke.sh" "$CANDIDATE" || before_switch "the smoke test failed"

# ── 3. The backup ────────────────────────────────────────────────────────────
echo "==> backing up, just before the switch"
mkdir -p "$DEPLOY_ROOT/backups"
BACKUP_OUTPUT="$(COMPOSE_FILE="$CURRENT_LINK/docker-compose.production.yml" ENV_FILE="$ENV_FILE" \
  "$ROOT/scripts/backup.sh" "$DEPLOY_ROOT/backups")" || before_switch "the backup failed"
printf '%s\n' "$BACKUP_OUTPUT"
BACKUP_DIR="$(printf '%s\n' "$BACKUP_OUTPUT" | tail -n 1)"
[ -f "$BACKUP_DIR/database.dump" ] || before_switch "the backup failed: no database.dump in '$BACKUP_DIR'"

# ── 4. The switch ────────────────────────────────────────────────────────────
# The env file holds secrets: written beside itself and moved into place, so a disk that fills
# leaves the old file, not half of a new one. `cp -p` keeps its mode and owner.
set_image() {
  cp -p "$ENV_FILE" "$ENV_FILE.new"
  sed "s|^PURLAY_IMAGE=.*|PURLAY_IMAGE=$1|" "$ENV_FILE" > "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
}

# What the running site is made of, read back after the start.
running_the_commit() {
  local service container seen
  for service in api scheduler; do
    container="$(compose ps -q "$service")"
    [ -n "$container" ] || { echo "$service is not running" >&2; return 1; }
    seen="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container")"
    [ "$seen" = "$SHA" ] || { echo "$service is running commit '$seen', not $SHA" >&2; return 1; }
  done
}

# Only the files and the image's name were touched: nothing has migrated, nothing is restored.
undo_files() {
  cat "$ENV_FILE.prev" > "$ENV_FILE"
  rm -f "$ENV_FILE.new"
  ln -sfn "releases/$PREVIOUS" "$CURRENT_LINK"
}

rollback() {
  trap '' INT TERM HUP # a second signal does not cut the way back short
  echo "FAIL: $1" >&2
  echo "==> rolling back to $PREVIOUS: the database from $BACKUP_DIR, the old image and release" >&2
  # shellcheck disable=SC2086 # RECREATE is one flag or nothing
  if compose stop api scheduler \
    && COMPOSE_FILE="$CURRENT_LINK/docker-compose.production.yml" ENV_FILE="$ENV_FILE" \
      "$ROOT/scripts/restore.sh" "$BACKUP_DIR" --database purlay --replace --no-bucket \
    && cat "$ENV_FILE.prev" > "$ENV_FILE" \
    && ln -sfn "releases/$PREVIOUS" "$CURRENT_LINK" \
    && compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" $RECREATE; then
    rm -f "$MARKER"
    echo "rolled back to $PREVIOUS; the failed database is kept as purlay_before_restore_*, drop it when done" >&2
    record "rolled-back $PREVIOUS (tried $SHORT): $1 backup=$BACKUP_DIR"
    exit 1
  fi
  echo "ROLLBACK FAILED. The site may be down. The backup that holds the data is $BACKUP_DIR;" >&2
  echo "docs/ARCHITECTURE.md, 'Upgrading and rolling back', says how to restore it by hand." >&2
  record "rollback-failed $PREVIOUS (tried $SHORT): $1 backup=$BACKUP_DIR"
  exit 2
}

echo "==> switching to $SHORT"
# The way back for the env file, taken before anything can be told to stop: a rollback reads it.
cp -p "$ENV_FILE" "$ENV_FILE.prev" || before_switch "the env file could not be copied"
echo "previous=$PREVIOUS new=$SHORT backup=$BACKUP_DIR" > "$MARKER"
trap 'rollback "the deploy was told to stop"' INT TERM HUP
if ! { docker tag "$CANDIDATE" "$IMAGE" \
  && set_image "$IMAGE" \
  && ln -sfn "releases/$SHORT" "$CURRENT_LINK"; }; then
  undo_files
  rm -f "$MARKER"
  trap - INT TERM HUP
  before_switch "the files could not be switched"
fi
docker image rm "$CANDIDATE" >/dev/null 2>&1 || true

# shellcheck disable=SC2086 # RECREATE is one flag or nothing
compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" $RECREATE || rollback "the stack did not start"

# ── 5. What is running ───────────────────────────────────────────────────────
echo "==> checking what is running"
running_the_commit || rollback "the stack started but is not running $SHORT"

rm -f "$MARKER"
trap - INT TERM HUP
record "deployed $PREVIOUS -> $SHORT image=$IMAGE was=$PREVIOUS_IMAGE backup=$BACKUP_DIR"

# ── 6. Forgetting ────────────────────────────────────────────────────────────
# The running release and the one before it are never forgotten; the rest beyond the newest KEEP are.
# Release and backup names are ours (8 hex, purlay-<stamp>), so a name with a space is not one of them
# and is left where it is.
kept=0
for name in $(ls -1t "$DEPLOY_ROOT/releases"); do
  kept=$((kept + 1))
  { [ "$kept" -le "$KEEP" ] || [ "$name" = "$SHORT" ] || [ "$name" = "$PREVIOUS" ]; } && continue
  [[ "$name" =~ ^[0-9a-f]{8}$ ]] || continue
  rm -rf "${DEPLOY_ROOT:?}/releases/$name"
  docker image rm "purlay-api:sha-$name" >/dev/null 2>&1 || true
done
kept=0
for name in $(ls -1t "$DEPLOY_ROOT/backups" 2>/dev/null); do
  kept=$((kept + 1))
  [ "$kept" -le "$KEEP" ] && continue
  [[ "$name" =~ ^purlay-[0-9A-Za-z]+$ ]] || continue
  rm -rf "${DEPLOY_ROOT:?}/backups/$name"
done

echo "deployed $SHORT (was $PREVIOUS)"
