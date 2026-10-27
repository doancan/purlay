#!/usr/bin/env bash
# Are two databases the same? Row counts and a checksum of every row, per table, and
# the number of indexes and constraints (#248, D-95).
#
#   scripts/compare-databases.sh purlay purlay_restore
#   scripts/compare-databases.sh --snapshot purlay > snapshot.txt       # write down what a database holds
#   scripts/compare-databases.sh --against snapshot.txt purlay          # later: is it still exactly that?
#
# The checksum is the MD5 of every row rendered as text, in a fixed order — it sees
# a changed value that the count alone cannot. Exits 1 on any difference, naming
# the table. A restore is judged by this, not by pg_restore having exited 0.
#
# A snapshot is how a point-in-time restore is judged (D-202): the live database has moved on past the
# moment that was recovered, so the recovered one is compared with what the live one held then.
set -euo pipefail
# shellcheck source=scripts/ops-common.sh
. "$(dirname "$0")/ops-common.sh"

USAGE="usage: compare-databases.sh <database> <database> | --snapshot <database> | --against <snapshot-file> <database>"

# One line per table: name|count|checksum, then the indexes and constraints. `$tables` is the list
# to read, and the same list is run unchanged against both sides, so a table missing from one shows
# as a failure.
summary() { # <database>
  local db="$1" table
  for table in $tables; do
    # A table that cannot be read is a MISSING line, never the error's text: that would be taken for
    # a table of its own, and a snapshot would record it as the state to be matched.
    in_postgres psql -U "$DB_USER" -d "$db" -Atc \
      "select '$table', count(*), md5(coalesce(string_agg(t::text, E'\n' order by t::text), '')) from \"$table\" t" \
      2>/dev/null || echo "$table|MISSING|MISSING"
  done
  in_postgres psql -U "$DB_USER" -d "$db" -Atc \
    "select 'indexes', count(*), '' from pg_indexes where schemaname = 'public'
     union all select 'constraints', count(*), '' from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'"
}

catalogue_tables() { # <database>
  local found
  found="$(in_postgres psql -U "$DB_USER" -d "$1" -Atc "select tablename from pg_tables where schemaname = 'public' order by 1")"
  [ -n "$found" ] || die "$1 has no tables; there is nothing to compare"
  echo "$found"
}

case "${1:-}" in
  --snapshot)
    tables="$(catalogue_tables "${2:?$USAGE}")"
    taken="$(summary "$2")"
    # What is written down is what later restores are held to: one that could not be read is no snapshot.
    if printf '%s\n' "$taken" | grep -F 'MISSING' >/dev/null; then
      die "a table of $2 could not be read; there is no snapshot to take ($(printf '%s\n' "$taken" | grep -F 'MISSING' | cut -d'|' -f1 | tr '\n' ' '))"
    fi
    printf '%s\n' "$taken"
    exit 0
    ;;
  --against)
    SNAPSHOT="${2:?$USAGE}"
    [ -s "$SNAPSHOT" ] || die "the snapshot $SNAPSHOT is missing or empty"
    B="${3:?$USAGE}"
    left="$(cat "$SNAPSHOT")"
    tables="$(printf '%s\n' "$left" | cut -d'|' -f1 | grep -v -x -e indexes -e constraints || true)"
    [ -n "$tables" ] || die "the snapshot $SNAPSHOT names no tables"
    A="$SNAPSHOT"
    ;;
  *)
    A="${1:?$USAGE}"
    B="${2:?$USAGE}"
    tables="$(catalogue_tables "$A")"
    left="$(summary "$A")"
    ;;
esac

right="$(summary "$B")"

printf '%-26s %12s  %-32s  %s\n' table rows checksum "$A = $B"
status=0
while IFS='|' read -r name count sum; do
  other="$(printf '%s\n' "$right" | grep "^$name|" || true)"
  if [ "$other" = "$name|$count|$sum" ]; then verdict="match"; else verdict="DIFFERENT ($other)"; status=1; fi
  printf '%-26s %12s  %-32s  %s\n' "$name" "$count" "$sum" "$verdict"
done <<<"$left"
# A table the other side has and the snapshot never listed is a difference too.
present="$(in_postgres psql -U "$DB_USER" -d "$B" -Atc "select tablename from pg_tables where schemaname = 'public'")" \
  || die "could not list the tables of $B"
extra="$(comm -13 <(printf '%s\n' "$left" | cut -d'|' -f1 | sort) <(printf '%s\n' "$present" | sort))"
if [ -n "$extra" ]; then
  echo "tables only in $B: $(echo "$extra" | tr '\n' ' ')" >&2
  status=1
fi
[ "$status" = 0 ] && echo "identical" || { echo "the databases differ" >&2; exit 1; }
