#!/bin/sh

# Lint every YAML file in the repository with yamllint.
#
# Discovery is tracked *.yaml / *.yml (plus untracked not gitignored), excluding
# Yarn cache, vendor snapshots, and node_modules. Style lives in .yamllint.yaml
# so GitHub Actions `on:`, Cloud Build, compose, and cloud-init share one config.
#
# yamllint is preinstalled on GitHub's ubuntu-24.04 runner images, so CI
# downloads nothing. Install it from your OS package manager to run this locally.
# The summary line includes the version so a CI-only failure is easy to match.
#
# POSIX sh for consistency with scripts/lint-shell.sh.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ROOT"

if ! command -v yamllint >/dev/null 2>&1; then
  printf '%b\n' "${RED}Error: yamllint not found in PATH.${NC}" >&2
  printf '%b\n' "${YELLOW}Install it from your OS package manager, then re-run.${NC}" >&2
  exit 1
fi

if [ ! -f .yamllint.yaml ]; then
  printf '%b\n' "${RED}Error: .yamllint.yaml missing at repo root.${NC}" >&2
  exit 1
fi

TRACKED=$(mktemp)
FILES=$(mktemp)
trap 'rm -f "$TRACKED" "$FILES"' EXIT INT HUP TERM

# --others --exclude-standard so a newly added, not-yet-staged file is linted
# locally exactly as it will be in CI once committed.
git ls-files --cached --others --exclude-standard > "$TRACKED"
: > "$FILES"

while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  case "$file" in
    .git/* | */.git/*) continue ;;
    node_modules/* | */node_modules/*) continue ;;
    .yarn/* | */.yarn/*) continue ;;
    vendor/* | */vendor/*) continue ;;
  esac
  [ -f "$file" ] || continue

  case "$file" in
    *.yaml | *.yml)
      printf '%s\n' "$file" >> "$FILES"
      ;;
  esac
done < "$TRACKED"

if [ ! -s "$FILES" ]; then
  printf '%b\n' "${YELLOW}No YAML files found.${NC}"
  exit 0
fi

COUNT=$(wc -l < "$FILES" | tr -d ' ')

set --
while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  set -- "$@" "$file"
done < "$FILES"

YL_VERSION=$(yamllint --version 2>/dev/null | awk '{print $2; exit}')
if [ -z "$YL_VERSION" ]; then
  YL_VERSION=unknown
fi

if [ "${YAML_LINT_LABEL:-}" = staged ]; then
  printf 'Running yamllint (%s) on staged YAML...\n' "$YL_VERSION"
else
  printf 'Running yamllint (%s)...\n' "$YL_VERSION"
fi

if ! yamllint --strict -c .yamllint.yaml -- "$@"; then
  printf '%b\n' "${RED}yamllint (${YL_VERSION}) found issues (${COUNT} files).${NC}" >&2
  exit 1
fi

printf '%b\n' "${GREEN}Checked ${COUNT} YAML files. All good.${NC}"
echo ""
