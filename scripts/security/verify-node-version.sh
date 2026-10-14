#!/bin/sh

# Enforce exact Node.js pin from .node-version / .nvmrc. POSIX sh.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

VERSION_FILE=".node-version"
NVMRC_FILE=".nvmrc"

read_pin() {
  file="$1"
  grep -v '^#' "$file" | grep -v '^$' | head -n 1 | tr -d '[:space:]' | sed 's/^v//'
}

if [ ! -f "$VERSION_FILE" ]; then
  printf '%b\n' "${RED}Error: $VERSION_FILE is missing. It pins the required Node.js version.${NC}"
  exit 1
fi

if [ ! -f "$NVMRC_FILE" ]; then
  printf '%b\n' "${RED}Error: $NVMRC_FILE is missing. It must match $VERSION_FILE so \`nvm use\` / \`nvm install\` pick up the pin.${NC}"
  exit 1
fi

REQUIRED=$(read_pin "$VERSION_FILE")
if ! printf '%s' "$REQUIRED" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  printf '%b\n' "${RED}Error: $VERSION_FILE must pin an exact Node.js version (e.g. 24.18.0). Found: ${REQUIRED:-<empty>}${NC}"
  exit 1
fi

NVMRC_VERSION=$(read_pin "$NVMRC_FILE")
if [ "$REQUIRED" != "$NVMRC_VERSION" ]; then
  printf '%b\n' "${RED}Error: $VERSION_FILE (${REQUIRED}) does not match $NVMRC_FILE (${NVMRC_VERSION:-<empty>}).${NC}"
  exit 1
fi

ACTUAL=$(node --version | sed 's/^v//')

if [ "$ACTUAL" != "$REQUIRED" ]; then
  printf '%b\n' "${RED}Error: Node.js ${REQUIRED} is required, but v${ACTUAL} is active.${NC}"
  printf '%b\n' "${YELLOW}Yarn does not enforce the engines field, so this check is the enforcement.${NC}"
  printf '%b\n' "${YELLOW}Switch versions (e.g. 'nvm install ${REQUIRED} && nvm use ${REQUIRED}') and retry.${NC}"
  exit 1
fi

printf '%b\n' "${GREEN}Node.js version check passed (v${ACTUAL}; $VERSION_FILE matches $NVMRC_FILE)${NC}"
exit 0
