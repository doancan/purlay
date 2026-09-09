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

: "${DATABASE_URL:?DATABASE_URL is not set. Start the environment with: bun run db:up}"

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
