#!/usr/bin/env bash
# Give a release's image its version and `release` (D-262). Run by the `release-image` workflow after a
# tested release publication, and by hand for a release already out:
#
#   IMAGE=ghcr.io/owner/name-api GH_TOKEN=... scripts/release-image-tag.sh            # the checked-out commit
#   IMAGE=ghcr.io/owner/name-api GH_TOKEN=... scripts/release-image-tag.sh v1.2.3     # a release by its tag
#
# Nothing is built: the commit's tested image (`:sha-<commit>`, which `image` gives it) is given two more
# names. `release` is the newest release, and only ever moves to it: a tag that is not the latest release is
# refused, so a run by hand for an old one, or two runs out of order, never move it back. A commit that is
# not a release is not an error — most merges are not — and changes nothing.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -n "${IMAGE:-}" ] || fail "IMAGE is unset: the repository's image, ghcr.io/<owner>/<name>-api"
[ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is unset: it is what asks GitHub which release is the latest"

TAG="${1:-}"
if [ -z "$TAG" ]; then
  VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -n 1)"
  TAG="v$VERSION"
  COMMIT="$(git rev-parse HEAD)"
  # The version's tag at this very commit, or this commit is no release.
  AT="$(git rev-list -n 1 "refs/tags/$TAG" 2>/dev/null || true)"
  if [ "$AT" != "$COMMIT" ]; then
    echo "$COMMIT is not the release $TAG; nothing to tag"
    exit 0
  fi
else
  [[ "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail "give a release tag like v1.2.3, not '$TAG'"
  COMMIT="$(git rev-list -n 1 "refs/tags/$TAG" 2>/dev/null)" || fail "there is no tag $TAG here (fetch the tags first)"
fi

# Which release is the latest is GitHub's answer; one that could not be asked is not taken to mean this one.
LATEST="$(gh release view --json tagName --jq .tagName)" || fail "cannot tell which release is the latest"
[ "$TAG" = "$LATEST" ] || fail "$TAG is not the latest release ($LATEST): \`release\` only moves forward"

docker buildx imagetools create --tag "$IMAGE:$TAG" --tag "$IMAGE:release" "$IMAGE:sha-$COMMIT" \
  || fail "could not tag $IMAGE:sha-$COMMIT; was its image published?"
echo "tagged $IMAGE:sha-$COMMIT as $TAG and release"
