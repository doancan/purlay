#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh (#248, D-95).
#
#   scripts/restore.sh <backup-dir> [--database NAME] [--bucket NAME|live | --no-bucket] [--replace]
#
# By default it restores into a NEW database, purlay_restore, and a NEW bucket, the
# service's own name plus "-restore", which is how a backup is rehearsed without
# touching anything live; compare the database with the source using
# scripts/compare-databases.sh. To recover for real:
#
#   1. stop the API:          docker compose -f docker-compose.production.yml stop api
#   2. restore over the live: scripts/restore.sh <dir> --database purlay --replace --bucket live
#   3. start it again:        docker compose -f docker-compose.production.yml start api
#
# `--no-bucket` restores the database alone. It is for rolling back an upgrade: attachments are
# only ever added, a schema migration does not touch them, and the live bucket is not empty,
# which a bucket import refuses. (docs/ARCHITECTURE.md, "Upgrading and rolling back")
#
# The order is built so that nothing the operator has is lost to a backup that turns
# out to be bad. Everything that can be checked is checked BEFORE anything is changed:
#   - the files against SHA256SUMS, and the dump against `pg_restore --list` — a dump
#     can be truncated and its checksum regenerated, and only reading it tells;
#   - the target database (tables? the live one with the API running?) and the target
#     bucket (empty? the copy imports only into an empty one).
# The dump is then restored into a STAGING database, which is checked (every table in
# the dump is there) and only then swapped in by renaming: the database that was there
# is kept as <name>_before_restore_<time>, never dropped by this script. A failure at
# any point drops the staging database and leaves the target as it was.
set -euo pipefail
# shellcheck source=scripts/ops-common.sh
. "$(dirname "$0")/ops-common.sh"

USAGE="usage: restore.sh <backup-dir> [--database NAME] [--bucket NAME|live | --no-bucket] [--replace]"
BACKUP="${1:-}"
[ -d "$BACKUP" ] || die "$USAGE"
BACKUP="$(cd "$BACKUP" && pwd)"
shift
TARGET_DB="purlay_restore"
TARGET_BUCKET=""
REPLACE=0
NO_BUCKET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --database) TARGET_DB="${2:?--database needs a name}"; shift 2 ;;
    --bucket) TARGET_BUCKET="${2:?--bucket needs a name, or live}"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --no-bucket) NO_BUCKET=1; shift ;;
    -h|--help) echo "$USAGE"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ "$NO_BUCKET" = 0 ] || [ -z "$TARGET_BUCKET" ] || die "--no-bucket and --bucket contradict each other"
[[ "$TARGET_DB" =~ ^[a-z_][a-z0-9_]*$ ]] || die "database name must be lowercase letters, digits and underscores"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="${TARGET_DB}_incoming_$$"
STAGING_CREATED=0
cleanup() {
  status=$?
  if [ "$STAGING_CREATED" = 1 ]; then
    in_postgres psql -U "$DB_USER" -d postgres -c "drop database if exists \"$STAGING\" with (force)" >/dev/null 2>&1 || true
  fi
  if [ "$status" != 0 ]; then echo "restore FAILED; $TARGET_DB is as it was" >&2; fi
}
trap cleanup EXIT

# --- 1. everything that can be checked without changing anything ---------------
echo "checking the backup against its checksums"
(cd "$BACKUP" && sha256_check -c SHA256SUMS >/dev/null) || die "the backup does not match SHA256SUMS; not restoring"
echo "  intact"

echo "reading the dump"
TOC="$(mktemp)"
ERR="$(mktemp)"
if ! in_postgres pg_restore --list <"$BACKUP/database.dump" >"$TOC" 2>"$ERR"; then
  cat "$ERR" >&2
  rm -f "$TOC" "$ERR"
  die "database.dump is not a readable archive (truncated?); nothing was changed"
fi
EXPECTED_TABLES="$(grep -c ' TABLE public ' "$TOC" || true)"
rm -f "$TOC" "$ERR"
[ "$EXPECTED_TABLES" -gt 0 ] || die "database.dump holds no tables; nothing was changed"
echo "  readable, $EXPECTED_TABLES tables"

exists="$(in_postgres psql -U "$DB_USER" -d postgres -Atc "select 1 from pg_database where datname = '$TARGET_DB'")"
if [ -n "$exists" ]; then
  tables="$(in_postgres psql -U "$DB_USER" -d "$TARGET_DB" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
  if [ "$tables" != "0" ] && [ "$REPLACE" != 1 ]; then
    die "$TARGET_DB already has $tables tables; pass --replace to swap it out (it is kept, renamed)"
  fi
  if [ "$TARGET_DB" = "$LIVE_DB" ] && compose ps --status running --services | grep -x api >/dev/null; then
    die "refusing to replace $LIVE_DB while the api is running; stop it first"
  fi
fi

BUCKET_STEP=0
if [ "$NO_BUCKET" = 1 ]; then
  echo "bucket: not restored (--no-bucket)"
elif [ -d "$BACKUP/bucket" ] && has_api; then
  BUCKET_STEP=1
  bucket_env=()
  if [ "$TARGET_BUCKET" = "live" ]; then
    echo "bucket: the service's own"
  else
    if [ -z "$TARGET_BUCKET" ]; then
      service_bucket="$(sed -n 's/^S3_BUCKET=//p' "$ENV_FILE" | tail -n 1)"
      TARGET_BUCKET="${service_bucket:-purlay-attachments}-restore"
    fi
    # A different bucket is for rehearsal; make it, and let the service's key use it.
    key="$(sed -n 's/^S3_ACCESS_KEY_ID=//p' "$ENV_FILE" | tail -n 1)"
    compose exec -T -e RUST_LOG=warn garage /garage bucket info "$TARGET_BUCKET" >/dev/null 2>&1 \
      || compose exec -T -e RUST_LOG=warn garage /garage bucket create "$TARGET_BUCKET" >/dev/null
    compose exec -T -e RUST_LOG=warn garage /garage bucket allow --read --write --owner "$TARGET_BUCKET" --key "$key" >/dev/null
    bucket_env=(-e "S3_BUCKET=$TARGET_BUCKET")
    echo "bucket: $TARGET_BUCKET"
  fi
  bucket_run() { # <bucket-copy arguments...>
    compose run --rm --no-deps -T --user "$(id -u):$(id -g)" ${bucket_env[@]+"${bucket_env[@]}"} \
      -v "$BACKUP/bucket:/backup:ro" \
      -v "$ROOT/scripts/bucket-copy.ts:/ops/bucket-copy.ts:ro" \
      -v "$ROOT/scripts/bucket-manifest.ts:/ops/bucket-manifest.ts:ro" \
      --entrypoint /usr/local/bin/bun api /ops/bucket-copy.ts "$@"
  }
  held="$(bucket_run count | tail -n 1)"
  [ "$held" = "0" ] || die "the target bucket already holds $held objects and the copy imports only into an empty one; nothing was changed. Name another with --bucket"
fi

# --- 2. staging: restore, then check, before the target is touched -------------
in_postgres createdb -U "$DB_USER" "$STAGING"
STAGING_CREATED=1
echo "database: restoring into $STAGING"
# --exit-on-error: a restore that skips what it could not apply is a restore of
# something else. --no-owner/--no-acl match how the dump was taken.
in_postgres pg_restore -U "$DB_USER" -d "$STAGING" --no-owner --no-acl --exit-on-error <"$BACKUP/database.dump"
in_postgres psql -U "$DB_USER" -d "$STAGING" -Atc "analyze" >/dev/null
got="$(in_postgres psql -U "$DB_USER" -d "$STAGING" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
[ "$got" = "$EXPECTED_TABLES" ] || die "the staging database has $got tables and the dump lists $EXPECTED_TABLES"
echo "  staged, $got tables"

# --- 3. swap -------------------------------------------------------------------
if [ -n "$exists" ]; then
  KEPT="${TARGET_DB}_before_restore_${STAMP}"
  # Nothing else may be connected for a rename; the API is stopped (checked above for
  # the live database) and anything else is ended.
  in_postgres psql -U "$DB_USER" -d postgres -Atc "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$TARGET_DB' and pid <> pg_backend_pid()" >/dev/null
  in_postgres psql -U "$DB_USER" -d postgres -c "alter database \"$TARGET_DB\" rename to \"$KEPT\"" >/dev/null
  echo "database: the previous $TARGET_DB is kept as $KEPT (drop it when you are satisfied)"
fi
in_postgres psql -U "$DB_USER" -d postgres -c "alter database \"$STAGING\" rename to \"$TARGET_DB\"" >/dev/null
STAGING_CREATED=0
echo "database: restored as $TARGET_DB"

# --- 4. bucket -----------------------------------------------------------------
if [ "$BUCKET_STEP" = 1 ]; then
  bucket_run import /backup
else
  echo "bucket: nothing to restore"
fi
echo "restore finished: $TARGET_DB"
