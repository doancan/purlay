#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh (#248, D-95).
#
#   scripts/restore.sh <backup-dir> [--database NAME] [--bucket NAME] [--replace]
#
# By default it restores into a NEW database called purlay_restore, which is how a
# backup is rehearsed without touching anything live; compare it with the source
# using scripts/compare-databases.sh. To recover for real:
#
#   1. stop the API:          docker compose -f docker-compose.production.yml stop api
#   2. restore over the live: scripts/restore.sh <dir> --database purlay --replace
#   3. start it again:        docker compose -f docker-compose.production.yml start api
#
# What it refuses, because each is a way to make things worse quietly:
#   - a backup whose files no longer match SHA256SUMS;
#   - a target database that already has tables, unless --replace;
#   - replacing the live database while the API is running;
#   - a bucket that is not empty (the copy imports only into an empty one).
set -euo pipefail
# shellcheck source=scripts/ops-common.sh
. "$(dirname "$0")/ops-common.sh"

BACKUP="${1:-}"
[ -d "$BACKUP" ] || die "usage: restore.sh <backup-dir> [--database NAME] [--bucket NAME] [--replace]"
BACKUP="$(cd "$BACKUP" && pwd)"
shift
TARGET_DB="purlay_restore"
TARGET_BUCKET=""
REPLACE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --database) TARGET_DB="${2:?--database needs a name}"; shift 2 ;;
    --bucket) TARGET_BUCKET="${2:?--bucket needs a name}"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$TARGET_DB" =~ ^[a-z_][a-z0-9_]*$ ]] || die "database name must be lowercase letters, digits and underscores"

echo "checking the backup against its checksums"
(cd "$BACKUP" && sha256_check -c SHA256SUMS >/dev/null) || die "the backup does not match SHA256SUMS; not restoring"
echo "  intact"

# --- database ----------------------------------------------------------------
exists="$(in_postgres psql -U "$DB_USER" -d postgres -Atc "select 1 from pg_database where datname = '$TARGET_DB'")"
if [ -n "$exists" ]; then
  tables="$(in_postgres psql -U "$DB_USER" -d "$TARGET_DB" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
  if [ "$tables" != "0" ] && [ "$REPLACE" != 1 ]; then
    die "$TARGET_DB already has $tables tables; pass --replace to drop and recreate it"
  fi
  if [ "$TARGET_DB" = "$LIVE_DB" ] && compose ps --status running --services | grep -qx api; then
    die "refusing to replace $LIVE_DB while the api is running; stop it first"
  fi
  in_postgres psql -U "$DB_USER" -d postgres -c "drop database \"$TARGET_DB\" with (force)" >/dev/null
fi
in_postgres createdb -U "$DB_USER" "$TARGET_DB"
echo "database: restoring into $TARGET_DB"
# --exit-on-error: a restore that skips what it could not apply is a restore of
# something else. --no-owner/--no-acl match how the dump was taken.
in_postgres pg_restore -U "$DB_USER" -d "$TARGET_DB" --no-owner --no-acl --exit-on-error <"$BACKUP/database.dump"
in_postgres psql -U "$DB_USER" -d "$TARGET_DB" -Atc "analyze" >/dev/null
echo "database: restored"

# --- bucket ------------------------------------------------------------------
if [ -d "$BACKUP/bucket" ] && has_api; then
  bucket_env=()
  if [ -n "$TARGET_BUCKET" ]; then
    # A different bucket is for rehearsal; make it, and let the service's key use it.
    key="$(sed -n 's/^S3_ACCESS_KEY_ID=//p' "$ENV_FILE" | tail -n 1)"
    compose exec -T -e RUST_LOG=warn garage /garage bucket info "$TARGET_BUCKET" >/dev/null 2>&1 \
      || compose exec -T -e RUST_LOG=warn garage /garage bucket create "$TARGET_BUCKET" >/dev/null
    compose exec -T -e RUST_LOG=warn garage /garage bucket allow --read --write --owner "$TARGET_BUCKET" --key "$key" >/dev/null
    bucket_env=(-e "S3_BUCKET=$TARGET_BUCKET")
    echo "bucket: restoring into $TARGET_BUCKET"
  else
    echo "bucket: restoring into the service's bucket"
  fi
  compose run --rm --no-deps -T --user "$(id -u):$(id -g)" ${bucket_env[@]+"${bucket_env[@]}"} \
    -v "$BACKUP/bucket:/backup:ro" \
    -v "$ROOT/scripts/bucket-copy.ts:/ops/bucket-copy.ts:ro" \
    -v "$ROOT/scripts/bucket-manifest.ts:/ops/bucket-manifest.ts:ro" \
    --entrypoint /usr/local/bin/bun api /ops/bucket-copy.ts import /backup
else
  echo "bucket: nothing to restore"
fi
echo "restore finished: $TARGET_DB"
