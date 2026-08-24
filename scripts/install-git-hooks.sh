#!/bin/sh
# Point Git at repo-owned hooks under .git-hooks/.
set -eu

[ "${SKIP_GIT_HOOKS:-}" = "1" ] && exit 0

git rev-parse --git-dir >/dev/null 2>&1 || exit 0

git config core.hooksPath .git-hooks
