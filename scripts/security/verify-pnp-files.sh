#!/bin/sh

# Fail unless the committed Yarn PnP files match what a fresh install wrote.
#
# Run right after `./yarn install`. With Zero-Installs, .pnp.cjs and
# .pnp.loader.mjs are committed, and Yarn loads them into every
# `./yarn run` / `./yarn node` (.pnp.loader.mjs through --experimental-loader
# when the project is ESM). They are marked linguist-generated and ignored by
# Biome, so nobody reads them in review. An install rewrites both from
# yarn.lock, so any difference left in the working tree afterwards means the
# committed copy is not what Yarn generates: hand-edited, from another Yarn
# version, missing, or committed by mistake.
#
# Checks, for .pnp.cjs and .pnp.loader.mjs at the repository root:
#   - modified or deleted compared with the commit  -> fail
#   - generated but not committed (untracked)        -> fail
#   - generated, untracked and ignored by git        -> fail
#     (.gitignore, .git/info/exclude or core.excludesFile; a tracked file is
#     never treated as ignored, and its changes still show in git status)
# A repo on the node-modules linker has neither file and passes.
#
# POSIX sh.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PNP_FILES='.pnp.cjs .pnp.loader.mjs'
FAILED=0

for f in $PNP_FILES; do
  if [ -e "$f" ] && git check-ignore -q -- "$f"; then
    printf '%b\n' "${RED}Error: ${f} is ignored by git (.gitignore, .git/info/exclude or core.excludesFile). Zero-Installs commits it.${NC}" >&2
    FAILED=1
  fi
done

# shellcheck disable=SC2086 # word splitting of the fixed file list is intended
STATUS=$(git status --porcelain --untracked-files=all -- $PNP_FILES)

if [ -n "$STATUS" ]; then
  printf '%b\n' "${RED}Error: Yarn PnP files differ from what ./yarn install generates:${NC}" >&2
  printf '%s\n' "$STATUS" >&2
  # shellcheck disable=SC2086
  git --no-pager diff --stat -- $PNP_FILES >&2 || true
  printf '%b\n' "${YELLOW}On a clean checkout run ./yarn install and commit the regenerated files.${NC}" >&2
  printf '%b\n' "${YELLOW}If you did not change yarn.lock or the Yarn version, treat a difference as suspicious.${NC}" >&2
  FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

printf '%b\n' "${GREEN}Yarn PnP files match a fresh install.${NC}"
exit 0
