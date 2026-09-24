#!/bin/sh

# Fail installs that did not enter through the hash-verified ./yarn launcher.
# Global Yarn with yarnPath re-executes .yarn/releases/*.cjs and skips the
# launcher SHA-256 check; requiring BIFROST_YARN_VERIFIED closes that gap.
#
# Do not require npm_execpath under .yarn/releases/: Yarn 4 runs lifecycle
# scripts via a temporary xfs copy (…/xfs-*/yarn), so that path check false-fails
# even for legitimate ./yarn install. npm/pnpm still fail because they never set
# BIFROST_YARN_VERIFIED.

set -eu

RED='\033[0;31m'
NC='\033[0m'

if [ "${BIFROST_YARN_VERIFIED:-}" != "1" ]; then
  echo "${RED}Error: install must go through the hash-verified ./yarn launcher.${NC}" >&2
  echo "  Use: ./yarn install   (not global yarn, Corepack, npm, or pnpm)" >&2
  echo "  Global yarn with yarnPath re-executes the vendored binary but skips SHA-256 verification." >&2
  exit 1
fi

exit 0
