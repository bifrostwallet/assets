#!/bin/sh

# Orchestrate supply-chain checks. POSIX sh for Alpine / minimal images.

set -eu

YELLOW='\033[1;33m'
NC='\033[0m'

printf '%b\n' "${YELLOW}Running security checks...${NC}"
echo

printf '%b\n' "${YELLOW}1 of 7: Blocking IDE/agent autostart persistence files...${NC}"
./scripts/security/block-ide-autostart-hooks.sh
echo

printf '%b\n' "${YELLOW}2 of 7: Verifying Node.js version...${NC}"
./scripts/security/verify-node-version.sh
echo

printf '%b\n' "${YELLOW}3 of 7: Verifying Yarn binary hash...${NC}"
./scripts/security/verify-yarn-hash.sh
echo

printf '%b\n' "${YELLOW}4 of 7: Verifying Yarn dependencies are locked...${NC}"
./scripts/security/verify-yarn-dependencies.sh
echo

printf '%b\n' "${YELLOW}5 of 7: Rejecting bare yarn command invocations...${NC}"
./scripts/security/verify-no-bare-yarn.sh
echo

printf '%b\n' "${YELLOW}6 of 7: Rejecting loose version tags in workflows...${NC}"
./scripts/security/verify-version-tags.sh
./scripts/security/verify-version-tags-fixtures.sh
echo

printf '%b\n' "${YELLOW}7 of 7: Verifying tsconfig module lanes (NodeNext or Bundler)...${NC}"
./scripts/security/verify-tsconfig-lanes.sh
./scripts/security/verify-tsconfig-lanes-fixtures.sh
echo

exit 0
