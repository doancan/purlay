#!/usr/bin/env bash
# Recover the database to a moment in time, into a NEW instance, and hand back a backup-shaped
# directory that scripts/restore.sh can apply (#118, D-202).
#
#   scripts/restore-pitr.sh <backup-dir> --to '2026-10-27 12:00:00+00' [--archive DIR|VOLUME]
#                           [--into DIR] [--expect SNAPSHOT] [--image IMAGE] [--timeout SECONDS]
#   scripts/restore-pitr.sh <backup-dir> --to latest            # everything the archive holds
#
# <backup-dir> is one made by scripts/backup.sh while WAL archiving was on (it holds base.tar.gz).
# --to names the moment, with a time zone (the server's own is UTC and a bare time is a guess); the
# result holds every transaction committed up to it and nothing after.
#
# What it does, in order, and what it never does:
#   1. checks the backup against SHA256SUMS and that the archive holds the segment the base backup
#      began in — before anything is created;
#   2. unpacks the base backup into a NEW Docker volume and starts a NEW PostgreSQL in a container
#      of its own, from the stack's own image, on NO network and with the archive mounted read-only:
#      it cannot reach the live database, and cannot write to the archive;
#   3. lets it replay the archive up to --to and promote itself, and waits (a target before the base
#      backup finished, a segment missing from the archive, or an archive that ends before the target
#      are each a failed recovery, named, never a quiet shorter one);
#   4. compares what it recovered with --expect (a snapshot from scripts/compare-databases.sh
#      --snapshot, taken at that moment) when given, and always writes its own snapshot;
#   5. dumps it into <into>/recovered/ as a backup directory (database.dump, SHA256SUMS), and removes
#      the container and the volume.
# Applying it to the live database is the existing, separately guarded step:
#   scripts/restore.sh <into>/recovered --no-bucket [--database purlay --replace]   (API stopped)
#
# Environment: COMPOSE_FILE, ENV_FILE (see ops-common.sh); the image is the stack's postgres unless
# --image names one (the same major version the base backup was taken on).
set -euo pipefail
# shellcheck source=scripts/ops-common.sh
. "$(dirname "$0")/ops-common.sh"
umask 077

USAGE="usage: restore-pitr.sh <backup-dir> --to '<time with zone>'|latest [--archive DIR|VOLUME] [--into DIR] [--expect SNAPSHOT] [--image IMAGE] [--timeout SECONDS]"
BACKUP="${1:-}"
[ -d "$BACKUP" ] || die "$USAGE"
BACKUP="$(cd "$BACKUP" && pwd)"
shift
TARGET=""
ARCHIVE=""
INTO=""
EXPECT=""
IMAGE=""
TIMEOUT=1800
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TARGET="${2:?--to needs a time}"; shift 2 ;;
    --archive) ARCHIVE="${2:?--archive needs a directory or a volume name}"; shift 2 ;;
    --into) INTO="${2:?--into needs a directory}"; shift 2 ;;
    --expect) EXPECT="${2:?--expect needs a snapshot file}"; shift 2 ;;
    --image) IMAGE="${2:?--image needs an image}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?--timeout needs seconds}"; shift 2 ;;
    -h|--help) echo "$USAGE"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$TARGET" ] || die "--to is required: the moment to recover to, with its time zone, or 'latest'. $USAGE"
if [ "$TARGET" != latest ]; then
  time_with_zone='^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.]+(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
  [[ "$TARGET" =~ $time_with_zone ]] \
    || die "--to '$TARGET' is not a time with a zone, such as '2026-10-27 12:00:00+00'"
fi
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout is a number of seconds"
[ -z "$EXPECT" ] || [ -s "$EXPECT" ] || die "the snapshot $EXPECT is missing or empty"

STARTED="$(date +%s)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
INTO="${INTO:-purlay-pitr-$STAMP}"
[ ! -e "$INTO" ] || die "$INTO already exists; this never writes into a directory it did not make"
NAME="purlay-pitr-$STAMP-$$"
VOLUME="$NAME-data"
STAGED="$NAME-archive"
# Beside the directory, not in it: a failed run removes the directory, and the log is what says why.
LOG="$INTO.recovery.log"
CREATED=0
FINISHED=0
# Removing what this run made is checked, not assumed: a container or a volume left behind holds a
# complete copy of the database in the clear, and silence about it is the worst answer.
cleanup() {
  status=$?
  if [ "$CREATED" = 1 ]; then
    if [ "$FINISHED" != 1 ] && docker inspect "$NAME" >/dev/null 2>&1; then docker logs "$NAME" >"$LOG" 2>&1 || true; fi
    if docker inspect "$NAME" >/dev/null 2>&1 && ! docker rm -f "$NAME" >/dev/null 2>&1; then
      echo "WARNING: could not remove the container $NAME; it holds a copy of the database: docker rm -f $NAME" >&2
    fi
    for volume in "$VOLUME" "$STAGED"; do
      if docker volume inspect "$volume" >/dev/null 2>&1 && ! docker volume rm -f "$volume" >/dev/null 2>&1; then
        echo "WARNING: could not remove the volume $volume; it holds a copy of the database: docker volume rm $volume" >&2
      fi
    done
  fi
  if [ "$FINISHED" != 1 ]; then
    [ "$CREATED" != 1 ] || rm -rf "$INTO"
    echo "point-in-time restore FAILED; the live database was not touched" >&2
    if [ -s "$LOG" ]; then echo "the recovering instance's log is $LOG" >&2; fi
  fi
  exit "$status"
}
trap cleanup EXIT

# --- 1. everything that can be checked before anything is made -------------------
echo "checking the backup against its checksums"
(cd "$BACKUP" && sha256_check -c SHA256SUMS >/dev/null) || die "the backup does not match SHA256SUMS; not restoring"
[ -f "$BACKUP/base.tar.gz" ] && [ -f "$BACKUP/base.meta" ] \
  || die "$BACKUP has no base backup: it was taken while WAL archiving was off, so it restores to its own moment only (scripts/restore.sh). Point-in-time recovery needs a backup made with WAL_ARCHIVE=on"
START_WAL="$(sed -n 's/^start_wal=//p' "$BACKUP/base.meta")"
FINISHED_AT="$(sed -n 's/^finished_at=//p' "$BACKUP/base.meta")"
[[ "$START_WAL" =~ ^[0-9A-F]{24}$ ]] || die "base.meta does not name the WAL segment the base backup began in"
echo "  intact; the base backup begins in $START_WAL and is complete at $FINISHED_AT"

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(wal_archive_source)" || die "no WAL archive found for this stack; name it with --archive (a directory, such as the copy you shipped off the server)"
fi
if [ -d "$ARCHIVE" ]; then ARCHIVE="$(cd "$ARCHIVE" && pwd)"; fi
if [ -z "$IMAGE" ]; then
  IMAGE="$(compose config --images 2>/dev/null | grep '^postgres:' | head -n 1 || true)"
  [ -n "$IMAGE" ] || die "could not read the database image from the stack's files; name it with --image"
fi
# A name that is neither a directory nor a volume would be made by docker as an empty volume and
# then reported as an archive with nothing in it.
if [ ! -d "$ARCHIVE" ] && ! docker volume inspect "$ARCHIVE" >/dev/null 2>&1; then
  die "--archive $ARCHIVE is neither a directory nor a Docker volume"
fi
# The archive is read by a throwaway container as root: the segments belong to the postgres user of
# the server that wrote them and are 0600, and a copy shipped elsewhere belongs to whoever received it.
archive_has() { # <file name>
  docker run --rm --network none --user root -v "$ARCHIVE:/wal-archive:ro" --entrypoint sh "$IMAGE" -c "[ -f /wal-archive/$1 ]"
}
archive_has "$START_WAL.gz" \
  || die "the archive does not hold $START_WAL, the segment the base backup began in (it was pruned, or this is another cluster's archive, or it could not be read). Nothing was changed"
echo "  the archive holds the segment the base backup began in"

# --- 2. a new instance, alone ----------------------------------------------------
mkdir "$INTO"
CREATED=1
docker volume create "$VOLUME" >/dev/null
docker volume create "$STAGED" >/dev/null
# The recovering server is the postgres user and must read every segment; whoever copied the archive
# here may own them at 0600. So it recovers from a COPY the postgres user owns, made as root, with
# every segment read back whole (`gzip -t`) before anything replays it: a segment that cannot be
# decompressed would otherwise read to the server as "not in the archive" and end recovery early.
# It also means the recovery works on a copy no one is writing, and cannot touch the original.
echo "staging a copy of the archive and reading every segment back"
docker run --rm --user root --network none -v "$ARCHIVE:/from:ro" -v "$STAGED:/to" --entrypoint sh "$IMAGE" -c \
  'cp -a /from/. /to/ && cd /to && for f in *.gz; do [ -e "$f" ] || continue; gzip -t "$f" || { echo "the archived segment $f is damaged" >&2; exit 1; }; done && chown -R postgres:postgres /to && chmod 750 /to' \
  || die "the archive could not be copied, or a segment in it is damaged (named above)"
NEWEST="$(docker run --rm --user root --network none -v "$STAGED:/to:ro" --entrypoint sh "$IMAGE" -c "ls /to | grep -E '^[0-9A-F]{24}[.]gz\$' | sort | tail -n 1")"
NEWEST="${NEWEST%.gz}"
echo "unpacking the base backup into a new volume"
docker run --rm --user root --network none -v "$VOLUME:/pgdata" -v "$BACKUP:/backup:ro" --entrypoint sh "$IMAGE" -c \
  'tar -xzf /backup/base.tar.gz -C /pgdata && touch /pgdata/recovery.signal && chown -R postgres:postgres /pgdata && chmod 700 /pgdata'

# Missing is 1 (the end of the archive); present and unreadable is 126, which PostgreSQL treats as a
# failure of the recovery rather than as the end of it. Written whole, then given its name.
recovery=(-c 'restore_command=f=/wal-archive/%f.gz; [ -f "$f" ] || exit 1; gzip -dc "$f" >"%p.tmp" && mv "%p.tmp" "%p" || exit 126')
if [ "$TARGET" != latest ]; then
  recovery+=(-c "recovery_target_time=$TARGET" -c recovery_target_action=promote)
fi
echo "recovering to $TARGET (container $NAME, no network, archive read-only)"
# archive_mode=off is stated, not assumed: nothing here may ever add a segment to the live archive.
docker run -d --name "$NAME" --user postgres --network none --entrypoint postgres \
  -v "$VOLUME:/pgdata" -v "$STAGED:/wal-archive:ro" "$IMAGE" \
  -D /pgdata -c listen_addresses= -c archive_mode=off -c hot_standby=on "${recovery[@]}" >/dev/null

# --- 3. wait for the promotion ---------------------------------------------------
deadline=$(($(date +%s) + TIMEOUT))
CHECKED_TARGET=0
while :; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    docker logs "$NAME" >"$LOG" 2>&1 || true
    tail -n 25 "$LOG" >&2
    if grep -q 'before consistent recovery point\|recovery stop point is before' "$LOG"; then
      die "--to $TARGET is before the base backup was complete ($FINISHED_AT). Name a later time, or restore from an older backup that began earlier"
    elif grep -q 'recovery ended before configured recovery target was reached' "$LOG"; then
      die "the archive ends before $TARGET, or a segment between the base backup and $TARGET is missing from it. Name an earlier time, or --to latest for everything the archive holds"
    fi
    die "the recovering instance stopped; its log is above and in $LOG"
  fi
  state="$(docker exec "$NAME" psql -U "$DB_USER" -d postgres -Atc 'select pg_is_in_recovery()' 2>/dev/null || true)"
  if [ -n "$state" ] && [ "$TARGET" != latest ] && [ "$CHECKED_TARGET" != 1 ]; then
    # PostgreSQL does not refuse a target that falls inside the base backup's own window: it stops at
    # the first commit after it, which is a state nobody named. So the instance, the one thing here
    # that can compare two times with zones, is asked once it answers. Both are validated shapes.
    finished_shape='^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+[+]00$'
    [[ "$FINISHED_AT" =~ $finished_shape ]] || die "base.meta's finished_at is not a time"
    too_early="$(docker exec "$NAME" psql -U "$DB_USER" -d postgres -Atc "select '$TARGET'::timestamptz < '$FINISHED_AT'::timestamptz")"
    [ "$too_early" != t ] || die "--to $TARGET is before the base backup was complete ($FINISHED_AT). Name a later time, or restore from an older backup that began earlier"
    CHECKED_TARGET=1
  fi
  [ "$state" = f ] && break
  [ "$(date +%s)" -lt "$deadline" ] || { docker logs "$NAME" >"$LOG" 2>&1 || true; die "recovery did not finish within ${TIMEOUT}s; its log is $LOG"; }
  sleep 1
done
docker logs "$NAME" >"$LOG" 2>&1 || true
if [ "$TARGET" != latest ]; then
  grep -q 'recovery stopping' "$LOG" \
    || die "the instance promoted without reaching $TARGET (see $LOG); refusing to call that a recovery"
else
  # Without a target PostgreSQL takes the end of what it can read as the end of the archive: a
  # segment missing in the middle would end recovery there, promote, and look like success.
  last_replayed="$(sed -n 's/.*restored log file "\([0-9A-F]\{24\}\)" from archive.*/\1/p' "$LOG" | sort | tail -n 1)"
  [ -n "$NEWEST" ] && [ "$last_replayed" = "$NEWEST" ] \
    || die "--to latest replayed up to ${last_replayed:-nothing} but the archive holds up to ${NEWEST:-nothing}: a segment between them is missing or unreadable (see $LOG). Name a time instead, or restore the missing segment"
fi
echo "promoted: $(docker exec "$NAME" psql -U "$DB_USER" -d postgres -Atc "select 'last transaction replayed at ' || coalesce(pg_last_xact_replay_timestamp()::text, 'none (no commit since the base backup)')")"

# --- 4. the comparison -----------------------------------------------------------
mkdir "$INTO/recovered"
export PURLAY_POSTGRES_CONTAINER="$NAME"
"$(dirname "$0")/compare-databases.sh" --snapshot "$LIVE_DB" >"$INTO/recovered/snapshot.txt"
if [ -n "$EXPECT" ]; then
  echo "comparing with $EXPECT"
  "$(dirname "$0")/compare-databases.sh" --against "$EXPECT" "$LIVE_DB" || die "the recovered database is not what $EXPECT recorded"
fi

# --- 5. a backup-shaped directory, and nothing left running ----------------------
in_postgres pg_dump -U "$DB_USER" -d "$LIVE_DB" --format=custom --no-owner --no-acl >"$INTO/recovered/database.dump"
[ -s "$INTO/recovered/database.dump" ] || die "the dump of the recovered database is empty"
in_postgres pg_restore --list <"$INTO/recovered/database.dump" >"$INTO/recovered/database.toc"
[ -s "$INTO/recovered/database.toc" ] || die "the dump of the recovered database does not read back"
write_checksums "$INTO/recovered"
FINISHED=1
mv -f "$LOG" "$INTO/recovery.log" 2>/dev/null || true
echo "recovered in $(($(date +%s) - STARTED)) s: $INTO/recovered"
echo "to apply it (API stopped): scripts/restore.sh $INTO/recovered --no-bucket --database $LIVE_DB --replace"
