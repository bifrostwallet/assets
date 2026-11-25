#!/bin/sh

# Run verify-gha-workflows.sh against committed pass/fail fixtures.
# POSIX sh. GHA_LINT_SCAN_DIR points the scanner at one fixture directory.
#
# A pass-* fixture must exit 0. A fail-* fixture must exit 1, print the
# policy failure, and print every line of its expected-error file.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

SCANNER=./scripts/security/verify-gha-workflows.sh
FIXTURES=scripts/security/fixtures/gha-workflows
FAILED=0

fail_output_matches() {
  grep -q 'workflow lint failed' "$2" || return 1
  if [ ! -s "$1/expected-error" ]; then
    printf '%b\n' "${RED}Fixture $1 has no expected-error file${NC}" >&2
    return 1
  fi
  while IFS= read -r _want || [ -n "$_want" ]; do
    [ -n "$_want" ] || continue
    grep -qF -- "$_want" "$2" || return 1
  done <"$1/expected-error"
  return 0
}

run_case() {
  expect=$1
  dir=$2
  out=$(mktemp)
  if GHA_LINT_SCAN_DIR="$dir" "$SCANNER" >"$out" 2>&1; then
    status=0
  else
    status=$?
  fi
  if [ "$expect" = pass ] && [ "$status" -eq 0 ]; then
    printf 'pass %s\n' "$dir"
  elif [ "$expect" = fail ] && [ "$status" -eq 1 ] && fail_output_matches "$dir" "$out"; then
    printf 'fail %s\n' "$dir"
  else
    printf '%b\n' "${RED}Fixture ${dir} expected ${expect} (exit ${status})${NC}" >&2
    cat "$out" >&2
    FAILED=1
  fi
  rm -f "$out"
}

found=0
for dir in "$FIXTURES"/pass-* "$FIXTURES"/fail-*; do
  [ -d "$dir" ] || continue
  found=1
  case "$dir" in
    */pass-*) run_case pass "$dir" ;;
    */fail-*) run_case fail "$dir" ;;
  esac
done

if [ "$found" -eq 0 ]; then
  printf '%b\n' "${RED}No workflow lint fixtures under ${FIXTURES}${NC}" >&2
  exit 1
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

printf '%b\n' "${GREEN}Workflow lint fixtures passed${NC}"
exit 0
