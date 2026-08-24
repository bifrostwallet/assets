#!/bin/sh

# Reject command-like bare `yarn <subcommand>` in workflows, hooks, scripts, and docs.
# Allowed: ./yarn …, yarnPath, yarn.lock, yarn@…, prose about Yarn the tool,
# and the generated yarn.lock header.
# POSIX sh + grep -E (no bash, no ripgrep).

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

# Bare yarn + common subcommands (not ./yarn).
PATTERN='(^|[^./[:alnum:]_-])yarn[[:space:]]+(install|add|remove|run|test|build|lint|typecheck|workspace|workspaces|dlx|exec|node|npm|set|config|why|info|pack|publish|link|unlink|up|upgrade|dedupe|constraints|plugin|version|init|create|explain|search|stage|unplug)([[:space:]]|$)'

FILE_LIST=$(mktemp)
OUT_LIST=$(mktemp)
trap 'rm -f "$FILE_LIST" "$OUT_LIST"' EXIT INT TERM

find .github/workflows .git-hooks scripts docs README.md package.json \
  \( -type f -o -type l \) 2>/dev/null >"$FILE_LIST" || true

: >"$OUT_LIST"
while IFS= read -r file || [ -n "$file" ]; do
  [ -z "$file" ] && continue
  case "$file" in
    */yarn.lock|*/node_modules/*|*/.yarn/cache/*|*/.yarn/releases/*|*/verify-no-bare-yarn.sh) continue ;;
  esac
  file_matches=$(grep -nE "$PATTERN" "$file" 2>/dev/null || true)
  if [ -n "$file_matches" ]; then
    printf '%s\n' "$file_matches" | while IFS= read -r line || [ -n "$line" ]; do
      [ -z "$line" ] && continue
      case "$line" in
        *'./yarn'*) continue ;;
      esac
      printf '%s\n' "${file}:${line}"
    done >>"$OUT_LIST"
  fi
done <"$FILE_LIST"

matches=$(cat "$OUT_LIST" 2>/dev/null || true)

cleaned=$(printf '%s' "$matches" | tr -d '[:space:]')
if [ -n "$cleaned" ]; then
  printf '%b\n' "${RED}Error: bare yarn subcommand(s) found — use ./yarn instead:${NC}"
  echo
  printf '%s\n' "$matches"
  echo
  printf '%b\n' "${YELLOW}Use the hash-verified ./yarn launcher; global yarn with yarnPath skips SHA-256 verification.${NC}"
  exit 1
fi

printf '%b\n' "${GREEN}No bare yarn subcommand invocations in scanned paths${NC}"
exit 0
