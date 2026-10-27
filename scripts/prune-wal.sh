#!/usr/bin/env bash
# Forget the WAL no kept base backup can use, so the archive does not grow without bound (#118, D-202).
#
#   scripts/prune-wal.sh [--dry-run] <backups-dir>...
#
# A base backup restores to any moment from the end of the backup to the end of the archive, and needs
# every WAL segment from the one it began in. So the rule is: keep every segment from the OLDEST base
# backup still on disk, delete everything before it. Run it after the backups' own retention (the
# cron line in docs/CONFIG.md does), so the archive shrinks exactly as far as the backups did.
#
# It refuses to delete anything when it finds no base backup: with none the archive is useless, but
# that is for a person to say, not for a missing directory (a mistyped path, an unmounted disk) to
# decide. It reads each base.meta, never the file names, and a segment name it cannot read stops it.
#
# Environment: COMPOSE_FILE, ENV_FILE (see ops-common.sh).
set -euo pipefail
# shellcheck source=scripts/ops-common.sh
. "$(dirname "$0")/ops-common.sh"

USAGE="usage: prune-wal.sh [--dry-run] <backups-dir>..."
DRY=()
if [ "${1:-}" = "--dry-run" ]; then DRY=(-n); shift; fi
[ $# -gt 0 ] || die "$USAGE"

oldest=""
found=0
for dir in "$@"; do
  [ -d "$dir" ] || die "$dir is not a directory; nothing was pruned"
  for meta in "$dir"/purlay-*/base.meta; do
    [ -f "$meta" ] || continue
    start="$(sed -n 's/^start_wal=//p' "$meta")"
    [[ "$start" =~ ^[0-9A-F]{24}$ ]] || die "$meta does not name a WAL segment; nothing was pruned"
    found=$((found + 1))
    if [ -z "$oldest" ] || [[ "$start" < "$oldest" ]]; then oldest="$start"; fi
  done
done
[ "$found" -gt 0 ] || die "no base backup under $*: nothing was pruned (the archive is only of use with one)"

echo "keeping every WAL segment from $oldest, the oldest of $found base backups"
in_postgres test -d /wal-archive || die "the database container has no /wal-archive; is WAL_ARCHIVE set?"
# `-x .gz`: the archive stores each segment compressed. Prints what it removes.
in_postgres pg_archivecleanup ${DRY[@]+"${DRY[@]}"} -d -x .gz /wal-archive "$oldest.gz" 2>&1 | sed 's/^pg_archivecleanup: //' || die "pg_archivecleanup failed"
# A copy that was cut short by a crash is hidden and unreadable by a restore; an hour is long past any run.
if [ ${#DRY[@]} -eq 0 ]; then
  in_postgres find /wal-archive -maxdepth 1 -name '.*.partial' -mmin +60 -delete
fi
