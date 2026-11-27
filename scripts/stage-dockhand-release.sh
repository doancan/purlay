#!/usr/bin/env bash
# Run the Dockhand stack's release under the existing Docker operator's authority.
set -euo pipefail
umask 077

fail() { printf 'dockhand-release: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 5 ] || fail 'usage: scripts/stage-dockhand-release.sh <compose-project> <env-file> <tested-GHCR-image@sha256:digest> <tested-commit> <protected-dump|--fresh> | <compose-project> <env-file> --follow-release <GHCR-package> <protected-backup-directory>'
project="$1"
env_file="$2"
image="$3"
revision="$4"
dump="$5"
receipts="${PURLAY_DOCKHAND_RECEIPTS:-}"

[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ && "${#project}" -le 63 ]] || fail 'give the existing Compose project name (up to 63 characters)'
package=''
if [ "$image" = --follow-release ]; then
  package="$revision"
  [[ "$package" =~ ^ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+-api$ ]] || fail 'give the release GHCR package, without its tag'
  [[ "$dump" = /* && -d "$dump" && -w "$dump" ]] || fail 'give an existing private protected-backup directory by absolute path'
else
  [[ "$image" =~ ^ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] || fail 'give the tested GHCR image by digest'
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail 'give the full tested Git commit'
fi
[[ -f "$env_file" && -r "$env_file" ]] || fail 'the stack environment file is unavailable'
[[ "$receipts" = /* && -d "$receipts" && -w "$receipts" ]] || fail 'set PURLAY_DOCKHAND_RECEIPTS to an existing private writable absolute directory'

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="$receipts/$project.lock"
mkdir -- "$lock" 2>/dev/null || fail "could not lock $project in the receipt directory"
backup_dir=''
cleanup() {
  if [ -n "$backup_dir" ]; then
    rm -f -- "$backup_dir/postgres.dump.partial"
    rmdir -- "$backup_dir" 2>/dev/null || true
  fi
  rm -f -- "$lock/receipt"
  rmdir -- "$lock"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

registry_digest() {
  local value
  value="$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$1")" || fail "could not resolve $1"
  [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'the registry did not return an immutable manifest digest'
  printf '%s\n' "$value"
}
latest_release() {
  curl --silent --show-error --fail --max-time 20 "https://api.github.com/repos/$repository/releases/latest" | jq -er '.tag_name'
}
verify_release_current() {
  [[ "$(latest_release)" = "$latest" && "$(registry_digest "$package:release")" = "$release_digest" ]] \
    || fail "$1"
}

if [ -n "$package" ]; then
  release_digest="$(registry_digest "$package:release")"
  image="$package@$release_digest"
  repository="${package#ghcr.io/}"
  repository="${repository%-api}"
  latest="$(latest_release)" || fail 'could not determine the latest published GitHub release'
  [[ "$latest" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'the latest release has an unexpected version tag'
  refs="refs/purlay-deploy/$project"
  GIT_TERMINAL_PROMPT=0 git -C "$root" fetch --no-tags --no-recurse-submodules --no-write-fetch-head \
    "https://github.com/$repository.git" "+refs/heads/main:$refs/main" "+refs/tags/$latest:$refs/release" \
    || fail 'could not fetch release and main history from GitHub'
  revision="$(git -C "$root" rev-parse "$refs/release^{commit}")" || fail 'could not resolve the published tag commit'
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail 'Git did not return the full published commit'
  git -C "$root" merge-base --is-ancestor "$revision" "$refs/main" || fail 'the published release commit is outside main'
  [[ "$(registry_digest "$package:sha-$revision")" = "$release_digest" ]] || fail 'the release tag does not yet match the tested main build of the published commit'
fi

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
verify_old_stack() {
  [[ "$(managed api)" = "$old_api" && "$(managed scheduler)" = "$old_scheduler" ]] \
    || fail 'the existing API or scheduler changed during preflight'
  [[ "$(managed postgres)" = "$postgres" && "$(managed garage)" = "$garage" ]] \
    || fail 'the existing PostgreSQL or Garage changed during preflight'
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
    if [ -f "$preflight" ] && grep -Fqx -- "image=$image" "$preflight"; then rm -- "$preflight"; fi
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
  dump_to_verify="$dump"
  if [ -n "$package" ]; then
    [ ! -e "$preflight" ] || fail 'an earlier rollout has a pending preflight; resolve it before scheduling another release'
    IFS='|' read -r _ api_image_id api_pin _ <<< "$old_api"
    IFS='|' read -r _ scheduler_image_id scheduler_pin _ <<< "$old_scheduler"
    [[ "$api_image_id" = "$scheduler_image_id" && "$api_pin" = "$scheduler_pin" &&
      "$api_pin" = "$package@sha256:"* && "${api_pin##*:}" =~ ^[0-9a-f]{64}$ ]] \
      || fail 'the automatic schedule requires a healthy baseline pinned to one digest of this package'
    baseline="$(docker image inspect --format '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$api_pin")" \
      || fail 'could not verify the running baseline image'
    IFS='|' read -r baseline_id baseline_revision <<< "$baseline"
    [[ "$baseline_id" = "$api_image_id" && "$baseline_revision" =~ ^[0-9a-f]{40}$ && "$baseline_revision" != "$revision" ]] &&
      git -C "$root" merge-base --is-ancestor "$baseline_revision" "$revision" \
      || fail 'the release is not a forward revision from the running baseline'
    attempt="$receipts/$project-$digest.attempted"
    [ ! -e "$attempt" ] \
      || fail 'this digest already has an automatic attempt; inspect its state and use the explicit release command to recover'
    backup_dir="$(mktemp -d "$dump/$project-$digest.XXXXXXXXXX")" || fail 'could not reserve a protected dump location'
    dump="$backup_dir/postgres.dump"
    dump_to_verify="$dump.partial"
    "${compose[@]}" exec -T backup pg_dump --format=custom --no-owner --no-acl </dev/null > "$dump_to_verify" \
      || fail 'could not take the protected pre-update database dump'
    "${compose[@]}" exec -T backup pg_restore --file=/dev/null < "$dump_to_verify" \
      || fail 'the protected dump payload could not be read'
  fi
  [[ -f "$dump_to_verify" && -r "$dump_to_verify" && -s "$dump_to_verify" ]] || fail 'a protected, readable pre-update PostgreSQL dump is required'
  checksum="$(sha256sum < "$dump_to_verify")" || fail 'could not hash the protected dump'
  listing="$("${compose[@]}" exec -T backup pg_restore --list < "$dump_to_verify")" || fail 'the backup service could not read the protected dump'
  [[ "$listing" = *' TABLE public kysely_migration '* ]] || fail 'the protected dump has no Purlay migration table'

  nonce="$(mktemp -d "$lock/init.XXXXXXXXXX")" || fail 'could not allocate the initializer name'
  one_off="$project-storage-preflight-${nonce##*.}"
  rmdir -- "$nonce"
  if [ -n "$package" ]; then
    verify_release_current 'the release could not be reverified before initialization'
    verify_old_stack
    printf 'image=%s\nrevision=%s\ninitializer=%s\nbackup_sha256=%s\n' "$image" "$revision" "$one_off" "${checksum%% *}" > "$lock/receipt" \
      || fail 'could not prepare the automatic attempt receipt'
    mv -- "$dump_to_verify" "$dump" || fail 'could not retain the verified protected dump'
    printf 'dockhand-release: protected pre-update database dump %s\n' "$dump"
    # From this point, an interrupted Docker command may have reached the initializer.
    mv -- "$lock/receipt" "$attempt" || fail 'could not record the pending automatic attempt'
  fi
  "${compose[@]}" run --no-deps --pull never -T --name "$one_off" storage-init </dev/null \
    || fail "initializer refused; readers were left in place (container: $one_off)"
  proof="$(initializer "$one_off")" || fail 'initializer completed without a verified receipt; readers were left in place'
  [[ "$(sha256sum < "$dump")" = "$checksum" ]] || fail 'the protected dump changed during preflight'
  verify_old_stack
  if [ -n "$package" ]; then
    verify_release_current 'the release changed during preflight; readers were left in place'
  fi
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
