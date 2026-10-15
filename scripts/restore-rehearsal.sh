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
GARAGE_ADMIN_TOKEN=$(openssl rand -hex 32)
S3_ACCESS_KEY_ID=GK$(openssl rand -hex 12)
S3_SECRET_ACCESS_KEY=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)
GITHUB_CLIENT_ID=rehearsal
GITHUB_CLIENT_SECRET=rehearsal
EOF

# shellcheck source=scripts/ops-common.sh
. scripts/ops-common.sh

# The API alone, without the one-shot that prepares the object store (D-144): the state a
# stack from before that service is in, or one whose storage-init was skipped. It reports
# ready, and a backup of it must fail, say what to do, and leave nothing that looks like one.
echo "== stack: postgres, garage, and the api without storage-init (no proxy)"
compose up -d --wait postgres garage
compose up -d --wait --no-deps api

echo "== a backup before the object store is prepared fails cleanly"
if scripts/backup.sh "$WORK/early" >"$WORK/early.out" 2>&1; then
  echo "backup.sh succeeded on a stack whose object store was never prepared" >&2
  exit 1
fi
grep -q 'storage-init' "$WORK/early.out" || { echo "the failure does not point at storage-init" >&2; cat "$WORK/early.out" >&2; exit 1; }
if [ -n "$(ls -A "$WORK/early")" ]; then
  echo "a failed backup left something behind: $(ls "$WORK/early")" >&2
  exit 1
fi

# What an operator does: the ordinary `up`, which runs storage-init before the API.
echo "== up prepares the object store"
compose up -d --wait api
[ "$(docker inspect -f '{{.State.ExitCode}}' "$(compose ps -a -q storage-init)")" = 0 ] \
  || { echo "storage-init did not complete" >&2; compose logs storage-init >&2; exit 1; }

echo "== data: a database and a bucket worth restoring"
compose exec -T postgres psql -U purlay -d purlay -v ON_ERROR_STOP=1 -q <docs/spikes/backup-restore.seed.sql >/dev/null
compose run --rm --no-deps -T \
  -v "$PWD/scripts/rehearsal-seed-bucket.ts:/ops/seed.ts:ro" \
  --entrypoint /usr/local/bin/bun api /ops/seed.ts

echo "== backup"
OUT="$WORK/backups"
BACKUP="$(scripts/backup.sh "$OUT" | tail -n 1)"
# The bucket is in it: a backup that skipped it would still exit 0 (#677).
[ -f "$BACKUP/bucket/manifest.json" ] || { echo "the backup has no bucket" >&2; ls -R "$BACKUP" >&2; exit 1; }

# Every message is in it, in the clear: nobody but the user who ran it may read it, whatever
# that user's umask. Single permission bits, so the test is the same on macOS and Linux.
echo "== the backup is readable by its owner alone"
exposed="$(find "$BACKUP" "$OUT" \( -perm -040 -o -perm -020 -o -perm -010 -o -perm -004 -o -perm -002 -o -perm -001 \) | head -n 5)"
if [ -n "$exposed" ]; then
  echo "the backup is readable or writable by others:" >&2
  echo "$exposed" >&2
  exit 1
fi

echo "== restore with the defaults: a new database and a new bucket"
scripts/restore.sh "$BACKUP"

# The bucket now holds the objects, so a second restore must refuse for that reason
# BEFORE it swaps the database: the marker table is in the database it would replace.
echo "== a restore that cannot import its bucket does not touch the database"
compose exec -T postgres psql -U purlay -d purlay_restore -q -c 'create table restore_marker (n int)'
if scripts/restore.sh "$BACKUP" --replace >"$WORK/refused.out" 2>&1; then
  echo "a restore into a non-empty bucket went ahead" >&2
  exit 1
fi
grep -q 'already holds' "$WORK/refused.out" || { echo "refused for another reason:" >&2; cat "$WORK/refused.out" >&2; exit 1; }
[ "$(compose exec -T postgres psql -U purlay -d purlay_restore -Atc "select count(*) from information_schema.tables where table_name = 'restore_marker'")" = 1 ] \
  || { echo "the refused restore replaced the database anyway" >&2; exit 1; }
compose exec -T postgres psql -U purlay -d purlay_restore -q -c 'drop table restore_marker'

# Rolling back an upgrade restores the database and leaves the (non-empty, append-only) live
# bucket alone: the flag must restore the database, import nothing, and not mind the bucket.
echo "== the database alone can be restored with --no-bucket"
scripts/restore.sh "$BACKUP" --database purlay_restore_nb --no-bucket | tee "$WORK/nobucket.out"
grep -q 'not restored (--no-bucket)' "$WORK/nobucket.out"
scripts/compare-databases.sh purlay purlay_restore_nb >/dev/null

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

# A dump that has been cut short, with its checksums regenerated to match, as a careless
# edit or a full disk would leave it. Restoring it over the LIVE database must fail, say why,
# and leave the live database exactly as it was: nothing is dropped until the dump is known good.
echo "== a damaged backup leaves the live database untouched"
BAD="$WORK/bad"
cp -R "$BACKUP" "$BAD"
head -c $(($(wc -c <"$BACKUP/database.dump") / 2)) "$BACKUP/database.dump" >"$BAD/database.dump"
(cd "$BAD" && find . -type f ! -name SHA256SUMS | sort | while IFS= read -r file; do sha256_check "$file"; done >SHA256SUMS)
scripts/compare-databases.sh purlay purlay >"$WORK/live-before.txt"
compose stop api
if scripts/restore.sh "$BAD" --database purlay --replace --bucket live >"$WORK/damaged.out" 2>&1; then
  echo "a truncated dump was restored over the live database" >&2
  exit 1
fi
scripts/compare-databases.sh purlay purlay >"$WORK/live-after.txt" \
  || { echo "the live database is gone or unreadable after a refused restore" >&2; cat "$WORK/damaged.out" >&2; exit 1; }
diff "$WORK/live-before.txt" "$WORK/live-after.txt" >/dev/null \
  || { echo "the live database changed under a refused restore" >&2; exit 1; }
leftover="$(compose exec -T postgres psql -U purlay -d postgres -Atc "select datname from pg_database where datname like '%\_incoming\_%' or datname like '%before_restore%'")"
[ -z "$leftover" ] || { echo "a refused restore left databases behind: $leftover" >&2; exit 1; }
echo "  refused, and the live database is as it was"
compose start api
compose up -d --wait api

# The case a backup is for: the server is gone. Record what the live database
# looks like, destroy every volume, rebuild the stack empty, and restore from the
# backup directory alone — over the database the stack created for itself, with the
# API stopped, into the service's own (empty) bucket.
echo "== total loss: destroy every volume, rebuild from the backup alone"
scripts/compare-databases.sh purlay purlay >"$WORK/before.txt"
compose down --volumes
compose up -d --wait postgres garage
compose run --rm --no-deps -T storage-init
scripts/restore.sh "$BACKUP" --database purlay --replace --bucket live
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
