#!/usr/bin/env bash
# Tag and publish the release a merge to main made (D-185). Run by the `deploy` workflow after
# the deploy has succeeded, so a release is only ever announced for a commit that is running:
#
#   GH_TOKEN=... GITHUB_REPOSITORY=owner/name scripts/release-publish.sh <full commit hash>
#
# A release is the root `package.json`'s version having no tag yet. `bun run release` (scripts/release.ts)
# opens the pull request that sets it and writes docs/changelog/v<version>.md; merging that pull
# request is what makes this script publish. Every other merge finds the tag already there, or
# the version still 0.0.0, and does nothing — version numbers mark moments, not merges.
#
# The GitHub Release's body is the release's notes (without their title) under a link to the file at the
# tag. A body is limited to 125,000 characters; notes that would not fit are replaced by the link alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }

CHECKED_OUT="$(git rev-parse HEAD)"
SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "give a full 40-digit commit hash, not '$SHA'"
[ "$SHA" = "$CHECKED_OUT" ] || fail "$SHA is not the commit checked out ($CHECKED_OUT)"
[ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is unset: it is what lets this publish a release"
[ -n "${GITHUB_REPOSITORY:-}" ] || fail "GITHUB_REPOSITORY is unset (owner/name)"

VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -n 1)"
[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "package.json has no plain x.y.z version, found '$VERSION'"
if [ "$VERSION" = "0.0.0" ]; then
  echo "the version is 0.0.0: nothing has been released yet, so there is no release to publish"
  exit 0
fi
TAG="v$VERSION"

# Not found is the one answer that means "release it"; anything else is a GitHub that could not
# be asked, which must not be read as "no".
if VIEW="$(gh release view "$TAG" 2>&1)"; then
  echo "$TAG is already released; nothing to publish"
  exit 0
elif ! grep -qi 'release not found' <<<"$VIEW"; then
  fail "cannot tell whether $TAG is released: $VIEW"
fi

NOTES="docs/changelog/$TAG.md"
[ -f "$NOTES" ] || fail "$NOTES does not exist: 'bun run release' writes it in the pull request that sets the version"

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
LIMIT=120000
LINK="Full notes: https://github.com/$GITHUB_REPOSITORY/blob/$TAG/$NOTES"
{
  echo "$LINK"
  echo
  # The notes without their `# Purlay vX.Y.Z — date` line and the blank one after it: the release has a title.
  sed '1{/^# /d;}' "$NOTES" | sed '1{/^$/d;}'
} > "$BODY"
if [ "$(wc -c < "$BODY")" -gt "$LIMIT" ]; then
  printf '%s\n\nThe notes are too long for a release body; read them at the link.\n' "$LINK" > "$BODY"
fi

gh release create "$TAG" --target "$SHA" --title "Purlay $TAG" --notes-file "$BODY" --latest \
  || fail "GitHub did not create the release $TAG"
echo "published $TAG at $SHA"
