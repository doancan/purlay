#!/usr/bin/env bash
# Rehearse a restore end to end, from nothing, and judge it by comparison (#248, D-95).
#
#   scripts/restore-rehearsal.sh [api-image]      # default: builds ./Dockerfile as purlay-api:rehearsal
#
# D-44 says a restore is tested on a schedule, and D-73 that one is performed before
# the team moves in. This is that test as a command: it brings up a throwaway copy of
# the production stack (its own Compose project and throwaway secrets, no proxy and so
# no published port), fills it with awkward data, backs it up with scripts/backup.sh,
# restores into a NEW database and a NEW bucket with scripts/restore.sh, and fails
# unless scripts/compare-databases.sh says the databases are identical and the
# restored bucket matches its manifest. Then it removes everything it made.
#
# The first run of this, by hand, with what it found, is docs/spikes/backup-restore.md.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${1:-}"
WORK="$(mktemp -d)"
PROJECT="purlay-rehearsal-$$"
export COMPOSE_PROJECT_NAME="$PROJECT"
export COMPOSE_FILE="$PWD/docker-compose.production.yml"
export ENV_FILE="$WORK/production.env"

cleanup() {
  status=$?
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
  [ "$status" = 0 ] && echo "rehearsal passed" || echo "REHEARSAL FAILED (exit $status)" >&2
}
trap cleanup EXIT

if [ -z "$IMAGE" ]; then
  IMAGE="purlay-api:rehearsal"
  docker build -q -t "$IMAGE" . >/dev/null
fi

cat >"$ENV_FILE" <<EOF
PURLAY_IMAGE=$IMAGE
APP_URL=https://rehearsal.example.test
POSTGRES_PASSWORD=$(openssl rand -hex 16)
GARAGE_RPC_SECRET=$(openssl rand -hex 32)
S3_ACCESS_KEY_ID=GK$(openssl rand -hex 12)
S3_SECRET_ACCESS_KEY=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)
GITHUB_CLIENT_ID=rehearsal
GITHUB_CLIENT_SECRET=rehearsal
EOF

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

echo "== stack: api, postgres, garage (no proxy)"
compose up -d --wait api
scripts/production-init.sh

echo "== data: a database and a bucket worth restoring"
compose exec -T postgres psql -U purlay -d purlay -v ON_ERROR_STOP=1 -q <docs/spikes/backup-restore.seed.sql >/dev/null
compose run --rm --no-deps -T \
  -v "$PWD/scripts/rehearsal-seed-bucket.ts:/ops/seed.ts:ro" \
  --entrypoint /usr/local/bin/bun api /ops/seed.ts

echo "== backup"
OUT="$WORK/backups"
BACKUP="$(scripts/backup.sh "$OUT" | tail -n 1)"

echo "== restore into a new database and a new bucket"
scripts/restore.sh "$BACKUP" --bucket purlay-restore

echo "== compare"
scripts/compare-databases.sh purlay purlay_restore

# The restored database must also be one the application will serve from: ready
# means every migration is recorded and the identifier columns still compare
# byte-wise (D-40), which a restore into a differently provisioned cluster loses.
echo "== the application reads the restored database"
compose run --rm --no-deps -T \
  -e DATABASE_URL="postgres://purlay:$(sed -n 's/^POSTGRES_PASSWORD=//p' "$ENV_FILE")@postgres:5432/purlay_restore" \
  -e MIGRATE_ON_START=false \
  -v "$PWD/scripts/rehearsal-ready.ts:/ops/ready.ts:ro" \
  --entrypoint /usr/local/bin/bun api /ops/ready.ts

# The case a backup is for: the server is gone. Record what the live database
# looks like, destroy every volume, rebuild the stack empty, and restore from the
# backup directory alone — over the database the stack created for itself, with the
# API stopped, into the service's own (empty) bucket.
echo "== total loss: destroy every volume, rebuild from the backup alone"
scripts/compare-databases.sh purlay purlay >"$WORK/before.txt"
compose down --volumes
compose up -d --wait postgres garage
scripts/production-init.sh
scripts/restore.sh "$BACKUP" --database purlay --replace
compose up -d --wait api
scripts/compare-databases.sh purlay purlay >"$WORK/after.txt"
diff "$WORK/before.txt" "$WORK/after.txt" || {
  echo "the rebuilt database differs from the one that was lost" >&2
  exit 1
}
echo "rebuilt database: every table's count and checksum is what it was before the loss"
compose run --rm --no-deps -T --user "$(id -u):$(id -g)" \
  -v "$BACKUP/bucket:/backup:ro" \
  -v "$PWD/scripts/bucket-copy.ts:/ops/bucket-copy.ts:ro" \
  -v "$PWD/scripts/bucket-manifest.ts:/ops/bucket-manifest.ts:ro" \
  --entrypoint /usr/local/bin/bun api /ops/bucket-copy.ts verify /backup
