#!/usr/bin/env bash
# Back up the database and the attachment bucket into one directory (#248, D-95).
#
#   scripts/backup.sh [destination]        # default ./backups -> backups/purlay-<UTC time>/
#
# - database.dump   `pg_dump --format=custom`, taken inside the database container so its
#                   version is the server's; consistent without stopping anything (one snapshot)
# - database.toc    the dump's table of contents, which proves the archive reads back
# - bucket/         every object and a manifest of sizes and SHA-256s (scripts/bucket-copy.ts)
# - SHA256SUMS      over all of it, checked again before a restore uses it
#
# A backup nobody has restored is a hope: run scripts/restore.sh into a throwaway
# database and scripts/compare-databases.sh on a schedule (D-44). The rehearsal that
# did so, and what it found, is docs/spikes/backup-restore.md.
#
# Environment: COMPOSE_FILE, ENV_FILE (see ops-common.sh).
set -euo pipefail
# shellcheck source=scripts/ops-common.sh
. "$(dirname "$0")/ops-common.sh"

DEST="${1:-backups}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="$DEST/purlay-$STAMP"
mkdir "$DIR"

echo "database: dumping $LIVE_DB"
in_postgres pg_dump -U "$DB_USER" -d "$LIVE_DB" --format=custom --no-owner --no-acl >"$DIR/database.dump"
[ -s "$DIR/database.dump" ] || die "the dump is empty"
# Reading the archive back is the cheapest proof it is one; a truncated pipe is not.
in_postgres pg_restore --list <"$DIR/database.dump" >"$DIR/database.toc"
[ -s "$DIR/database.toc" ] || die "the dump has no table of contents; it is not a usable archive"
echo "database: $(wc -c <"$DIR/database.dump" | tr -d ' ') bytes, $(grep -c 'TABLE DATA' "$DIR/database.toc" || true) tables with data"

if has_api; then
  echo "bucket: copying"
  mkdir "$DIR/bucket"
  # Inside the API image, on the stack's network (the store is published nowhere),
  # as the invoking user so the files are not root-owned. Its S3 credentials are the
  # service's own; the script is mounted read-only.
  compose run --rm --no-deps -T --user "$(id -u):$(id -g)" \
    -v "$DIR/bucket:/backup" \
    -v "$ROOT/scripts/bucket-copy.ts:/ops/bucket-copy.ts:ro" \
    -v "$ROOT/scripts/bucket-manifest.ts:/ops/bucket-manifest.ts:ro" \
    --entrypoint /usr/local/bin/bun api /ops/bucket-copy.ts export /backup
else
  echo "bucket: skipped — this stack has no API container to run the copy in"
fi

(cd "$DIR" && find . -type f ! -name SHA256SUMS | sort | while IFS= read -r file; do sha256_check "$file"; done >SHA256SUMS)
echo "checksums: $(wc -l <"$DIR/SHA256SUMS" | tr -d ' ') files"
echo "$DIR"
