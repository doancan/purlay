#!/usr/bin/env bash
# Are two databases the same? Row counts and a checksum of every row, per table, and
# the number of indexes and constraints (#248, D-95).
#
#   scripts/compare-databases.sh purlay purlay_restore
#
# The checksum is the MD5 of every row rendered as text, in a fixed order — it sees
# a changed value that the count alone cannot. Exits 1 on any difference, naming
# the table. A restore is judged by this, not by pg_restore having exited 0.
set -euo pipefail
# shellcheck source=scripts/ops-common.sh
. "$(dirname "$0")/ops-common.sh"

A="${1:?usage: compare-databases.sh <database> <database>}"
B="${2:?usage: compare-databases.sh <database> <database>}"

# One line per table: name|count|checksum. Built from the catalogue of database A,
# and run unchanged against both, so a table missing from B shows as a failure.
tables="$(in_postgres psql -U "$DB_USER" -d "$A" -Atc "select tablename from pg_tables where schemaname = 'public' order by 1")"
[ -n "$tables" ] || die "$A has no tables; there is nothing to compare"

summary() { # <database>
  local db="$1" table
  for table in $tables; do
    in_postgres psql -U "$DB_USER" -d "$db" -Atc \
      "select '$table', count(*), md5(coalesce(string_agg(t::text, E'\n' order by t::text), '')) from \"$table\" t" \
      2>&1 || echo "$table|MISSING|MISSING"
  done
  in_postgres psql -U "$DB_USER" -d "$db" -Atc \
    "select 'indexes', count(*), '' from pg_indexes where schemaname = 'public'
     union all select 'constraints', count(*), '' from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'"
}

left="$(summary "$A")"
right="$(summary "$B")"

printf '%-26s %12s  %-32s  %s\n' table rows checksum "$A = $B"
status=0
while IFS='|' read -r name count sum; do
  other="$(printf '%s\n' "$right" | grep "^$name|" || true)"
  if [ "$other" = "$name|$count|$sum" ]; then verdict="match"; else verdict="DIFFERENT ($other)"; status=1; fi
  printf '%-26s %12s  %-32s  %s\n' "$name" "$count" "$sum" "$verdict"
done <<<"$left"
[ "$status" = 0 ] && echo "identical" || { echo "the databases differ" >&2; exit 1; }
