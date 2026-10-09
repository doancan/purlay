#!/usr/bin/env bash
# Does a pull request touch any path that matters to a workflow? (#231)
#
#   gh api --paginate repos/OWNER/REPO/pulls/N/files --jq '.[].filename' | scripts/pr-touches.sh 'REGEX'
#
# Reads file names on standard input, one per line, and prints `relevant=true` or
# `relevant=false` — written to be appended to $GITHUB_OUTPUT.
#
# Why this exists: the `image` and `restore-rehearsal` workflows used `on.pull_request.paths`,
# and a workflow that a path filter skips reports no check at all, so it cannot be a
# required check and a pull request that breaks the Dockerfile could merge red. Without the
# filter they run on every pull request, and this decides — inside the job — whether
# there is anything to do. A job whose steps are skipped still reports success.
#
# An empty list is not "nothing relevant": it is a pull request this could not read, and it
# fails closed (`true`), because skipping the check on the strength of a listing that came
# back empty is exactly the quiet failure the check exists to prevent.
set -euo pipefail

PATTERN="${1:?usage: pr-touches.sh <extended regex matched against each changed path>}"
files="$(cat)"

if [ -z "$files" ]; then
  echo "relevant=true"
  exit 0
fi
if printf '%s\n' "$files" | grep -Eq -- "$PATTERN"; then
  echo "relevant=true"
else
  echo "relevant=false"
fi
