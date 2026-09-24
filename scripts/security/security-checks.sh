#!/bin/sh

# Orchestrate supply-chain checks. POSIX sh for Alpine / minimal images.

set -eu

YELLOW='\033[1;33m'
NC='\033[0m'

printf '%b\n' "${YELLOW}Running security checks...${NC}"
echo

printf '%b\n' "${YELLOW}1 of 5: Blocking IDE/agent autostart persistence files...${NC}"
./scripts/security/block-ide-autostart-hooks.sh
echo

printf '%b\n' "${YELLOW}2 of 5: Verifying Node.js version...${NC}"
./scripts/security/verify-node-version.sh
echo

printf '%b\n' "${YELLOW}3 of 5: Verifying Yarn binary hash...${NC}"
./scripts/security/verify-yarn-hash.sh
echo

printf '%b\n' "${YELLOW}4 of 5: Verifying Yarn dependencies are locked...${NC}"
./scripts/security/verify-yarn-dependencies.sh
echo

printf '%b\n' "${YELLOW}5 of 5: Rejecting bare yarn command invocations...${NC}"
./scripts/security/verify-no-bare-yarn.sh
echo

exit 0
