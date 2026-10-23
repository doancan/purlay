#!/usr/bin/env bash
# The committed database types must be exactly what the migrations produce.
#
# They are generated and committed so that typechecking never needs a running
# database (D-45) — which means the committed copy can, in principle, fall
# behind. This makes that impossible rather than merely detectable: it applies
# every migration to a real database, regenerates, and fails on any difference
# against what is committed.
#
# Requires a database. `bun run verify` is deliberately the subset that does not.
set -euo pipefail

# The development credentials live in docker-compose.yml. Defaulting to them
# here rather than repeating the string in the workflow keeps one place to
# change, and `environment.test.ts` fails if this default stops matching them.
DEV_DATABASE_URL="postgres://purlay:purlay@localhost:${POSTGRES_PORT:-5432}/purlay"

# This migrates the database it is given. The one a developer works in must never be it (a check
# once moved the shared database past the checked-out branch), so:
#   - no DATABASE_URL: a clone of the test template is made on the development server, used, and
#     dropped on every way out, interrupt included;
#   - a DATABASE_URL naming a clone (`<name>_` and twelve hex digits) is used as it is;
#   - any other name is refused, unless PURLAY_ALLOW_DB_CHECK_ON names exactly that database (the
#     pipeline's own, which exists for nothing else).
THROWAWAY="apps/api/src/cli/throwaway-database.ts"
CLONE_NAME='_[0-9a-f]{12}$'

database_of() {
  local name="${1##*/}"
  echo "${name%%\?*}"
}

if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="$DEV_DATABASE_URL"
  made="$(DATABASE_URL="$DEV_DATABASE_URL" bun --no-env-file "$THROWAWAY" clone | tail -n 1)"
  clone_name="$(database_of "$made")"
  drop_clone() {
    local status=$?
    trap - EXIT
    DATABASE_URL="$DEV_DATABASE_URL" bun --no-env-file "$THROWAWAY" drop "$clone_name" || echo "could not drop $clone_name" >&2
    exit "$status"
  }
  trap drop_clone EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  export DATABASE_URL="$made"
else
  name="$(database_of "$DATABASE_URL")"
  if ! [[ "$name" =~ $CLONE_NAME ]] && [ "${PURLAY_ALLOW_DB_CHECK_ON:-}" != "$name" ]; then
    echo "db:check migrates the database it is given, and \"$name\" is not a throwaway one." >&2
    echo "Run it with no DATABASE_URL (it makes and drops a clone), or name a clone, or set" >&2
    echo "PURLAY_ALLOW_DB_CHECK_ON=$name if this database exists for nothing else." >&2
    exit 2
  fi
fi

bun run db:migrate
bun run db:generate

if ! git diff --quiet -- packages/db/src/schema.ts; then
  echo
  echo "The committed database types are not what the migrations produce."
  echo
  git --no-pager diff --stat -- packages/db/src/schema.ts
  echo
  echo "Fix it by committing the regenerated file:"
  echo
  echo "    git add packages/db/src/schema.ts"
  echo
  echo "Do not edit that file by hand — it is generated. (D-45)"
  exit 1
fi

echo "database types match the migrations"
