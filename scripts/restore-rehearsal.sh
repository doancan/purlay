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

# Off is the default, and a stack that never asked for archiving runs with exactly the settings
# it had before it existed (D-202): the whole of what follows up to "point-in-time" is that stack.
echo "== WAL archiving is off by default, and a backup then has no base backup"
[ "$(compose exec -T postgres psql -U purlay -d postgres -Atc 'show archive_mode')" = off ] \
  || { echo "archive_mode is not off on a stack that did not ask for archiving" >&2; exit 1; }
[ "$(compose exec -T postgres psql -U purlay -d postgres -Atc 'show archive_timeout')" = 0 ] \
  || { echo "archive_timeout is set on a stack that did not ask for archiving" >&2; exit 1; }

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
# Archiving is off, so no base backup: the nightly dump of a self-hoster who never asked for more.
[ ! -e "$BACKUP/base.tar.gz" ] || { echo "a base backup was taken with archiving off" >&2; exit 1; }
scripts/check-backup.sh "$OUT" --wal
if scripts/restore-pitr.sh "$BACKUP" --to '2026-10-27 12:00:00+00' --archive "$WORK" --into "$WORK/nopitr" >"$WORK/nopitr.out" 2>&1; then
  echo "a point-in-time restore went ahead from a backup that has no base backup" >&2
  exit 1
fi
grep -q 'has no base backup' "$WORK/nopitr.out" || { echo "refused for another reason:" >&2; cat "$WORK/nopitr.out" >&2; exit 1; }

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
LOGICAL_STARTED=$SECONDS
scripts/restore.sh "$BACKUP" --database purlay --replace --bucket live
LOGICAL_SECONDS=$((SECONDS - LOGICAL_STARTED))
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

# --- point-in-time recovery (#118, D-202) -------------------------------------------------------
# Everything above is a stack that never asked for archiving. Now it does, as an operator would: the
# env file gains WAL_ARCHIVE=on and `up` recreates the database. Then the case the nightly dump cannot
# answer: write some rows, note the time, write more, lose EVERYTHING — every volume, the archive on
# the same disk with it — and recover from the base backup and the copy of the archive that was
# shipped off the server, to the noted time. The recovered database must be exactly what the live one
# held at that moment, by the same comparison as every restore: the earlier rows there, the later
# ones not.
result() {
  echo "$*"
  if [ -n "${REHEARSAL_RESULT_FILE:-}" ]; then echo "- $*" >>"$REHEARSAL_RESULT_FILE"; fi
}
pg() { compose exec -T postgres psql -U purlay -d purlay -v ON_ERROR_STOP=1 -Atq "$@"; }
ARCHIVE_SECONDS=10

echo "== point-in-time: archiving is switched on and the database restarts"
{
  echo "WAL_ARCHIVE=on"
  echo "WAL_ARCHIVE_TIMEOUT=$ARCHIVE_SECONDS"
} >>"$ENV_FILE"
compose stop api
compose up -d --wait postgres
[ "$(pg -c 'show archive_mode')" = on ] || { echo "archiving did not switch on" >&2; compose logs postgres >&2; exit 1; }
[ "$(pg -c 'show archive_timeout')" = "${ARCHIVE_SECONDS}s" ] || { echo "archive_timeout is not what the env file says" >&2; exit 1; }
compose up -d --wait api

echo "== a backup with archiving on holds a base backup, checked and checksummed"
PITR_BACKUP="$(scripts/backup.sh "$WORK/pitr-backups" | tail -n 1)"
for file in base.tar.gz base.label base.meta; do
  [ -s "$PITR_BACKUP/$file" ] || { echo "the backup has no $file" >&2; ls -l "$PITR_BACKUP" >&2; exit 1; }
done
grep -q 'base.tar.gz' "$PITR_BACKUP/SHA256SUMS" || { echo "the base backup is not in SHA256SUMS" >&2; exit 1; }
START_WAL="$(sed -n 's/^start_wal=//p' "$PITR_BACKUP/base.meta")"
scripts/check-backup.sh "$WORK/pitr-backups" --wal

echo "== rows, a noted time, more rows"
pg -c "create table pitr_probe (id int primary key, batch text not null, note text not null)"
pg -c "insert into pitr_probe select g, 'A', 'before ' || g from generate_series(1, 500) g"
pg -c "update pitr_probe set note = 'edited before' where id % 50 = 0"
pg -c "delete from pitr_probe where id = 7"
scripts/compare-databases.sh --snapshot purlay >"$WORK/at-the-time.txt"
NOTED="$(pg -c "select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
sleep 2
pg -c "insert into pitr_probe select g, 'B', 'after ' || g from generate_series(501, 800) g"
pg -c "update pitr_probe set note = 'edited after' where id % 50 = 0"
pg -c "delete from pitr_probe where id between 100 and 120"
pg -c "drop table pitr_probe"
pg -c "create table pitr_probe (id int primary key, batch text not null, note text not null)"
COMMITTED="$(pg -c "select clock_timestamp()")"

# What the database could lose: the time between the last commit and the segment that holds it being
# in the archive. PostgreSQL closes a segment after archive_timeout seconds of activity, so it is
# bounded by that, which is what the documented RPO is.
echo "== the newest commit reaches the archive within archive_timeout"
RPO_STARTED=$SECONDS
until [ "$(pg -c "select last_archived_time > '$COMMITTED'::timestamptz from pg_stat_archiver")" = t ]; do
  [ $((SECONDS - RPO_STARTED)) -le $((ARCHIVE_SECONDS * 4)) ] \
    || { echo "the newest commit was not archived within four times archive_timeout" >&2; pg -c 'select * from pg_stat_archiver' >&2; exit 1; }
  sleep 1
done
RPO_SECONDS=$((SECONDS - RPO_STARTED))
[ "$(pg -c "select failed_count from pg_stat_archiver")" = 0 ] || { echo "the archiver failed on a segment" >&2; exit 1; }

echo "== the archive is shipped off the host, then everything on the host is lost"
SHIPPED="$WORK/shipped-archive"
mkdir "$SHIPPED"
DB_IMAGE="$(compose config --images | grep '^postgres:' | head -n 1)"
SOURCE="$(wal_archive_source)"
# Read as root, as an operator's shipping job must be (the segments belong to the postgres user and
# are 0600), and handed back to the invoking user.
docker run --rm --user root -v "$SOURCE:/from:ro" -v "$SHIPPED:/to" --entrypoint sh "$DB_IMAGE" -c \
  "cp -a /from/. /to/ && chown -R $(id -u):$(id -g) /to"
SHIPPED_COUNT="$(find "$SHIPPED" -name '*.gz' | wc -l | tr -d ' ')"
[ "$SHIPPED_COUNT" -gt 1 ] || { echo "the shipped archive holds $SHIPPED_COUNT segments" >&2; exit 1; }
# Nothing may be left of the archive's disk.
compose down --volumes
[ -z "$(docker volume ls -q --filter "name=${PROJECT}_")" ] || { echo "volumes survived the loss" >&2; exit 1; }

echo "== what a restore refuses: no zone, a time before the base backup, an archive that cannot reach, one that lacks its start"
if scripts/restore-pitr.sh "$PITR_BACKUP" --to '2026-10-27 12:00:00' --archive "$SHIPPED" --into "$WORK/refused-1" >"$WORK/refused-1.out" 2>&1; then
  echo "a time without a zone was accepted" >&2
  exit 1
fi
grep -q 'not a time with a zone' "$WORK/refused-1.out" || { cat "$WORK/refused-1.out" >&2; exit 1; }

if scripts/restore-pitr.sh "$PITR_BACKUP" --to '2000-01-01 00:00:00+00' --archive "$SHIPPED" --into "$WORK/refused-2" >"$WORK/refused-2.out" 2>&1; then
  echo "a time before the base backup was complete was accepted" >&2
  exit 1
fi
grep -q 'before the base backup was complete' "$WORK/refused-2.out" || { cat "$WORK/refused-2.out" >&2; exit 1; }
[ ! -e "$WORK/refused-2" ] || { echo "a refused restore left its directory" >&2; exit 1; }

# The segments after the base backup are missing: the archive ends before the noted time.
cp -R "$SHIPPED" "$WORK/archive-cut"
find "$WORK/archive-cut" -name '[0-9A-F]*.gz' ! -name '*.backup.gz' | while IFS= read -r segment; do
  if [[ "$(basename "$segment" .gz)" > "$START_WAL" ]]; then rm -f "$segment"; fi
done
if scripts/restore-pitr.sh "$PITR_BACKUP" --to "$NOTED" --archive "$WORK/archive-cut" --into "$WORK/refused-3" >"$WORK/refused-3.out" 2>&1; then
  echo "a recovery went ahead on an archive that does not reach the time" >&2
  exit 1
fi
grep -q 'archive ends before' "$WORK/refused-3.out" || { cat "$WORK/refused-3.out" >&2; exit 1; }

cp -R "$SHIPPED" "$WORK/archive-headless"
rm -f "$WORK/archive-headless/$START_WAL.gz"
if scripts/restore-pitr.sh "$PITR_BACKUP" --to "$NOTED" --archive "$WORK/archive-headless" --into "$WORK/refused-4" >"$WORK/refused-4.out" 2>&1; then
  echo "a recovery went ahead on an archive without its starting segment" >&2
  exit 1
fi
grep -q 'does not hold' "$WORK/refused-4.out" || { cat "$WORK/refused-4.out" >&2; exit 1; }
[ -z "$(docker ps -a -q --filter 'name=purlay-pitr-')" ] || { echo "a refused restore left a container behind" >&2; exit 1; }

echo "== recover to $NOTED, from the base backup and the shipped archive, into a new instance"
RESTORE_STARTED=$SECONDS
scripts/restore-pitr.sh "$PITR_BACKUP" --to "$NOTED" --archive "$SHIPPED" --expect "$WORK/at-the-time.txt" --into "$WORK/pitr" | tee "$WORK/pitr.out"
RESTORE_SECONDS=$((SECONDS - RESTORE_STARTED))
[ -z "$(docker ps -a -q --filter 'name=purlay-pitr-')" ] || { echo "the recovery left a container behind" >&2; exit 1; }
[ -z "$(docker volume ls -q --filter 'name=purlay-pitr-')" ] || { echo "the recovery left a volume behind" >&2; exit 1; }

echo "== applying it: the rebuilt stack takes the recovered database through the ordinary restore"
compose up -d --wait postgres garage
compose run --rm --no-deps -T storage-init
scripts/restore.sh "$WORK/pitr/recovered" --database purlay --replace --no-bucket
[ "$(pg -c "select count(*) from pitr_probe where batch = 'A'")" = 499 ] || { echo "the rows written before the time are not all there" >&2; exit 1; }
[ "$(pg -c "select count(*) from pitr_probe where batch = 'B'")" = 0 ] || { echo "rows written after the time are there" >&2; exit 1; }
[ "$(pg -c "select count(*) from pitr_probe where note = 'edited before'")" = 10 ] || { echo "the edit made before the time is not what it was" >&2; exit 1; }
scripts/compare-databases.sh --against "$WORK/at-the-time.txt" purlay
compose up -d --wait api

result "restore rehearsal: logical restore of database and bucket after a total loss took ${LOGICAL_SECONDS} s"
result "restore rehearsal: point-in-time restore to a noted time took ${RESTORE_SECONDS} s (shipped archive of ${SHIPPED_COUNT} segments, base backup of $(wc -c <"$PITR_BACKUP/base.tar.gz" | tr -d ' ') bytes)"
result "restore rehearsal: the newest commit was in the archive ${RPO_SECONDS} s after it was made (archive_timeout ${ARCHIVE_SECONDS} s)"
