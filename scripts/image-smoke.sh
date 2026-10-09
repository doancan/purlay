#!/usr/bin/env bash
# Run the API image the way production does — read-only root filesystem, no
# capabilities, no new privileges — against the compose PostgreSQL, and look at
# it from outside: liveness, readiness, the container's own health check, and the
# user it runs as. A Dockerfile that builds has proved nothing about an image
# that starts (CONTRIBUTING §6.3).
#
#   scripts/image-smoke.sh purlay-api:ci
#
# Needs a reachable database: DATABASE_URL, as the host sees it (default: the
# compose one). `localhost` is rewritten to the host as the container sees it.
set -euo pipefail

IMAGE="${1:?usage: image-smoke.sh <image>}"
DATABASE_URL="${DATABASE_URL:-postgres://purlay:purlay@localhost:5432/purlay}"
HOST_PORT="${SMOKE_PORT:-13001}"
NAME="purlay-api-smoke-$$"

cleanup() {
  docker logs "$NAME" 2>&1 | tail -n 15 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The key is generated here: nothing in the repository is a usable secret.
ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)"

# The link to the compose database is private and unencrypted, and production
# (which the image is) refuses that unless told it is so (DATABASE_ALLOW_PLAINTEXT).
docker run -d --name "$NAME" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --add-host host.docker.internal:host-gateway \
  -p "$HOST_PORT:3001" \
  -e APP_URL=https://chat.example.test \
  -e DATABASE_URL="${DATABASE_URL//localhost/host.docker.internal}" \
  -e GITHUB_CLIENT_ID=smoke -e GITHUB_CLIENT_SECRET=smoke \
  -e DATABASE_ALLOW_PLAINTEXT=true \
  -e ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  -e MIGRATE_ON_START=true \
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
echo "image smoke test passed"
