#!/bin/sh

# Tests when the ./yarn launcher adds --check-cache to an install. Offline:
# the launcher is copied next to a stand-in Yarn binary that prints the
# arguments it was given. POSIX sh.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
WORK_DIR=$(mktemp -d)
# EXIT cleans the temp repositories. INT/TERM must exit explicitly under POSIX.
trap 'rm -rf "$WORK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

FAILED=0

# make_repo <name> <.yarnrc.yml line for the cache, may be empty>
make_repo() {
  repo="$WORK_DIR/$1"
  mkdir -p "$repo/.yarn/releases" "$repo/scripts/security"
  cp "$ROOT/yarn" "$repo/yarn"
  printf '%s\n' 'process.stdout.write(process.argv.slice(2).join(" "));' \
    >"$repo/.yarn/releases/yarn-stand-in.cjs"
  printf 'yarnPath: .yarn/releases/yarn-stand-in.cjs\n%s\n' "$2" >"$repo/.yarnrc.yml"
  node -e "const fs=require('node:fs');const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex')+'\n')" \
    "$repo/.yarn/releases/yarn-stand-in.cjs" >"$repo/.yarn/yarn-binary-hash.txt"
  printf '#!/bin/sh\nexit 0\n' >"$repo/scripts/security/block-ide-autostart-hooks.sh"
  chmod +x "$repo/scripts/security/block-ide-autostart-hooks.sh"
}

# expect <description> <repo> <CI> <GITHUB_ACTIONS> <expected arguments> [arguments...]
expect() {
  description=$1
  repo=$2
  ci=$3
  actions=$4
  expected=$5
  shift 5
  actual=$(CI="$ci" GITHUB_ACTIONS="$actions" "$WORK_DIR/$repo/yarn" "$@")
  if [ "$actual" = "$expected" ]; then
    printf 'pass %s\n' "$description"
  else
    printf '%b\n' "${RED}${description}: expected '${expected}', got '${actual}'${NC}" >&2
    FAILED=1
  fi
}

make_repo project 'enableGlobalCache: false'
make_repo global 'enableGlobalCache: true'
make_repo unset ''

expect 'project cache: install gets the flag' project '' '' \
  'install --check-cache' install
expect 'project cache: bare ./yarn is an install' project '' '' \
  'install --check-cache'
expect 'project cache: other install flags are kept' project '' '' \
  'install --immutable --mode=skip-build --check-cache' install --immutable --mode=skip-build
expect 'project cache: the flag is not added twice' project '' '' \
  'install --immutable --check-cache' install --immutable --check-cache
expect 'project cache: other commands are untouched' project '' '' \
  'node install' node install
expect 'project cache: a bare flag is an install' project '' '' \
  'install --immutable --check-cache' --immutable
expect 'project cache: bare flags are kept' project '' '' \
  'install --immutable --mode=skip-build --check-cache' --immutable --mode=skip-build
expect 'project cache: a bare --check-cache is not added twice' project '' '' \
  'install --check-cache' --check-cache
expect 'project cache: --version is not an install' project '' '' \
  '--version' --version
expect 'project cache: -v is not an install' project '' '' \
  '-v' -v
expect 'project cache: --help is not an install' project '' '' \
  '--help' --help
expect 'project cache: --cwd is passed through' project '' '' \
  '--cwd packages/a run build' --cwd packages/a run build
expect 'project cache: a bare flag in CI is untouched' project true '' \
  '--immutable' --immutable
expect 'project cache: not in CI' project true '' \
  'install --immutable' install --immutable
expect 'project cache: not in GitHub Actions' project '' true \
  'install --immutable' install --immutable
expect 'global cache: install is untouched' global '' '' \
  'install' install
expect 'no cache setting: install is untouched' unset '' '' \
  'install' install

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

printf '%b\n' "${GREEN}Yarn launcher fixtures passed${NC}"
exit 0
