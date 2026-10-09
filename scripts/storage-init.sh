#!/usr/bin/env bash
# Prepare the local object store: one node in the layout, the attachment bucket,
# and the development key. Safe to run again — every step checks first.
#
# Garage's image has no shell, so compose cannot do this the way it could for the
# store this replaced. It runs from the host through `docker compose exec`.
# Attachments are stored under opaque keys and never served as public URLs;
# downloads are brokered by the API so membership is actually checked (D-16,
# ARCHITECTURE.md §9). Garage has no public-read setting on its S3 endpoint at
# all; the only way to expose a bucket is its separate website port, which
# compose does not publish. So there is no "make it private" step, and the last
# one checks something narrower: that the published port is an S3 endpoint that
# refuses an unauthenticated read.
set -euo pipefail

BUCKET="purlay-attachments"
KEY_NAME="purlay-dev"
# Development only. Garage requires its own format: "GK" and 24 hex digits, and
# 64 hex digits for the secret. The application reads them as S3_ACCESS_KEY_ID
# and S3_SECRET_ACCESS_KEY (docs/CONFIG.md).
ACCESS_KEY="GK000000000000000000000001"
SECRET_KEY="0000000000000000000000000000000000000000000000000000000000000002"
PORT="${STORAGE_PORT:-9000}"

garage() { docker compose exec -T -e RUST_LOG=warn garage /garage "$@"; }

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

if ! garage key info "$KEY_NAME" >/dev/null 2>&1; then
  garage key import --yes -n "$KEY_NAME" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null
  echo "key: $KEY_NAME imported"
fi
garage bucket allow --read --write --owner "$BUCKET" --key "$KEY_NAME" >/dev/null

# An unauthenticated read must be refused with 403. Anything else — a 200, or no
# answer because the wrong thing is listening on the port — fails the script
# rather than reporting a store nobody has looked at. (CONTRIBUTING §6.4)
status="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/${BUCKET}/probe" || true)"
if [ "$status" != "403" ]; then
  echo "an anonymous read of $BUCKET on port $PORT answered $status, not 403" >&2
  exit 1
fi
echo "storage ready: $BUCKET exists and refuses an anonymous read"
