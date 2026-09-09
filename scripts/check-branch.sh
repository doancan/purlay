#!/usr/bin/env bash
# The branch prefixes CONTRIBUTING.md §8 names, checked rather than remembered.
#
# It was a rule with nothing watching it, and it had already been broken twice
# before this existed — which is what CONTRIBUTING.md §6.2 says happens to every
# rule in that state.
#
# The prefixes are the Conventional Commit types the same section requires of the
# commit message, so a branch and its commits use one vocabulary rather than two.
set -euo pipefail

# CI passes the pull request's head ref; locally it is whatever is checked out.
#
# The pipeline checks out a merge ref in detached HEAD, so without BRANCH the
# fallback below reads "HEAD" and this check passes without judging anything —
# a green step meaning nothing. In CI that is an error rather than a default.
if [ -n "${CI:-}" ] && [ -z "${BRANCH:-}" ]; then
  echo "BRANCH is empty: the workflow must pass the pull request's head ref," >&2
  echo "otherwise this step reports success without checking a branch name." >&2
  exit 1
fi

branch="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

# Says what it judged. A check whose success looks identical to its absence is
# not evidence of anything. (CONTRIBUTING.md §6.4)
case "$branch" in
  main | HEAD)
    echo "'${branch}' is not a topic branch — no prefix to check"
    exit 0
    ;;
  feat/* | fix/* | chore/* | refactor/* | docs/*)
    echo "branch '${branch}' is named correctly"
    exit 0
    ;;
  *)
    echo "branch '${branch}' does not start with one of:" >&2
    echo "  feat/  fix/  chore/  refactor/  docs/    (CONTRIBUTING.md §8)" >&2
    exit 1
    ;;
esac
