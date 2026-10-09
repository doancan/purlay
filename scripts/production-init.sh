#!/usr/bin/env bash
# Prepare the production object store once: one node in the layout, the
# attachment bucket, and the application's key. Safe to run again — every step
# checks first. The production counterpart of scripts/storage-init.sh, which is
# for development and has its credentials written into it.
#
#   scripts/production-init.sh                 # reads ./production.env
#   ENV_FILE=/etc/purlay/production.env scripts/production-init.sh
#
# The key is the deployment's own: S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY from
# the environment file, in the format Garage requires — "GK" and 24 hex digits,
# and 64 hex digits (docs/CONFIG.md says how to generate them). Nothing is
# created that the file does not name, and nothing is printed that is secret.
set -euo pipefail

ENV_FILE="${ENV_FILE:-production.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found (set ENV_FILE)" >&2; exit 1; }

# The variables, read the way compose reads them rather than sourced as shell:
# a value may contain characters a shell would interpret.
value() { # <name> -> the value in the env file, last one wins
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}
BUCKET="$(value S3_BUCKET)"; BUCKET="${BUCKET:-purlay-attachments}"
ACCESS_KEY="$(value S3_ACCESS_KEY_ID)"
SECRET_KEY="$(value S3_SECRET_ACCESS_KEY)"
[[ "$ACCESS_KEY" =~ ^GK[0-9a-f]{24}$ ]] || { echo "S3_ACCESS_KEY_ID must be GK followed by 24 hex digits" >&2; exit 1; }
[[ "$SECRET_KEY" =~ ^[0-9a-f]{64}$ ]] || { echo "S3_SECRET_ACCESS_KEY must be 64 hex digits" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
garage() { compose exec -T -e RUST_LOG=warn garage /garage "$@"; }

# A node with no role cannot store anything; give it one the first time only.
if garage status | grep -q 'NO ROLE ASSIGNED'; then
  node="$(garage node id -q | cut -d@ -f1)"
  garage layout assign -z local -c 1G "$node" >/dev/null
  garage layout apply --version 1 >/dev/null
  echo "layout: node assigned"
fi

if ! garage bucket info "$BUCKET" >/dev/null 2>&1; then
  garage bucket create "$BUCKET" >/dev/null
  echo "bucket: $BUCKET created"
fi

if ! garage key info "$ACCESS_KEY" >/dev/null 2>&1; then
  garage key import --yes -n purlay "$ACCESS_KEY" "$SECRET_KEY" >/dev/null
  echo "key: imported"
fi
garage bucket allow --read --write --owner "$BUCKET" --key "$ACCESS_KEY" >/dev/null

# The store is not published to the host, so look at it from inside the network,
# through the API image's own runtime (a one-off container, so this works before the
# API has ever started — a rebuild after a loss initialises storage first): an
# anonymous read must be refused with 403, not answered and not unreachable
# (CONTRIBUTING §6.4).
status="$(compose run --rm --no-deps -T --entrypoint /usr/local/bin/bun api -e \
  "fetch('http://garage:3900/$BUCKET/probe').then((r) => console.log(r.status), () => console.log('unreachable'))")"
if [ "$status" != "403" ]; then
  echo "an anonymous read of $BUCKET answered $status, not 403" >&2
  exit 1
fi
echo "storage ready: $BUCKET exists and refuses an anonymous read"
