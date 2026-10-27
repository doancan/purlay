#!/bin/sh
# PostgreSQL's archive_command: keep one WAL file in $WAL_ARCHIVE_DIR, /wal-archive (D-202).
#
#   purlay-wal-archive.sh <path of the segment> <its name>      # %p %f
#
# - Atomic: the copy is compressed to a hidden temporary file in the archive, checked readable, and
#   given its name by a hard link, which either makes the name or fails. A reader (a restore, a
#   mirror) never sees half a segment, and a crash leaves only a hidden `.partial`, which
#   scripts/prune-wal.sh removes.
# - Never overwrites: if the name is already archived, an identical segment is success (PostgreSQL
#   retries after a crash) and a different one is a failure, loud, because two clusters writing one
#   archive is how a recovery is lost.
# - Fails loudly: a full disk or a missing directory is a non-zero exit, which PostgreSQL retries and
#   shows in pg_stat_archiver; it never reports a segment kept that was not, because PostgreSQL would
#   then recycle that segment.
#
# POSIX sh and busybox tools: the image is Alpine. The directory is a variable only so that a test can
# run the script without a container; the stack never sets it.
set -eu

source_file="${1:?the path of the segment}"
name="${2:?the name of the segment}"
archive="${WAL_ARCHIVE_DIR:-/wal-archive}"

case "$name" in
  '' | */* | .*) echo "refusing the file name '$name'" >&2; exit 1 ;;
esac
[ -f "$source_file" ] || { echo "$source_file is not a file" >&2; exit 1; }
{ [ -d "$archive" ] && [ -w "$archive" ]; } || { echo "$archive is missing or not writable" >&2; exit 1; }

target="$archive/$name.gz"
if [ -e "$target" ]; then
  if gzip -dc "$target" | cmp -s - "$source_file"; then exit 0; fi
  echo "refusing to overwrite $target: a different file is archived under that name" >&2
  exit 1
fi

partial="$archive/.$name.$$.partial"
trap 'rm -f "$partial"' EXIT
gzip -c "$source_file" >"$partial"
gzip -t "$partial"
# Atomic, and fails if the name appeared in the meantime.
ln "$partial" "$target"
# The directory entry is on disk before PostgreSQL is told it may recycle the segment.
sync
