#!/usr/bin/env bash
# Wait until a pull request's checks have actually run.
#
# Three earlier attempts got this wrong in three different ways: polling the most
# recent workflow run (which returns the *previous* run before the new one is
# created), and counting pending checks (which is trivially zero before any check
# exists). Both reported success against something that had not started.
#
# The condition has to be positive: the expected checks exist, and every one of
# them has concluded.
set -euo pipefail

pr="${1:?usage: wait-for-checks.sh <pr-number> [expected-count]}"
expected="${2:-2}"
repo="${REPO:-doancan/purlay}"

for _ in $(seq 1 80); do
  json=$(gh pr view "$pr" -R "$repo" --json statusCheckRollup)
  total=$(jq '[.statusCheckRollup[]] | length' <<<"$json")
  done_=$(jq '[.statusCheckRollup[] | select(.conclusion != "" and .conclusion != null)] | length' <<<"$json")
  if [ "$total" -ge "$expected" ] && [ "$total" -eq "$done_" ]; then
    jq -r '.statusCheckRollup[] | "  \(.name)  \(.conclusion)"' <<<"$json"
    jq -e '[.statusCheckRollup[] | select(.conclusion != "SUCCESS")] | length == 0' <<<"$json" >/dev/null
    echo "all checks passed"
    exit 0
  fi
  sleep 10
done
echo "timed out waiting for checks" >&2
exit 1
