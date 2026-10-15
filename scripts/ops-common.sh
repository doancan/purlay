#!/usr/bin/env bash
# Shared by backup.sh, restore.sh and compare-databases.sh. Sourced, not run.
#
# They work on whichever Compose project the two variables name — the production
# stack by default; the development one with
#   COMPOSE_FILE=docker-compose.yml ENV_FILE=/dev/null scripts/backup.sh
# (which has no API container, so no bucket copy: see has_api).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-production.env}"
DB_USER="${DB_USER:-purlay}"
LIVE_DB="${LIVE_DB:-purlay}"

compose() {
  if [ "$ENV_FILE" = "/dev/null" ]; then
    docker compose -f "$COMPOSE_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  fi
}

# `psql`/`pg_dump`/`pg_restore` inside the database container, so their version is
# the server's and nothing needs installing on the host.
in_postgres() { compose exec -T postgres "$@"; }

has_api() { compose config --services | grep -x api >/dev/null; }

# A checksum tool that exists on both macOS and Linux.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_check() { sha256sum "$@"; }
else
  sha256_check() { shasum -a 256 "$@"; }
fi

die() { echo "$*" >&2; exit 1; }
