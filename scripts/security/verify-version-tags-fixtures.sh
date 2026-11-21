#!/bin/sh

# Run verify-version-tags.sh against committed pass/fail workflow fixtures.
# POSIX sh. VERSION_TAG_SCAN_DIR points the scanner at one fixture directory.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

SCANNER=./scripts/security/verify-version-tags.sh
FIXTURES=scripts/security/fixtures/version-tags
FAILED=0

run_case() {
  expect=$1
  dir=$2
  out=$(mktemp)
  if VERSION_TAG_SCAN_DIR="$dir" "$SCANNER" >"$out" 2>&1; then
    status=0
  else
    status=$?
  fi
  if [ "$expect" = pass ] && [ "$status" -eq 0 ]; then
    printf 'pass %s\n' "$dir"
  elif [ "$expect" = fail ] && [ "$status" -ne 0 ]; then
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
  printf '%b\n' "${RED}No version-tag fixtures under ${FIXTURES}${NC}" >&2
  exit 1
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

printf '%b\n' "${GREEN}Version-tag fixtures passed${NC}"
exit 0
