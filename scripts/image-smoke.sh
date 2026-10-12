#!/usr/bin/env bash
# Run the API image the way production does — read-only root filesystem, no
# capabilities, no new privileges — against a PostgreSQL of its own, and look at it
# from outside: liveness, readiness, the container's own health check, and the user it
# runs as. A Dockerfile that builds has proved nothing about an image that starts
# (CONTRIBUTING §6.3).
#
#   scripts/image-smoke.sh purlay-api:ci
#
# **It brings its own database, and needs nothing from the machine's.** A throwaway
# network, a throwaway PostgreSQL on it (the image named in docker-compose.yml, so it is
# declared in one place), the API on the same network reaching it by container name, and
# nothing published for the database. It used to use the development compose database
# through `host.docker.internal`; the day that database's port was bound to the loopback
# address, as it should be, a container could no longer reach it and the check was red
# on main until someone looked (scripts/image-smoke.test.ts keeps it from coming back).
# Everything it made is removed when it ends, whatever the outcome.
set -euo pipefail

IMAGE="${1:?usage: image-smoke.sh <image>}"
HOST_PORT="${SMOKE_PORT:-13001}"
SUFFIX="$$"
NETWORK="purlay-smoke-$SUFFIX"
DATABASE="purlay-smoke-db-$SUFFIX"
NAME="purlay-api-smoke-$SUFFIX"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One place names the PostgreSQL image: the development compose file.
POSTGRES_IMAGE="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\(postgres:[^[:space:]]*\).*/\1/p' "$ROOT/docker-compose.yml" | head -n 1)"
[ -n "$POSTGRES_IMAGE" ] || { echo "no postgres image in docker-compose.yml" >&2; exit 1; }

cleanup() {
  docker logs "$NAME" 2>&1 | tail -n 15 || true
  docker rm -f "$NAME" "$DATABASE" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NETWORK" >/dev/null

# The same cluster settings as development (identifier columns compare byte-wise, D-40, and
# readiness refuses a database that disagrees). No port is published: it is reachable by name
# from this network and from nowhere else.
docker run -d --name "$DATABASE" --network "$NETWORK" \
  -e POSTGRES_USER=purlay -e POSTGRES_PASSWORD=purlay -e POSTGRES_DB=purlay \
  -e POSTGRES_INITDB_ARGS="--locale=C --encoding=UTF8" \
  "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$DATABASE" pg_isready -U purlay -d purlay >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$DATABASE" pg_isready -U purlay -d purlay >/dev/null || { echo "FAIL: the throwaway database never became ready" >&2; exit 1; }

# The key is generated here: nothing in the repository is a usable secret.
ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)"

# The link to the database is private and unencrypted, and production (which the image is)
# refuses that unless told it is so (DATABASE_ALLOW_PLAINTEXT).
docker run -d --name "$NAME" --network "$NETWORK" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p "127.0.0.1:$HOST_PORT:3001" \
  -e APP_URL=https://chat.example.test \
  -e DATABASE_URL="postgres://purlay:purlay@$DATABASE:5432/purlay" \
  -e GITHUB_CLIENT_ID=smoke -e GITHUB_CLIENT_SECRET=smoke \
  -e DATABASE_ALLOW_PLAINTEXT=true \
  -e ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  -e MIGRATE_ON_START=true \
  -e S3_ENDPOINT=http://storage.invalid:3900 -e S3_BUCKET=smoke \
  -e S3_ACCESS_KEY_ID=GK000000000000000000000001 \
  -e S3_SECRET_ACCESS_KEY=0000000000000000000000000000000000000000000000000000000000000002 \
  "$IMAGE" >/dev/null

# Wait for a positive condition — a 200 — not for the absence of an error: a
# container that never started has no errors either (CONTRIBUTING §6.3).
wait_for() { # <path> <seconds>
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$HOST_PORT$1" || true)" = "200" ]; then
      return 0
    fi
    sleep 1
  done
  echo "FAIL: $1 did not answer 200 within $2 s" >&2
  return 1
}

wait_for /health 30
echo "liveness:  $(curl -s "http://localhost:$HOST_PORT/health")"

# Readiness is the real question: the database answers, every migration is applied.
wait_for /health/ready 60
echo "readiness: $(curl -s "http://localhost:$HOST_PORT/health/ready")"

# The client is served from the same origin (D-61): the shell with the document's policy,
# and the first script it names, cached for good. A shell that names no script, or names
# one that is not there, is a page that never starts — the failure nobody's probe sees.
# Each capture ends in `|| true` so that the check after it, with its reason, is what fails —
# under `set -e` a capture that fails would end the script there, saying nothing.
headers="$(curl -s -D - -o /dev/null "http://localhost:$HOST_PORT/" || true)"
shell="$(curl -s "http://localhost:$HOST_PORT/" || true)"
grep -q '<div id="root">' <<<"$shell" || { echo "FAIL: / is not the client's shell" >&2; exit 1; }
grep -qi "^content-security-policy:.*script-src 'self'" <<<"$headers" ||
  { echo "FAIL: the shell does not carry the document's policy" >&2; exit 1; }
# Exactly one policy: two are both enforced, and the API's would load nothing.
[ "$(grep -ci '^content-security-policy:' <<<"$headers" || true)" = "1" ] ||
  { echo "FAIL: the shell carries more than one policy" >&2; exit 1; }
asset="$(grep -o '/assets/[^"]*\.js' <<<"$shell" | head -n 1 || true)"
[ -n "$asset" ] || { echo "FAIL: the shell names no script" >&2; exit 1; }
asset_headers="$(curl -s -D - -o /dev/null "http://localhost:$HOST_PORT$asset" || true)"
grep -q '^HTTP/[0-9.]* 200' <<<"$asset_headers" || { echo "FAIL: $asset is not served" >&2; exit 1; }
grep -qi '^cache-control:.*immutable' <<<"$asset_headers" ||
  { echo "FAIL: $asset is not cached for good" >&2; exit 1; }
echo "client:    / is the shell, $asset is served and immutable"

# The container's own HEALTHCHECK must agree. Its interval is 10 s, so give it two.
deadline=$((SECONDS + 40))
status=""
while [ "$SECONDS" -lt "$deadline" ]; do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$NAME")"
  [ "$status" = "healthy" ] && break
  sleep 2
done
echo "healthcheck: $status"
[ "$status" = "healthy" ] || { echo "FAIL: the container never reported healthy" >&2; exit 1; }

# Not root. The image has no `id`, so ask the runtime.
identity="$(docker run --rm --read-only --entrypoint /usr/local/bin/bun "$IMAGE" -e 'console.log(process.getuid())')"
echo "uid:       $identity"
[ "$identity" != "0" ] || { echo "FAIL: the image runs as root" >&2; exit 1; }

# No test ships in the image that runs in production (.dockerignore), and neither does the
# code that only tests use. Asked of the image itself, not of the ignore file.
untested="$(docker run --rm --read-only --entrypoint /usr/local/bin/bun "$IMAGE" -e '
  let found = 0;
  for (const root of ["/app/apps", "/app/packages"]) {
    for (const file of new Bun.Glob("**/*.test.ts").scanSync({ cwd: root, followSymlinks: false })) found += 1;
  }
  found += [...new Bun.Glob("apps/api/src/testing/*").scanSync({ cwd: "/app" })].length;
  console.log(found);
')"
echo "test files in the image: $untested"
[ "$untested" = "0" ] || { echo "FAIL: the image ships $untested test files" >&2; exit 1; }

# And nothing to reach for.
if docker exec "$NAME" sh -c true >/dev/null 2>&1; then
  echo "FAIL: the image contains a shell" >&2
  exit 1
fi
echo "shell:     none"

# Evidence for the memory budget (PRD §5, enforced by #73): the idle footprint, reported.
echo "idle memory: $(docker stats --no-stream --format '{{.MemUsage}}' "$NAME")"
echo "image smoke test passed"
