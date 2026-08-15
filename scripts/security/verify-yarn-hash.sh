#!/bin/sh

# Verify vendored Yarn binary SHA-256. POSIX sh.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

HASH_FILE=".yarn/yarn-binary-hash.txt"

sha256_file() {
  node -e "const fs=require('node:fs');const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$1"
}

if [ ! -f .yarnrc.yml ]; then
  printf '%b\n' "${RED}Error: .yarnrc.yml not found${NC}"
  exit 1
fi

YARN_PATH=$(grep '^yarnPath:' .yarnrc.yml | head -n1 | awk '{print $2}')
if [ -z "$YARN_PATH" ]; then
  printf '%b\n' "${RED}Error: yarnPath not set in .yarnrc.yml${NC}"
  exit 1
fi

if [ -f "$HASH_FILE" ]; then
  FILE_HASH=$(grep -v '^#' "$HASH_FILE" | grep -v '^$' | tail -n 1 | tr -d '[:space:]')
  if [ -z "$FILE_HASH" ]; then
    printf '%b\n' "${RED}Error: Could not extract hash from $HASH_FILE${NC}"
    exit 1
  fi
else
  printf '%b\n' "${RED}Error: Hash file not found at $HASH_FILE${NC}"
  exit 1
fi

PKG_HASH=$(node -p "require('./package.json').packageManager || ''" | grep -o 'sha256.[a-f0-9]\{64\}' | cut -d'.' -f2)
if [ -z "$PKG_HASH" ]; then
  printf '%b\n' "${RED}Error: Could not extract expected hash from package.json${NC}"
  exit 1
fi

if [ "$FILE_HASH" != "$PKG_HASH" ]; then
  printf '%b\n' "${RED}Error: Hash mismatch between $HASH_FILE and package.json${NC}"
  echo "Hash file: $FILE_HASH"
  echo "Package.json: $PKG_HASH"
  printf '%b\n' "${RED}These hashes must match. Please update one or both files.${NC}"
  exit 1
fi

EXPECTED_HASH="$FILE_HASH"

if [ ! -f "$YARN_PATH" ]; then
  printf '%b\n' "${RED}Error: Yarn binary not found at $YARN_PATH${NC}"
  exit 1
fi

ACTUAL_HASH=$(sha256_file "$YARN_PATH")

if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
  printf '%b\n' "${RED}Error: Yarn binary hash mismatch${NC}"
  echo "Expected: $EXPECTED_HASH"
  echo "Actual:   $ACTUAL_HASH"
  printf '%b\n' "${RED}Verification failed. The Yarn binary hash does not match the expected hash.${NC}"
  printf '%b\n' "${YELLOW}If you intentionally updated the Yarn binary, run ./scripts/security/yarn-binary.sh update${NC}"
  printf '%b\n' "${YELLOW}Or use ./scripts/security/yarn-binary.sh upgrade <version> for a full upgrade.${NC}"
  exit 1
fi

printf '%b\n' "${GREEN}Yarn binary hash verification passed${NC}"
exit 0
