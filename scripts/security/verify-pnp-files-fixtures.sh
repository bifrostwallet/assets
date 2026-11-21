#!/bin/sh

# Offline tests of verify-pnp-files.sh. Each case builds a throwaway git repo,
# puts the PnP files in one state, and checks the gate passes or fails.
# PNP_VERIFY_DIR points the gate at the throwaway repo. POSIX sh.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
GATE="$ROOT/scripts/security/verify-pnp-files.sh"
WORK=$(mktemp -d)
# INT/TERM must exit explicitly under POSIX, or the cases carry on without $WORK.
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
FAILED=0
N=0

# new_repo <name>: empty git repo with one commit, path on stdout.
new_repo() {
  dir="$WORK/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email fixtures@example.invalid
  git -C "$dir" config user.name fixtures
  git -C "$dir" config commit.gpgsign false
  printf 'node_modules/\n' >"$dir/.gitignore"
  git -C "$dir" add .gitignore
  git -C "$dir" commit -q -m init
  printf '%s\n' "$dir"
}

# commit_pnp <dir>: commit both PnP files.
commit_pnp() {
  printf 'cjs\n' >"$1/.pnp.cjs"
  printf 'mjs\n' >"$1/.pnp.loader.mjs"
  git -C "$1" add .pnp.cjs .pnp.loader.mjs
  git -C "$1" commit -q -m pnp
}

# check <pass|fail> <name> <dir> [expected output fragment]
# A fail case must also print the expected error, so a gate that crashes
# (e.g. a git error, exit 128) does not count as a correct rejection.
check() {
  expect=$1
  name=$2
  dir=$3
  want=${4:-}
  N=$((N + 1))
  out="$WORK/out.$N"
  if PNP_VERIFY_DIR="$dir" "$GATE" >"$out" 2>&1; then
    status=0
  else
    status=$?
  fi
  if { [ "$expect" = pass ] && [ "$status" -eq 0 ]; } ||
    { [ "$expect" = fail ] && [ "$status" -eq 1 ] && grep -qF -- "$want" "$out"; }; then
    printf '%s %s\n' "$expect" "$name"
  else
    printf '%b\n' "${RED}Case ${name} expected ${expect} (exit ${status})${NC}" >&2
    cat "$out" >&2
    FAILED=1
  fi
}

d=$(new_repo committed-clean)
commit_pnp "$d"
check pass committed-clean "$d"

d=$(new_repo no-pnp-files)
check pass no-pnp-files "$d"

d=$(new_repo loader-modified)
commit_pnp "$d"
printf 'injected\n' >>"$d/.pnp.loader.mjs"
check fail loader-modified "$d" "differ from what ./yarn install generates"

d=$(new_repo cjs-modified)
commit_pnp "$d"
printf 'injected\n' >>"$d/.pnp.cjs"
check fail cjs-modified "$d" "differ from what ./yarn install generates"

d=$(new_repo loader-untracked)
printf 'cjs\n' >"$d/.pnp.cjs"
git -C "$d" add .pnp.cjs
git -C "$d" commit -q -m cjs
printf 'mjs\n' >"$d/.pnp.loader.mjs"
check fail loader-untracked "$d" "differ from what ./yarn install generates"

d=$(new_repo loader-deleted)
commit_pnp "$d"
rm "$d/.pnp.loader.mjs"
check fail loader-deleted "$d" "differ from what ./yarn install generates"

d=$(new_repo loader-ignored)
printf '.pnp.loader.mjs\n' >>"$d/.gitignore"
git -C "$d" add .gitignore
git -C "$d" commit -q -m ignore
printf 'mjs\n' >"$d/.pnp.loader.mjs"
check fail loader-ignored "$d" "is ignored by git"

# Tracked wins over ignored: a committed loader that .gitignore also matches is
# still under version control, so edits show up in git status.
d=$(new_repo loader-tracked-and-ignored)
commit_pnp "$d"
printf '.pnp.loader.mjs\n' >>"$d/.gitignore"
git -C "$d" add .gitignore
git -C "$d" commit -q -m ignore
check pass loader-tracked-and-ignored "$d"
printf 'injected\n' >>"$d/.pnp.loader.mjs"
check fail loader-tracked-and-ignored-modified "$d" "differ from what ./yarn install generates"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

printf '%b\n' "${GREEN}All ${N} PnP gate fixtures behaved as expected.${NC}"
exit 0
