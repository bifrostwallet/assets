#!/bin/sh

# Offline tests of verify-tsconfig-lanes.sh. Each case writes tsconfig files
# into a throwaway directory and checks the gate passes or fails (and, for a
# fail, prints the offending file, so a crash is not a correct rejection).
# Cases are generated here rather than committed: a committed unparsable
# tsconfig would trip Biome. TSCONFIG_LANES_DIR points the gate at the case.
# POSIX sh.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
GATE="$ROOT/scripts/security/verify-tsconfig-lanes.sh"
WORK=$(mktemp -d)
# EXIT cleans up. INT/TERM must exit explicitly under POSIX.
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
FAILED=0
N=0

NODENEXT='{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }'
BUNDLER='{ "compilerOptions": { "module": "Preserve", "moduleResolution": "Bundler" } }'

# put <case> <relative path> <content>
put() {
  mkdir -p "$WORK/$1/$(dirname "$2")"
  printf '%s\n' "$3" >"$WORK/$1/$2"
}

# check <pass|fail> <case> [file the failure must name]
check() {
  expect=$1
  name=$2
  want=${3:-}
  N=$((N + 1))
  out="$WORK/out.$N"
  if TSCONFIG_LANES_DIR="$WORK/$name" "$GATE" >"$out" 2>&1; then
    status=0
  else
    status=$?
  fi
  if { [ "$expect" = pass ] && [ "$status" -eq 0 ]; } ||
    { [ "$expect" = fail ] && [ "$status" -eq 1 ] && grep -qF -- "$want:" "$out"; }; then
    printf '%s %s\n' "$expect" "$name"
  else
    printf '%b\n' "${RED}Case ${name} expected ${expect} (exit ${status})${NC}" >&2
    cat "$out" >&2
    FAILED=1
  fi
}

put pass-nodenext tsconfig.json "$NODENEXT"
check pass pass-nodenext

put pass-lowercase tsconfig.json '{ "compilerOptions": { "module": "nodenext", "moduleResolution": "nodenext" } }'
check pass pass-lowercase

put pass-bundler apps/web/tsconfig.json "$BUNDLER"
check pass pass-bundler

put pass-two-lanes apps/api/tsconfig.json "$NODENEXT"
put pass-two-lanes apps/web/tsconfig.json "$BUNDLER"
check pass pass-two-lanes

put pass-extends-local tsconfig.json "$NODENEXT"
put pass-extends-local tsconfig.build.json '{ "extends": "./tsconfig.json", "include": ["src"] }'
put pass-extends-local test/tsconfig.json '{ "extends": "../tsconfig.json" }'
check pass pass-extends-local

put pass-jsonc tsconfig.json '{
  // Node lane
  "compilerOptions": {
    /* block */ "module": "NodeNext",
    "moduleResolution": "NodeNext", // trailing
    "paths": { "@/*": ["./src/*"] },
  },
}'
check pass pass-jsonc

put pass-ignores-deps tsconfig.json "$NODENEXT"
put pass-ignores-deps node_modules/pkg/tsconfig.json '{ "compilerOptions": { "module": "commonjs" } }'
check pass pass-ignores-deps

put fail-commonjs tsconfig.json '{ "compilerOptions": { "module": "commonjs", "moduleResolution": "node10" } }'
check fail fail-commonjs tsconfig.json

put fail-esnext-bundler tsconfig.json '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler" } }'
check fail fail-esnext-bundler tsconfig.json

put fail-mixed tsconfig.json '{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "Bundler" } }'
check fail fail-mixed tsconfig.json

put fail-module-only tsconfig.json '{ "compilerOptions": { "module": "NodeNext" } }'
check fail fail-module-only tsconfig.json

put fail-extends-package tsconfig.json '{ "extends": "expo/tsconfig.base", "compilerOptions": { "strict": true } }'
check fail fail-extends-package tsconfig.json

put fail-no-lane tsconfig.json '{ "compilerOptions": { "strict": true } }'
check fail fail-no-lane tsconfig.json

put fail-unparsable tsconfig.json '{ "compilerOptions": { "module": "NodeNext" '
check fail fail-unparsable tsconfig.json

put fail-nested apps/api/tsconfig.json "$NODENEXT"
put fail-nested scripts/tsconfig.scripts.json '{ "compilerOptions": { "module": "ES2022", "moduleResolution": "node" } }'
check fail fail-nested scripts/tsconfig.scripts.json

put fail-extends-node-modules tsconfig.json '{ "extends": "./node_modules/expo/tsconfig.base" }'
put fail-extends-node-modules node_modules/expo/tsconfig.base.json '{ "compilerOptions": { "module": "ESNext" } }'
check fail fail-extends-node-modules tsconfig.json

put fail-extends-unscanned-name tsconfig.json '{ "extends": "./tsconfig-base.json" }'
put fail-extends-unscanned-name tsconfig-base.json '{ "compilerOptions": { "module": "commonjs" } }'
check fail fail-extends-unscanned-name tsconfig.json

put fail-extends-config-dir tsconfig.json '{ "extends": "./config/base.json" }'
put fail-extends-config-dir config/base.json '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler" } }'
check fail fail-extends-config-dir tsconfig.json

put fail-extends-missing tsconfig.json '{ "extends": "./tsconfig.base.json" }'
check fail fail-extends-missing tsconfig.json

put fail-extends-outside apps/web/tsconfig.json '{ "extends": "../../../shared/tsconfig.json" }'
check fail fail-extends-outside apps/web/tsconfig.json

put pass-extends-no-suffix tsconfig.base.json "$NODENEXT"
put pass-extends-no-suffix tsconfig.json '{ "extends": "./tsconfig.base" }'
check pass pass-extends-no-suffix

put fail-extends-chain-off-lane tsconfig.base.json '{ "compilerOptions": { "module": "commonjs" } }'
put fail-extends-chain-off-lane tsconfig.json '{ "extends": "./tsconfig.base.json" }'
check fail fail-extends-chain-off-lane tsconfig.base.json

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

printf '%b\n' "${GREEN}All ${N} tsconfig lane fixtures behaved as expected.${NC}"
exit 0
