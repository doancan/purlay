#!/usr/bin/env bash
# Is there a recent backup? Exits non-zero when there is not (#118, D-202). Run it from cron, after the
# backup's own line, and let whatever watches cron (mail, a check-in service) say so: a backup job
# that stops running says nothing by itself, which is how one went unnoticed for a night (docs/CONFIG.md).
#
#   scripts/check-backup.sh [--max-age-hours N] [--wal] <backups-dir>
#
# The newest purlay-<time> directory that holds a database.dump and a SHA256SUMS is judged by the
# time in its NAME, not its modification time (a copy, a rsync or a restore of the directory changes
# that). Default limit: 26 hours — a nightly backup plus the two hours a slow night may take.
#
# --wal also asks the database about archiving: when it is on, the newest backup must hold a base
# backup, and the archiver must not be failing right now (its last failure no later than its last
# success). Archiving off is reported, and is not a failure: it is the default.
#
# Environment (for --wal only): COMPOSE_FILE, ENV_FILE (see ops-common.sh).
set -euo pipefail
# shellcheck source=scripts/ops-common.sh
. "$(dirname "$0")/ops-common.sh"

USAGE="usage: check-backup.sh [--max-age-hours N] [--wal] <backups-dir>"
MAX_HOURS=26
WAL=0
DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --max-age-hours) MAX_HOURS="${2:?--max-age-hours needs a number}"; shift 2 ;;
    --wal) WAL=1; shift ;;
    -h|--help) echo "$USAGE"; exit 0 ;;
    -*) die "unknown argument: $1" ;;
    *) [ -z "$DIR" ] || die "$USAGE"; DIR="$1"; shift ;;
  esac
done
[ -n "$DIR" ] || die "$USAGE"
[[ "$MAX_HOURS" =~ ^[0-9]+$ ]] || die "--max-age-hours is a whole number"
[ -d "$DIR" ] || die "BACKUP MISSING: $DIR is not a directory (an unmounted disk? a wrong path in the cron line?)"

# Seconds since the epoch of a stamp like 20261027T010000Z, by arithmetic: `date -d` and `date -j -f`
# are different programs on Linux and macOS.
epoch_of() { # <YYYYMMDDTHHMMSSZ>
  local s="$1" y m d days era yoe doy doe
  y=$((10#${s:0:4})); m=$((10#${s:4:2})); d=$((10#${s:6:2}))
  [ "$m" -gt 2 ] || y=$((y - 1))
  era=$((y / 400)); yoe=$((y - era * 400))
  if [ "$m" -gt 2 ]; then doy=$(((153 * (m - 3) + 2) / 5 + d - 1)); else doy=$(((153 * (m + 9) + 2) / 5 + d - 1)); fi
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  days=$((era * 146097 + doe - 719468))
  echo $((days * 86400 + 10#${s:9:2} * 3600 + 10#${s:11:2} * 60 + 10#${s:13:2}))
}

newest=""
for candidate in "$DIR"/purlay-*; do
  [ -d "$candidate" ] || continue
  name="$(basename "$candidate")"
  [[ "$name" =~ ^purlay-[0-9]{8}T[0-9]{6}Z$ ]] || continue
  [ -s "$candidate/database.dump" ] && [ -s "$candidate/SHA256SUMS" ] || continue
  if [ -z "$newest" ] || [[ "$name" > "$newest" ]]; then newest="$name"; fi
done
[ -n "$newest" ] || die "BACKUP MISSING: no complete backup (database.dump and SHA256SUMS) in $DIR"

age=$(($(date -u +%s) - $(epoch_of "${newest#purlay-}")))
hours=$((age / 3600))
[ "$age" -le $((MAX_HOURS * 3600)) ] || die "BACKUP STALE: the newest backup in $DIR is $newest, $hours hours old; the limit is $MAX_HOURS. Is the cron line running, and what does its log say?"
echo "backup ok: $newest, $hours hours old (limit $MAX_HOURS)"

if [ "$WAL" = 1 ]; then
  archiving="$(in_postgres psql -U "$DB_USER" -d postgres -Atc 'show archive_mode')" || die "could not ask the database about archiving"
  if [ "$archiving" = on ]; then
    [ -s "$DIR/$newest/base.tar.gz" ] || die "WAL archiving is on but the newest backup, $newest, has no base backup: point-in-time recovery cannot start from it"
    failing="$(in_postgres psql -U "$DB_USER" -d postgres -Atc "select last_failed_time is not null and (last_archived_time is null or last_failed_time > last_archived_time) from pg_stat_archiver")" \
      || die "could not read pg_stat_archiver"
    [ "$failing" != t ] || die "WAL ARCHIVING IS FAILING: the last attempt failed and none has succeeded since (select * from pg_stat_archiver). pg_wal is filling the database's disk; fix the archive, or set WAL_ARCHIVE=off to stop it"
    echo "wal ok: archiving is on, the newest backup has a base backup, and the archiver is not failing"
  else
    echo "wal: archiving is off (point-in-time recovery is not in use)"
  fi
fi
