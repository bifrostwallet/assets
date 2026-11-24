#!/bin/sh

# Run the workflow tag-rule check (verify-version-tags.sh and its fixtures)
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

# verify-version-tags.sh, its fixtures script and directory, and this script
# with its own fixtures.
PATHS_RE='^\.github/|^scripts/security/(verify-version-tags|fixtures/version-tags)'

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
  if ! changed=$(git diff --cached --name-only); then
    reason='staged files could not be listed'
  elif printf '%s\n' "$changed" | grep -Eq "$PATHS_RE"; then
    reason='workflow or check files are staged'
  fi
elif ! git rev-parse --verify -q 'HEAD^1' >/dev/null 2>&1; then
  reason='no parent commit to compare with'
elif ! changed=$(git diff --name-only 'HEAD^1' HEAD); then
  reason='changed files could not be listed'
elif printf '%s\n' "$changed" | grep -Eq "$PATHS_RE"; then
  reason='workflow or check files changed'
fi

if [ -z "$reason" ]; then
  echo "Workflow tag rules: skipped (no change under .github/ or to the check)."
  exit 0
fi

printf '%b\n' "${YELLOW}Rejecting loose version tags in workflows (${reason})...${NC}"
./scripts/security/verify-version-tags.sh
./scripts/security/verify-version-tags-fixtures.sh
./scripts/security/verify-version-tags-if-changed-fixtures.sh
