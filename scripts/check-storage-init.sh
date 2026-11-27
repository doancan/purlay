#!/usr/bin/env bash
# Verify one Dockhand stack's initializer against its tested digest. Requires Docker read access.
set -euo pipefail

fail() { printf 'storage-init: %s\n' "$*" >&2; exit 1; }
project=${1:-}
image=${2:-}
explicit=''
if [ "$#" -eq 4 ] && [ "$3" = --one-off ]; then
  explicit="$4"
  [[ "$explicit" =~ ^[a-z0-9][A-Za-z0-9_-]*$ ]] || fail "give the one-off initializer container name"
elif [ "$#" -ne 2 ]; then
  fail "usage: scripts/check-storage-init.sh <compose-project> <tested-image@sha256:digest> [--one-off <container-name>]"
fi
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "give the Compose project name"
[[ "$image" =~ ^ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] || fail "give the tested GHCR image by digest"

# Resolve a digest already on the host. Never look up the moving release tag or pull another image.
tested="$(docker image inspect --format '{{.Id}}|{{json .Config.Entrypoint}}' "$image")" || fail "the tested image is unavailable locally"
IFS='|' read -r image_id expected_entrypoint <<< "$tested"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Docker did not report an image ID"

container="$explicit"
if [ -z "$container" ]; then
  # Compose versions use either an absent one-off label or False for a managed service.
  candidates="$(docker container ls --all --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=storage-init' \
    --format '{{.ID}}|{{.Label "com.docker.compose.oneoff"}}')" || fail "could not list the stack's containers"
  while IFS='|' read -r candidate oneoff; do
    [ -n "$candidate" ] && [ "$oneoff" != True ] || continue
    [[ "$candidate" =~ ^[0-9a-f]{64}$ && ( -z "$oneoff" || "$oneoff" = False ) ]] \
      || fail "Docker did not report a managed container ID"
    [ -z "$container" ] || fail "expected exactly one managed storage-init container for $project"
    container="$candidate"
  done <<< "$candidates"
  [ -n "$container" ] || fail "expected exactly one managed storage-init container for $project"
fi

# Read only these fields. A full inspect would also expose the Garage admin token.
format='{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{.Image}}|{{json .Config.Cmd}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{json .Config.Entrypoint}}'
state="$(docker container inspect --format "$format" "$container")" || fail "the initializer disappeared or could not be inspected"
IFS='|' read -r owner service oneoff seen command status code started finished entrypoint <<< "$state"
if [ -n "$explicit" ]; then
  [[ "$owner" = "$project" && "$service" = storage-init && "$oneoff" = True ]] \
    || fail "the inspected container is not the stack's one-off initializer"
else
  [[ "$owner" = "$project" && "$service" = storage-init && ( -z "$oneoff" || "$oneoff" = False ) ]] \
    || fail "the inspected container is not the stack's managed initializer"
fi
[ "$seen" = "$image_id" ] || fail "the initializer did not use the tested image"
[[ "$command" = '["apps/api/src/cli/storage-init.ts"]' && -n "$expected_entrypoint" && "$entrypoint" = "$expected_entrypoint" ]] \
  || fail "unexpected initializer command"
[ "$status" = exited ] || fail "the initializer has not finished (state: $status)"
[ "$code" = 0 ] || fail "the initializer failed (exit code: $code)"
timestamp='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
[[ "$started" =~ $timestamp && "$finished" =~ $timestamp && "$started" != 0001-* && "$finished" != 0001-* ]] \
  || fail "Docker has no start or finish time for the initializer"

printf 'storage-init: %s completed for %s at %s\n' "$project" "$image" "$finished"
