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
branch="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

case "$branch" in
  main | HEAD)
    # Not a topic branch: nothing to name.
    exit 0
    ;;
  feat/* | fix/* | chore/* | refactor/* | docs/*)
    exit 0
    ;;
  *)
    echo "branch '${branch}' does not start with one of:" >&2
    echo "  feat/  fix/  chore/  refactor/  docs/    (CONTRIBUTING.md §8)" >&2
    exit 1
    ;;
esac
