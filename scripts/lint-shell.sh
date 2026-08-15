#!/bin/sh

# Lint every shell script in the repository with a POSIX shebang gate and
# ShellCheck (-s sh).
#
# Discovery is intentional and narrow: tracked *.sh files, extensionless
# launchers we ship (yarn, maestro), and git hooks under .git-hooks/ (e.g.
# pre-commit), including nested copies. We do not shebang-probe other
# extensionless files — add a .sh suffix, or extend the case below, if a new
# launcher needs linting. (direnv `.envrc` is bash-only and intentionally
# outside this set.)
#
# ShellCheck is preinstalled on GitHub's Ubuntu runner images, so CI downloads
# nothing. Install it from your OS package manager to run this locally. The
# version is whatever the runner ships (ubuntu-24.04 has 0.9, ubuntu-22.04 has
# 0.8) and older releases flag things newer ones do not, so the summary line
# includes the version to make a CI-only failure easy to reproduce.
#
# POSIX sh for consistency with scripts/security/.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ROOT"

if ! command -v shellcheck >/dev/null 2>&1; then
  printf '%b\n' "${RED}Error: shellcheck not found in PATH.${NC}" >&2
  printf '%b\n' "${YELLOW}Install it from your OS package manager, then re-run.${NC}" >&2
  exit 1
fi

TRACKED=$(mktemp)
FILES=$(mktemp)
trap 'rm -f "$TRACKED" "$FILES"' EXIT INT HUP TERM

# --others --exclude-standard so a newly added, not-yet-staged script is linted
# locally exactly as it will be in CI once committed.
git ls-files --cached --others --exclude-standard > "$TRACKED"
: > "$FILES"

while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  case "$file" in
    .git/* | */.git/*) continue ;;
    node_modules/* | */node_modules/*) continue ;;
    .yarn/* | */.yarn/*) continue ;;
  esac
  [ -f "$file" ] || continue

  case "$file" in
    *.sh | yarn | */yarn | maestro | */maestro | .git-hooks/* | */.git-hooks/*)
      printf '%s\n' "$file" >> "$FILES"
      ;;
  esac
done < "$TRACKED"

if [ ! -s "$FILES" ]; then
  printf '%b\n' "${YELLOW}No shell scripts found.${NC}"
  exit 0
fi

COUNT=$(wc -l < "$FILES" | tr -d ' ')
FAILED=0

# Stay aligned scripts are POSIX sh only — reject bash shebangs and bash
# ShellCheck dialects before ShellCheck runs.
while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  # Portable first-line read (avoid head for SC3044 noise in some environments).
  first=
  IFS= read -r first < "$file" || true
  if [ "$first" != '#!/bin/sh' ]; then
    printf '%b\n' "${RED}Error: ${file}: shebang must be exactly #!/bin/sh (got: ${first:-<empty>})${NC}" >&2
    FAILED=1
  fi
  # Real ShellCheck directives only (# shellcheck … shell=bash), not prose.
  if awk '
      /^[[:space:]]*#[[:space:]]*shellcheck([[:space:]]|$)/ && /shell=bash/ { found = 1; exit }
      END { exit found ? 0 : 1 }
    ' "$file"; then
    printf '%b\n' "${RED}Error: ${file}: remove ShellCheck shell=bash dialect directive (use POSIX sh)${NC}" >&2
    FAILED=1
  fi
done < "$FILES"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

set --
while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  set -- "$@" "$file"
done < "$FILES"

SC_VERSION=$(shellcheck --version | sed -n 's/^version: //p' | head -n 1)
if [ -z "$SC_VERSION" ]; then
  SC_VERSION=unknown
fi

if [ "${SHELL_LINT_LABEL:-}" = staged ]; then
  printf 'Running ShellCheck (%s) on staged scripts...\n' "$SC_VERSION"
else
  printf 'Running ShellCheck (%s)...\n' "$SC_VERSION"
fi

# Force sh even if a file's shebang were wrong (gate above should already catch that).
if ! shellcheck -s sh -- "$@"; then
  printf '%b\n' "${RED}ShellCheck (${SC_VERSION}) found issues (${COUNT} scripts).${NC}" >&2
  exit 1
fi

printf '%b\n' "${GREEN}Checked ${COUNT} scripts. All good.${NC}"
echo ""
