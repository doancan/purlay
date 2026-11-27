#!/usr/bin/env bash
# Run the Dockhand stack's release under the existing Docker operator's authority.
set -euo pipefail
umask 077

fail() { printf 'dockhand-release: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 5 ] || fail 'usage: scripts/stage-dockhand-release.sh <compose-project> <env-file> <tested-GHCR-image@sha256:digest> <tested-commit> <protected-dump|--fresh>'
project="$1"
env_file="$2"
image="$3"
revision="$4"
dump="$5"
receipts="${PURLAY_DOCKHAND_RECEIPTS:-}"

[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ && "${#project}" -le 63 ]] || fail 'give the existing Compose project name (up to 63 characters)'
[[ "$image" =~ ^ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] || fail 'give the tested GHCR image by digest'
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail 'give the full tested Git commit'
[[ -f "$env_file" && -r "$env_file" ]] || fail 'the stack environment file is unavailable'
[[ "$receipts" = /* && -d "$receipts" && -w "$receipts" ]] || fail 'set PURLAY_DOCKHAND_RECEIPTS to an existing private writable absolute directory'

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="$receipts/$project.lock"
mkdir -- "$lock" 2>/dev/null || fail "could not lock $project in the receipt directory"
trap 'rm -f -- "$lock/receipt"; rmdir -- "$lock"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Protect unrelated containers even if the operator's environment enables orphan cleanup.
export COMPOSE_REMOVE_ORPHANS=false
export PURLAY_IMAGE="$image"
compose=(docker compose --project-name "$project" --env-file "$env_file" -f "$root/docker-compose.dockhand.yml")
"${compose[@]}" config --quiet || fail 'the Dockhand Compose configuration is invalid'

digest="${image##*:}"
receipt="$receipts/$project-$digest.receipt"
preflight="$receipts/$project.preflight"
inspect_image() {
  docker image inspect --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image"
}
if ! tested="$(inspect_image 2>/dev/null)"; then
  docker pull "$image" || fail 'could not pull the tested digest'
  tested="$(inspect_image)" || fail 'could not inspect the tested digest'
fi
IFS='|' read -r image_id label <<< "$tested"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ && "$label" = "$revision" ]] || fail 'the local digest does not match the tested revision'

managed() {
  local service="$1" list id oneoff selected=''
  list="$(docker container ls --all --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" \
    --format '{{.ID}}|{{.Label "com.docker.compose.oneoff"}}')" || fail "could not list $service"
  while IFS='|' read -r id oneoff; do
    [ -n "$id" ] && [ "$oneoff" != True ] || continue
    [[ "$id" =~ ^[0-9a-f]{64}$ && ( -z "$oneoff" || "$oneoff" = False ) && -z "$selected" ]] \
      || fail "expected at most one managed $service container"
    selected="$id"
  done <<< "$list"
  if [ -n "$selected" ]; then
    docker container inspect --format '{{.Id}}|{{.Image}}|{{.Config.Image}}|{{.State.Status}}|{{with .State.Health}}{{.Status}}{{end}}|{{.State.StartedAt}}' "$selected" \
      || fail "could not inspect $service"
  fi
}

healthy() {
  [[ "$1" = *'|running|healthy|'* ]]
}
candidate() {
  [[ "$1" = *"|$image_id|$image|running|healthy|"* ]]
}
initializer() {
  if [ -n "$1" ]; then
    "$root/scripts/check-storage-init.sh" "$project" "$image" --one-off "$1"
  else
    "$root/scripts/check-storage-init.sh" "$project" "$image"
  fi
}
record_completion() {
  printf '%s\nproject=%s\nimage=%s\nrevision=%s\n%s\napi=%s\nscheduler=%s\nbackup_sha256=%s\n' \
    "$one_off" "$project" "$image" "$revision" "$proof" "${api%%|*}" "${scheduler%%|*}" "$checksum" > "$lock/receipt"
  mv -- "$lock/receipt" "$receipt" || fail 'both readers are healthy; rerun this exact release to record completion'
  printf '%s\ndockhand-release: %s ready at %s (%s); receipt %s\n' "$proof" "$project" "$image" "$revision" "$receipt"
}

old_api="$(managed api)"
old_scheduler="$(managed scheduler)"
one_off=''
checksum=''
if candidate "$old_api" && candidate "$old_scheduler"; then
  if [ -f "$receipt" ] && grep -Fqx -- "api=${old_api%%|*}" "$receipt" &&
    grep -Fqx -- "scheduler=${old_scheduler%%|*}" "$receipt"; then
    IFS= read -r one_off < "$receipt" || fail 'the local initializer receipt is unreadable'
    proof="$(initializer "$one_off")" || fail 'the running digest has no verified initializer receipt'
    printf '%s\ndockhand-release: %s already ready at %s (%s)\n' "$proof" "$project" "$image" "$revision"
    exit 0
  elif [ -f "$preflight" ] && grep -Fqx -- "image=$image" "$preflight"; then
    # A timeout or interruption can leave both readers healthy before completion was recorded.
    IFS= read -r one_off < "$preflight" || fail 'the local preflight checkpoint is unreadable'
    checksum="$(sed -n 's/^backup_sha256=//p' "$preflight")"
    previous_api_id="$(sed -n 's/^old_api=//p' "$preflight")"
    previous_scheduler_id="$(sed -n 's/^old_scheduler=//p' "$preflight")"
    [[ -n "$one_off" && "$checksum" =~ ^[0-9a-f]{64}$ &&
      "$previous_api_id" =~ ^[0-9a-f]{64}$ && "$previous_api_id" != "${old_api%%|*}" &&
      "$previous_scheduler_id" =~ ^[0-9a-f]{64}$ && "$previous_scheduler_id" != "${old_scheduler%%|*}" ]] &&
      grep -Fqx -- "revision=$revision" "$preflight" &&
      grep -Fqx -- "postgres=$(managed postgres)" "$preflight" &&
      grep -Fqx -- "garage=$(managed garage)" "$preflight" \
      || fail 'the interrupted release could not be associated with its verified preflight'
    proof="$(initializer "$one_off")" || fail 'the interrupted release lacks a verified initializer'
    api="$old_api"
    scheduler="$old_scheduler"
    record_completion
    rm -- "$preflight"
    exit 0
  fi
  # Adopt a healthy, exact-digest stack with an independently verified managed initializer.
  proof="$(initializer '')" || fail 'the running digest has no verified initializer receipt'
  api="$old_api"
  scheduler="$old_scheduler"
  record_completion
  exit 0
fi

if [ "$dump" = --fresh ]; then
  containers="$(docker container ls --all --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" \
    || fail 'could not list the project containers'
  volumes="$(docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}')" \
    || fail 'could not list the project volumes'
  [ -z "$containers$volumes" ] || fail 'fresh deployment requires a project without containers or volumes'
  # Compose can also reuse a same-named volume without a project label.
  volumes="$(docker volume ls --format '{{.Name}}')" || fail 'could not check for preexisting stack volumes'
  for volume in postgres-data garage-data backups backup-status; do
    if grep -Fqx -- "${project}_$volume" <<< "$volumes"; then
      fail 'fresh deployment requires a project without containers or volumes'
    fi
  done
  "${compose[@]}" up -d --wait --wait-timeout 900 api scheduler backup || fail 'fresh Compose startup failed'
  proof="$(initializer '')" || fail 'fresh Compose startup lacks a verified initializer receipt'
else
  healthy "$old_api" && healthy "$old_scheduler" || fail 'the existing API and scheduler must both be healthy before an update'
  postgres="$(managed postgres)"
  garage="$(managed garage)"
  healthy "$postgres" && healthy "$garage" || fail 'the existing PostgreSQL and Garage must both be healthy before the update'
  [[ -f "$dump" && -r "$dump" && -s "$dump" ]] || fail 'a protected, readable pre-update PostgreSQL dump is required'
  checksum="$(sha256sum < "$dump")" || fail 'could not hash the protected dump'
  listing="$("${compose[@]}" exec -T backup pg_restore --list < "$dump")" || fail 'the backup service could not read the protected dump'
  [[ "$listing" = *' TABLE public kysely_migration '* ]] || fail 'the protected dump has no Purlay migration table'

  nonce="$(mktemp -d "$lock/init.XXXXXXXXXX")" || fail 'could not allocate the initializer name'
  one_off="$project-storage-preflight-${nonce##*.}"
  rmdir -- "$nonce"
  "${compose[@]}" run --no-deps --pull never -T --name "$one_off" storage-init </dev/null \
    || fail "initializer refused; readers were left in place (container: $one_off)"
  proof="$(initializer "$one_off")" || fail 'initializer completed without a verified receipt; readers were left in place'
  [[ "$(sha256sum < "$dump")" = "$checksum" ]] || fail 'the protected dump changed during preflight'
  [[ "$(managed api)" = "$old_api" && "$(managed scheduler)" = "$old_scheduler" ]] \
    || fail 'the existing API or scheduler changed during preflight'
  [[ "$(managed postgres)" = "$postgres" && "$(managed garage)" = "$garage" ]] \
    || fail 'the existing PostgreSQL or Garage changed during preflight'
  checksum="${checksum%% *}"
  printf '%s\nimage=%s\nrevision=%s\nbackup_sha256=%s\nold_api=%s\nold_scheduler=%s\npostgres=%s\ngarage=%s\n' \
    "$one_off" "$image" "$revision" "$checksum" "${old_api%%|*}" "${old_scheduler%%|*}" "$postgres" "$garage" > "$lock/receipt"
  mv -- "$lock/receipt" "$preflight" || fail 'could not record the verified preflight; readers were left in place'

  "${compose[@]}" stop scheduler || fail 'could not stop the old scheduler'
  "${compose[@]}" up -d --no-deps --pull never --wait --wait-timeout 900 api \
    || fail 'API update or readiness failed; scheduler release was withheld'
  api="$(managed api)"
  candidate "$api" || fail 'API did not become healthy at the tested digest; scheduler release was withheld'
  "${compose[@]}" up -d --no-deps --pull never --wait --wait-timeout 900 scheduler \
    || fail 'scheduler update or readiness failed'
fi

api="$(managed api)"
scheduler="$(managed scheduler)"
candidate "$api" && candidate "$scheduler" || fail 'both readers must be healthy at the tested digest'
record_completion
if [ -n "$one_off" ]; then rm -- "$preflight"; fi
