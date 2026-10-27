#!/usr/bin/env bash
# Back up the database and the attachment bucket into one directory (#248, D-95).
#
#   scripts/backup.sh [destination]        # default ./backups -> backups/purlay-<UTC time>/
#
# - database.dump   `pg_dump --format=custom`, taken inside the database container so its
#                   version is the server's; consistent without stopping anything (one snapshot)
# - database.toc    the dump's table of contents, which proves the archive reads back
# - base.tar.gz     only when WAL archiving is on (D-202): a physical base backup, the starting
#   base.label      point of scripts/restore-pitr.sh, with the WAL segment it begins in and the
#   base.meta       moment it is complete (a restore cannot name an earlier time)
# - bucket/         every object and a manifest of sizes and SHA-256s (scripts/bucket-copy.ts)
# - SHA256SUMS      over all of it, checked again before a restore uses it
#
# A backup nobody has restored is a hope: run scripts/restore.sh into a throwaway
# database and scripts/compare-databases.sh on a schedule (D-44). The rehearsal that
# did so, and what it found, is docs/spikes/backup-restore.md.
#
# **Who can read it:** only the user who ran the script. A backup holds every message and
# every e-mail address in the clear, so the directory is 0700 and its files 0600, whatever
# the caller's umask; moving it to a place others can read is a decision for the operator.
#
# **A failure leaves nothing behind that looks like a backup.** The directory is removed if
# the script does not finish, so a half-written one cannot be mistaken for a backup later.
#
# Environment: COMPOSE_FILE, ENV_FILE (see ops-common.sh).
set -euo pipefail
# shellcheck source=scripts/ops-common.sh
. "$(dirname "$0")/ops-common.sh"
umask 077

DEST="${1:-backups}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="$DEST/purlay-$STAMP"
mkdir "$DIR"
FINISHED=0
cleanup() {
  if [ "$FINISHED" != 1 ]; then
    rm -rf "$DIR"
    echo "backup FAILED; the partial $DIR was removed" >&2
  fi
}
trap cleanup EXIT

echo "database: dumping $LIVE_DB"
in_postgres pg_dump -U "$DB_USER" -d "$LIVE_DB" --format=custom --no-owner --no-acl >"$DIR/database.dump"
[ -s "$DIR/database.dump" ] || die "the dump is empty"
# Reading the archive back is the cheapest proof it is one; a truncated pipe is not.
in_postgres pg_restore --list <"$DIR/database.dump" >"$DIR/database.toc"
[ -s "$DIR/database.toc" ] || die "the dump has no table of contents; it is not a usable archive"
echo "database: $(wc -c <"$DIR/database.dump" | tr -d ' ') bytes, $(grep -c 'TABLE DATA' "$DIR/database.toc" || true) tables with data"

# Point-in-time recovery is on when the SERVER says it archives (WAL_ARCHIVE=on, D-202), not when an
# env file says so: the file is what was meant, the setting is what is running. The base backup is the
# starting point a restore replays the archive from; without it the archive restores nothing.
ARCHIVING="$(in_postgres psql -U "$DB_USER" -d postgres -Atc 'show archive_mode')" || die "could not ask the database whether it archives"
if [ "$ARCHIVING" = on ] || [ "$ARCHIVING" = always ]; then
  echo "base backup: taking one (WAL archiving is on)"
  # Written straight to a file, not through a pipeline, like the dump: a failed pg_basebackup in a
  # pipe can leave a valid-looking file and a zero exit. It waits for its last WAL segment to be
  # archived, so a failing archive would hang it: bounded (BASE_BACKUP_TIMEOUT seconds), and the
  # failure is the backup's, which also stops a deploy that takes one first.
  in_postgres timeout "${BASE_BACKUP_TIMEOUT:-1800}" pg_basebackup -U "$DB_USER" -D - --format=tar --compress=gzip \
    --wal-method=fetch --checkpoint=fast --label "purlay-$STAMP" >"$DIR/base.tar.gz" \
    || die "the base backup failed or did not finish; if WAL archiving is failing, that is why (docs/CONFIG.md, Point-in-time recovery)"
  [ -s "$DIR/base.tar.gz" ] || die "the base backup is empty"
  # backup_label is the record of where it began; reading it back also proves the archive reads.
  tar -xzOf "$DIR/base.tar.gz" backup_label >"$DIR/base.label" || die "the base backup does not read back"
  START_WAL="$(sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]\{24\}\))$/\1/p' "$DIR/base.label")"
  [ -n "$START_WAL" ] || die "the base backup's label names no starting WAL segment"
  FINISHED_AT="$(in_postgres psql -U "$DB_USER" -d postgres -Atc "select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
  # A restore cannot stop before the base backup is complete: `finished_at` is the earliest time it
  # can name. It is read after the backup ended, so it errs late, never early.
  {
    echo "start_wal=$START_WAL"
    echo "finished_at=$FINISHED_AT"
  } >"$DIR/base.meta"
  echo "base backup: $(wc -c <"$DIR/base.tar.gz" | tr -d ' ') bytes, begins in WAL segment $START_WAL, complete at $FINISHED_AT"
else
  echo "base backup: skipped — WAL archiving is off, so this backup restores to its own moment only"
fi

if has_api; then
  echo "bucket: copying"
  mkdir "$DIR/bucket"
  # Inside the API image, on the stack's network (the store is published nowhere),
  # as the invoking user so the files are not root-owned. Its S3 credentials are the
  # service's own; the script is mounted read-only.
  if ! compose run --rm --no-deps -T --user "$(id -u):$(id -g)" \
    -v "$DIR/bucket:/backup" \
    -v "$ROOT/scripts/bucket-copy.ts:/ops/bucket-copy.ts:ro" \
    -v "$ROOT/scripts/bucket-manifest.ts:/ops/bucket-manifest.ts:ro" \
    --entrypoint /usr/local/bin/bun api /ops/bucket-copy.ts export /backup; then
    die "the bucket could not be copied. On a stack whose object store was never prepared ('Layout not ready'), run 'docker compose … up -d', whose storage-init service prepares it (D-144), or scripts/production-init.sh on a stack from before that service"
  fi
else
  echo "bucket: skipped — this stack has no API container to run the copy in"
fi

# The copy ran in a container with its own umask: close the files it wrote as well.
chmod -R u+rwX,go-rwx "$DIR"
write_checksums "$DIR"
echo "checksums: $(wc -l <"$DIR/SHA256SUMS" | tr -d ' ') files"
FINISHED=1
echo "$DIR"
