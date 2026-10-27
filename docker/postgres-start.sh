#!/bin/sh
# Starts PostgreSQL the way the image does, and adds WAL archiving only when WAL_ARCHIVE=on (D-202).
#
# Off, which is the default, it adds nothing: the server runs with exactly the settings it had before
# this file existed. On, it archives every WAL segment to /wal-archive with purlay-wal-archive.sh and
# forces a segment switch every WAL_ARCHIVE_TIMEOUT seconds of activity (the most a crash can lose).
#
# POSIX sh, not bash: the image is Alpine. Run as root by the image's entrypoint chain, which is what
# lets it hand the archive directory to the postgres user; the server itself is started by the
# image's own docker-entrypoint.sh, which drops to that user.
set -eu

case "${WAL_ARCHIVE:-off}" in
  off) ;;
  on)
    timeout="${WAL_ARCHIVE_TIMEOUT:-60}"
    case "$timeout" in
      '' | *[!0-9]* | 0) echo "WAL_ARCHIVE_TIMEOUT must be a whole number of seconds, 1 or more, not '$timeout'" >&2; exit 1 ;;
    esac
    archive="${WAL_ARCHIVE_DIR:-/wal-archive}"
    [ -d "$archive" ] || { echo "WAL_ARCHIVE=on but $archive is not mounted" >&2; exit 1; }
    # A volume or a directory made by root: the server runs as postgres and must be able to write it.
    # A mount that cannot be chowned (an NFS export with root_squash) may still be writable by the
    # postgres user as it is: say so and go on; if it is not, every archive attempt fails, loudly, and
    # scripts/check-backup.sh --wal says so.
    if ! { chown postgres:postgres "$archive" && chmod 750 "$archive"; }; then
      echo "warning: could not hand $archive to the postgres user; archiving works only if it is already writable by it" >&2
    fi
    set -- "$@" \
      -c archive_mode=on \
      -c 'archive_command=sh /usr/local/bin/purlay-wal-archive.sh "%p" "%f"' \
      -c "archive_timeout=$timeout"
    ;;
  *) echo "WAL_ARCHIVE must be on or off, not '${WAL_ARCHIVE}'" >&2; exit 1 ;;
esac

exec docker-entrypoint.sh "$@"
