#!/usr/bin/env bash
# Shared by backup.sh, restore.sh, restore-pitr.sh, prune-wal.sh, check-backup.sh and
# compare-databases.sh. Sourced, not run.
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
# the server's and nothing needs installing on the host. PURLAY_POSTGRES_CONTAINER names a plain
# container instead (the instance scripts/restore-pitr.sh recovers into, D-202), so the
# comparison tooling can judge a database that is not the stack's.
in_postgres() {
  if [ -n "${PURLAY_POSTGRES_CONTAINER:-}" ]; then
    docker exec -i "$PURLAY_POSTGRES_CONTAINER" "$@"
  else
    compose exec -T postgres "$@"
  fi
}

# One file, SHA256SUMS, over every other file of a backup directory.
write_checksums() { # <directory>
  (cd "$1" && find . -type f ! -name SHA256SUMS | sort | while IFS= read -r file; do sha256_check "$file"; done >SHA256SUMS)
  chmod 600 "$1/SHA256SUMS"
}

# Where the stack's WAL archive is, as `docker run -v` wants it: the host path named by
# WAL_ARCHIVE_PATH in the env file, or the named volume the stack made (D-202).
wal_archive_source() {
  local path project volume
  path="$(sed -n 's/^WAL_ARCHIVE_PATH=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)"
  if [ -n "$path" ]; then
    echo "$path"
    return 0
  fi
  project="${COMPOSE_PROJECT_NAME:-$(sed -n 's/^name: *//p' "$COMPOSE_FILE" | head -n 1)}"
  volume="${project}_wal-archive"
  docker volume inspect "$volume" >/dev/null 2>&1 || return 1
  echo "$volume"
}

has_api() { compose config --services | grep -x api >/dev/null; }

# A checksum tool that exists on both macOS and Linux.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_check() { sha256sum "$@"; }
else
  sha256_check() { shasum -a 256 "$@"; }
fi

die() { echo "$*" >&2; exit 1; }

# Operational evidence only: no archive path, recipient, credentials or content. The API mounts this
# directory read-only. Empty means the operator has not connected reporting (D-277).
write_backup_evidence() ( # <dump> <scope: database|database-and-attachments>
  [ -n "${BACKUP_STATUS_DIRECTORY:-}" ] || exit 0
  local ttl digest bytes receipt_tmp
  ttl="${BACKUP_REPORT_MAX_AGE_SECONDS:-172800}"
  case "$ttl" in '' | *[!0-9]*) die "BACKUP_REPORT_MAX_AGE_SECONDS must be a whole number" ;; esac
  [ "${#ttl}" -le 8 ] && [ "$ttl" -ge 60 ] && [ "$ttl" -le 31536000 ] || die "backup report maximum age must be between 60 and 31536000 seconds"
  case "$2" in database | database-and-attachments) ;; *) die "unknown backup report scope" ;; esac
  digest="$(sha256_check "$1" | cut -c 1-64)"
  bytes="$(wc -c <"$1" | tr -d ' ')"
  mkdir -p -m 755 "$BACKUP_STATUS_DIRECTORY"
  receipt_tmp="$BACKUP_STATUS_DIRECTORY/.backup.$$.tmp"
  trap 'rm -f "$receipt_tmp"' EXIT
  printf '{"version":1,"source":"backup-script","completedAt":"%s","scope":"%s","databaseSha256":"%s","databaseBytes":"%s","maxAgeSeconds":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$digest" "$bytes" "$ttl" >"$receipt_tmp"
  chmod 644 "$receipt_tmp"
  mv "$receipt_tmp" "$BACKUP_STATUS_DIRECTORY/backup.json"
)

write_restore_evidence() ( # <dump> <scope: database|database-and-attachments>
  [ -n "${BACKUP_STATUS_DIRECTORY:-}" ] || exit 0
  local digest receipt_tmp
  case "$2" in database | database-and-attachments) ;; *) die "unknown restore report scope" ;; esac
  digest="$(sha256_check "$1" | cut -c 1-64)"
  mkdir -p -m 755 "$BACKUP_STATUS_DIRECTORY"
  receipt_tmp="$BACKUP_STATUS_DIRECTORY/.restore.$$.tmp"
  trap 'rm -f "$receipt_tmp"' EXIT
  printf '{"version":1,"source":"restore-script","checkedAt":"%s","scope":"%s","databaseSha256":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$digest" >"$receipt_tmp"
  chmod 644 "$receipt_tmp"
  mv "$receipt_tmp" "$BACKUP_STATUS_DIRECTORY/restore.json"
)
