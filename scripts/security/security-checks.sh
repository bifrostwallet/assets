#!/bin/sh

# Orchestrate supply-chain checks. POSIX sh for Alpine / minimal images.

set -eu

YELLOW='\033[1;33m'
NC='\033[0m'

printf '%b\n' "${YELLOW}Running security checks...${NC}"
echo

printf '%b\n' "${YELLOW}1 of 6: Blocking IDE/agent autostart persistence files...${NC}"
./scripts/security/block-ide-autostart-hooks.sh
echo

printf '%b\n' "${YELLOW}2 of 6: Verifying Node.js version...${NC}"
./scripts/security/verify-node-version.sh
echo

printf '%b\n' "${YELLOW}3 of 6: Verifying Yarn binary hash...${NC}"
./scripts/security/verify-yarn-hash.sh
echo

printf '%b\n' "${YELLOW}4 of 6: Verifying Yarn dependencies are locked...${NC}"
./scripts/security/verify-yarn-dependencies.sh
echo

printf '%b\n' "${YELLOW}5 of 6: Rejecting bare yarn command invocations...${NC}"
./scripts/security/verify-no-bare-yarn.sh
echo

printf '%b\n' "${YELLOW}6 of 6: Verifying tsconfig module lanes (NodeNext or Bundler)...${NC}"
./scripts/security/verify-tsconfig-lanes.sh
./scripts/security/verify-tsconfig-lanes-fixtures.sh
echo

# The workflow tag rules (verify-version-tags.sh) are not here: they read
# .github/ only, and this script runs on every ./yarn call. CI, the pre-commit
# hook and release workflows run verify-version-tags-if-changed.sh.

exit 0
