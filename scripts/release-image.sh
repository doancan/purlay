#!/usr/bin/env bash
# Publish the image from this machine, while the pipeline cannot (D-92, amended). It is not
# `image.yml`'s equal: no provenance or SBOM is attached, the image is smoke-tested before it
# is pushed rather than as the pushed digest, and no `main` tag moves. What it keeps is the
# point of the workflow — only a merged commit, judged, built once, started before it ships:
#
#   scripts/release-image.sh            # linux/amd64, the image for the server
#   PLATFORM=linux/arm64 scripts/release-image.sh
#
# 1. Only a commit that is on origin/main, from a clean working tree: what is released is
#    what was merged, not what happens to be on disk.
# 2. `bun run verify`, with the database — the gate CI would have run. Without DATABASE_URL
#    it refuses rather than releasing on the unit tests alone.
# 3. One build, for the server's platform (a laptop is often arm64 and a server amd64; an
#    image for the wrong one stops with `exec format error` at the worst moment).
# 4. `scripts/image-smoke.sh` against that image — the one that is pushed next, not a rebuild.
# 5. Push `sha-<commit>`, and print the digest to put in `PURLAY_IMAGE`. No moving tag: the
#    compose file wants a digest (D-86).
#
# It needs `docker login ghcr.io` with a token that may write packages. It never reads one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="${PLATFORM:-linux/amd64}"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }

# ── 1. What is released ──────────────────────────────────────────────────────
[ -z "$(git status --porcelain)" ] || fail "the working tree is not clean; release a merged commit"
# As configured, not as rewritten: `url.<base>.insteadOf` may point fetches elsewhere.
REMOTE="$(git config --get remote.origin.url)"
REPOSITORY="$(sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##' <<<"$REMOTE" | tr '[:upper:]' '[:lower:]')"
[[ "$REPOSITORY" =~ ^[a-z0-9-]+/[a-z0-9._-]+$ ]] || fail "cannot read owner/name from $REMOTE"
IMAGE="ghcr.io/$REPOSITORY-api"
git fetch --quiet origin main
SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$SHA" origin/main || fail "$SHA is not on origin/main; release a merged commit"

TAG="$IMAGE:sha-$SHA"
echo "releasing $SHA as $TAG for $PLATFORM"

# ── 2. The gate ──────────────────────────────────────────────────────────────
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is unset: verify would run the unit tests alone (CONTRIBUTING §2)"
bun run verify

# ── 3. One build, of the commit and nothing beside it ────────────────────────
# The context is the commit's own tree, so a file git ignores — a stale compiled `.js` beside
# its source, a local `.env` — cannot reach the image, whatever the working tree holds. It is
# a directory, not the archive piped in: BuildKit does not apply `.dockerignore` to a context
# read from stdin, and an image built that way carried every test and the demo seeder.
LICENSE="$(bun -e 'console.log(require("./package.json").license)')"
CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/purlay-release.XXXXXX")"
trap 'rm -rf -- "$CONTEXT"' EXIT
git archive --format=tar "$SHA" | tar -x -C "$CONTEXT"
docker buildx build --platform "$PLATFORM" --load \
  --label "org.opencontainers.image.source=https://github.com/$REPOSITORY" \
  --label "org.opencontainers.image.revision=$SHA" \
  --label "org.opencontainers.image.licenses=$LICENSE" \
  --tag "$TAG" "$CONTEXT"

# ── 4. That image, started the way production starts it ─────────────────────
scripts/image-smoke.sh "$TAG"

# ── 5. Published, and named by what it is ────────────────────────────────────
docker push "$TAG"
# What the registry holds for the tag, not what this machine remembers; and it must be the
# image that was smoke-tested. Captures end in `|| true` so the check below says why.
DIGEST="$(docker buildx imagetools inspect "$TAG" --format '{{.Manifest.Digest}}' || true)"
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "the registry reports no digest for $TAG"
docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$TAG" | grep -xF "$IMAGE@$DIGEST" >/dev/null ||
  fail "the registry's $TAG is not the image that was smoke-tested"
echo
echo "PURLAY_IMAGE=$IMAGE@$DIGEST"
