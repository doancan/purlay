#!/usr/bin/env bash
# Is there a recent backup? Exits non-zero when there is not (#118, D-202). Run it from cron, after the
# backup's own line, and let whatever watches cron (mail, a check-in service) say so: a backup job
# that stops running says nothing by itself, which is how one went unnoticed for a night (docs/CONFIG.md).
#
#   scripts/check-backup.sh [--max-age-hours N] [--wal] <backups-dir>
#
# The newest purlay-<time> directory that holds a database.dump and a SHA256SUMS is judged by the
# time in its NAME, not its modification time (a copy, a rsync or a restore of the directory changes
# that), and its files are read back against SHA256SUMS: a backup that is the right age and cannot be
# restored is not a backup. Default limit: 26 hours — a nightly backup plus the two hours a slow night
# may take. A name in the future, or not a real date, is a failure, never the newest.
#
# --wal says "I rely on point-in-time recovery" and asks the database about it: archiving must be ON
# (a stack recreated without its env file runs with it off and nothing else would say so), the newest
# backup must hold a base backup named in its sums, the archiver must not be failing right now, and no
# segment may have waited more than 15 minutes to be archived (a hung archive_command fails nothing
# and succeeds at nothing, and pg_wal fills the data disk). Without --wal archiving is not looked at.
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
  # A real calendar date and clock time: `epoch_of` would turn month 99 into some day, silently.
  stamp="${name#purlay-}"
  month=$((10#${stamp:4:2})); day=$((10#${stamp:6:2})); hour=$((10#${stamp:9:2})); minute=$((10#${stamp:11:2})); second=$((10#${stamp:13:2}))
  { [ "$month" -ge 1 ] && [ "$month" -le 12 ] && [ "$day" -ge 1 ] && [ "$day" -le 31 ] && [ "$hour" -le 23 ] && [ "$minute" -le 59 ] && [ "$second" -le 60 ]; } || continue
  [ -s "$candidate/database.dump" ] && [ -s "$candidate/SHA256SUMS" ] || continue
  if [ -z "$newest" ] || [[ "$name" > "$newest" ]]; then newest="$name"; fi
done
[ -n "$newest" ] || die "BACKUP MISSING: no complete backup (database.dump and SHA256SUMS) in $DIR"

age=$(($(date -u +%s) - $(epoch_of "${newest#purlay-}")))
# Five minutes of clock skew between this host and whatever made the name; more is a name nobody made.
[ "$age" -ge -300 ] || die "BACKUP NAME IN THE FUTURE: $newest is dated after now. A wrong clock, or a directory that is not a backup of this host; it is not trusted, and neither is the check until it is gone"
hours=$((age / 3600))
[ "$age" -le $((MAX_HOURS * 3600)) ] || die "BACKUP STALE: the newest backup in $DIR is $newest, $hours hours old; the limit is $MAX_HOURS. Is the cron line running, and what does its log say?"
(cd "$DIR/$newest" && sha256_check -c SHA256SUMS >/dev/null 2>&1) || die "BACKUP DAMAGED: $newest does not match its SHA256SUMS (a file is missing, changed or truncated)"
echo "backup ok: $newest, $hours hours old (limit $MAX_HOURS), checksums match"

if [ "$WAL" = 1 ]; then
  archiving="$(in_postgres psql -U "$DB_USER" -d postgres -Atc 'show archive_mode')" || die "could not ask the database about archiving"
  case "$archiving" in on | always) ;; *) die "WAL ARCHIVING IS OFF but --wal says it is relied on: WAL_ARCHIVE is not on in the running database (the env file lost it? the stack recreated without it?). No base backup is being made and no segment kept" ;; esac
  [ -s "$DIR/$newest/base.tar.gz" ] && [ -s "$DIR/$newest/base.meta" ] \
    || die "WAL archiving is on but the newest backup, $newest, has no base backup: point-in-time recovery cannot start from it"
  grep -F -e './base.tar.gz' -e './base.meta' "$DIR/$newest/SHA256SUMS" >/dev/null \
    || die "the newest backup's base backup is not in its SHA256SUMS"
  failing="$(in_postgres psql -U "$DB_USER" -d postgres -Atc "select coalesce(last_failed_time is not null and (last_archived_time is null or last_failed_time > last_archived_time), false) from pg_stat_archiver")" \
    || die "could not read pg_stat_archiver"
  [ "$failing" = f ] || die "WAL ARCHIVING IS FAILING: the last attempt failed and none has succeeded since (select * from pg_stat_archiver). pg_wal is filling the database's disk; fix the archive, or set WAL_ARCHIVE=off to stop it"
  waiting="$(in_postgres psql -U "$DB_USER" -d postgres -Atc "select count(*) from pg_ls_archive_statusdir() where name like '%.ready' and modification < now() - interval '15 minutes'")" \
    || die "could not read the archive status directory"
  [ "$waiting" = 0 ] || die "WAL ARCHIVING IS STALLED: $waiting segments have waited more than 15 minutes to be archived (a hung mount? a full disk?). pg_wal is filling the database's disk"
  echo "wal ok: archiving is on, the newest backup has a base backup, the archiver is not failing and nothing waits"
fi
