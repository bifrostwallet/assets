#!/bin/sh

# Test when verify-version-tags-if-changed.sh runs the check and when it
# skips it. POSIX sh. Each case builds a small git repository in a temporary
# directory with a copy of the script and stand-ins for the checks it calls,
# so a wrong decision shows as a missing or unexpected "check ran" line.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# The pre-commit hook runs this script, and git gives a hook its own
# variables (GIT_INDEX_FILE, sometimes GIT_DIR and GIT_WORK_TREE). With them
# set, the git commands below would act on the repository being committed to
# instead of the temporary ones.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT="$ROOT/scripts/security/verify-version-tags-if-changed.sh"
SELF="$ROOT/scripts/security/verify-version-tags-if-changed-fixtures.sh"
MARK='stand-in check ran'
FAILED=0

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT HUP TERM

# TMPDIR can be inside a checkout. Without a ceiling, git in a temporary
# directory that has no repository of its own would find that checkout, and
# the "no git repository" cases would test it instead.
WORK=$(CDPATH='' cd -- "$WORK" && pwd -P)
GIT_CEILING_DIRECTORIES=$WORK
export GIT_CEILING_DIRECTORIES

git_q() {
  git -c user.name=fixture -c user.email=fixture@example.invalid \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@" >/dev/null 2>&1
}

# A repository with one commit: the script, stand-in checks, one workflow
# and one source file.
new_repo() {
  repo="$WORK/$1"
  mkdir -p "$repo/scripts/security" "$repo/.github/workflows" "$repo/src"
  cp "$SCRIPT" "$repo/scripts/security/"
  for name in verify-version-tags.sh verify-version-tags-fixtures.sh \
    verify-version-tags-if-changed-fixtures.sh; do
    printf '#!/bin/sh\necho "%s"\n' "$MARK" >"$repo/scripts/security/$name"
    chmod +x "$repo/scripts/security/$name"
  done
  echo 'name: CI' >"$repo/.github/workflows/ci.yml"
  echo 'one' >"$repo/src/a.txt"
  (cd "$repo" && git_q init && git_q add -A && git_q commit -m first)
}

# $1 case name, $2 ran|skipped, $3 repository, then the script's arguments.
# GITHUB_REF_TYPE and GITHUB_EVENT_NAME come from the case, not from CI.
expect() {
  name=$1
  want=$2
  repo=$3
  shift 3
  if out=$(cd "$repo" && GITHUB_REF_TYPE="${CASE_REF_TYPE:-}" GITHUB_EVENT_NAME="${CASE_EVENT:-}" \
    ./scripts/security/verify-version-tags-if-changed.sh "$@" 2>&1); then
    status=0
  else
    status=$?
  fi
  got=skipped
  if printf '%s\n' "$out" | grep -qF "$MARK"; then
    got=ran
  fi
  if [ "$status" -eq 0 ] && [ "$got" = "$want" ]; then
    printf '%s %s\n' "$want" "$name"
  else
    printf '%b\n' "${RED}${name}: expected ${want}, got ${got} (exit ${status})${NC}" >&2
    printf '%s\n' "$out" >&2
    FAILED=1
  fi
}

commit_change() {
  (cd "$1" && git_q add -A && git_q commit -m change)
}

new_repo first-commit
expect 'no parent commit' ran "$repo"

new_repo source-change
echo 'two' >"$repo/src/a.txt"
commit_change "$repo"
expect 'source file changed' skipped "$repo"

new_repo workflow-change
echo 'name: CI 2' >"$repo/.github/workflows/ci.yml"
commit_change "$repo"
expect 'workflow changed' ran "$repo"

new_repo workflow-removed
rm "$repo/.github/workflows/ci.yml"
commit_change "$repo"
expect 'workflow removed' ran "$repo"

new_repo action-change
mkdir -p "$repo/.github/actions/setup"
echo 'name: setup' >"$repo/.github/actions/setup/action.yml"
commit_change "$repo"
expect 'composite action added' ran "$repo"

# git quotes a path with a non-ASCII byte, a double quote or a backslash
# when it lists changed files, so these must not depend on such a list.
ODD_WORKFLOW=$(printf 'd\303\251ploy "v2".yml')

new_repo workflow-odd-name
echo 'name: deploy' >"$repo/.github/workflows/$ODD_WORKFLOW"
commit_change "$repo"
expect 'workflow with a name git quotes' ran "$repo"

new_repo workflow-odd-name-staged
echo 'name: deploy' >"$repo/.github/workflows/$ODD_WORKFLOW"
(cd "$repo" && git_q add -A)
expect 'staged workflow with a name git quotes' ran "$repo" --staged

new_repo source-odd-name
echo 'two' >"$repo/src/$ODD_WORKFLOW"
commit_change "$repo"
expect 'source file with a name git quotes' skipped "$repo"

new_repo check-change
echo '# changed' >>"$repo/scripts/security/verify-version-tags.sh"
commit_change "$repo"
expect 'check changed' ran "$repo"

new_repo fixture-change
mkdir -p "$repo/scripts/security/fixtures/version-tags/pass-new"
echo 'name: x' >"$repo/scripts/security/fixtures/version-tags/pass-new/ci.yml"
commit_change "$repo"
expect 'check fixture added' ran "$repo"

new_repo other-security-script
echo '#!/bin/sh' >"$repo/scripts/security/verify-node-version.sh"
commit_change "$repo"
expect 'another security script changed' skipped "$repo"

new_repo release
echo 'two' >"$repo/src/a.txt"
commit_change "$repo"
CASE_REF_TYPE=tag expect 'tag run, source change only' ran "$repo"
CASE_EVENT=release expect 'release event, source change only' ran "$repo"
CASE_REF_TYPE=branch CASE_EVENT=pull_request expect 'pull request, source change only' skipped "$repo"

new_repo staged
echo 'two' >"$repo/src/a.txt"
(cd "$repo" && git_q add -A)
expect 'staged source file' skipped "$repo" --staged
echo 'name: CI 2' >"$repo/.github/workflows/ci.yml"
expect 'unstaged workflow edit' skipped "$repo" --staged
(cd "$repo" && git_q add -A)
expect 'staged workflow' ran "$repo" --staged

new_repo staged-after-workflow-commit
echo 'name: CI 2' >"$repo/.github/workflows/ci.yml"
commit_change "$repo"
echo 'two' >"$repo/src/a.txt"
(cd "$repo" && git_q add -A)
expect 'staged source file after a workflow commit' skipped "$repo" --staged

new_repo not-a-repository
rm -rf "$repo/.git"
expect 'no git repository' ran "$repo"
expect 'no git repository, staged' ran "$repo" --staged

# Every case again as the pre-commit hook would run them: git's hook
# variables set, here pointing at a decoy that must stay empty.
if [ -z "${VERSION_TAGS_FIXTURES_NESTED:-}" ]; then
  decoy="$WORK/decoy"
  mkdir -p "$decoy"
  if VERSION_TAGS_FIXTURES_NESTED=1 GIT_DIR="$decoy/.git" GIT_WORK_TREE="$decoy" \
    GIT_INDEX_FILE="$decoy/index" "$SELF" >"$WORK/nested.out" 2>&1 \
    && [ -z "$(ls -A "$decoy")" ]; then
    printf 'ran every case again with git hook variables set\n'
  else
    printf '%b\n' "${RED}The cases fail, or touch the outer repository, when git hook variables are set${NC}" >&2
    cat "$WORK/nested.out" >&2
    ls -A "$decoy" >&2
    FAILED=1
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
printf '%b\n' "${GREEN}verify-version-tags-if-changed fixtures passed.${NC}"
