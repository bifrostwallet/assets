#!/bin/sh

# Run the workflow tag-rule check (verify-version-tags.sh)
# only when it can change the answer:
#   - a file under .github/ or the check itself changed, or
#   - the run is for a tag or a GitHub release (always checked), or
#   - the change cannot be worked out, so the check runs to be safe.
# The check reads workflow files only, so any other change skips it. It is
# not part of security-checks.sh, which runs on every ./yarn call.
#
#   verify-version-tags-if-changed.sh            compare HEAD with its parent
#   verify-version-tags-if-changed.sh --staged   compare the index (pre-commit)
#
# CI: the checkout needs fetch-depth: 2. On a pull request HEAD is the merge
# commit, so its first parent is the base branch and the diff is the whole
# pull request. On a push only the last commit is compared; the pull request
# run has compared the rest. Without a parent commit the check runs.

set -eu

YELLOW='\033[1;33m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

# Whether anything under .github/, verify-version-tags.sh or this script
# differs. git is asked with pathspecs, because a listed path is quoted when it has a
# non-ASCII byte, a quote or a backslash, and a quoted line matches no
# pattern. Exit 0: no difference. 1: a difference. Other: git failed.
watched_paths_differ() {
  git diff --quiet "$@" -- \
    .github \
    'scripts/security/verify-version-tags*'
}

MODE='head'
case "${1:-}" in
  --staged) MODE='staged' ;;
  '') ;;
  *)
    echo "Usage: $0 [--staged]" >&2
    exit 2
    ;;
esac

reason=''
if [ "${GITHUB_REF_TYPE:-}" = "tag" ] || [ "${GITHUB_EVENT_NAME:-}" = "release" ]; then
  reason='release'
elif [ "$MODE" = staged ]; then
  status=0
  watched_paths_differ --cached || status=$?
  if [ "$status" -eq 1 ]; then
    reason='workflow or check files are staged'
  elif [ "$status" -ne 0 ]; then
    reason='staged files could not be compared'
  fi
elif ! git rev-parse --verify -q 'HEAD^1' >/dev/null 2>&1; then
  reason='no parent commit to compare with'
else
  status=0
  watched_paths_differ 'HEAD^1' HEAD || status=$?
  if [ "$status" -eq 1 ]; then
    reason='workflow or check files changed'
  elif [ "$status" -ne 0 ]; then
    reason='changed files could not be compared'
  fi
fi

if [ -z "$reason" ]; then
  echo "Workflow tag rules: skipped (no change under .github/ or to the check)."
  exit 0
fi

printf '%b\n' "${YELLOW}Rejecting loose version tags in workflows (${reason})...${NC}"
./scripts/security/verify-version-tags.sh
