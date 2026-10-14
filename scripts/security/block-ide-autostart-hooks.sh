#!/bin/sh

# Block IDE/agent/git-hook autostart persistence used by self-replicating
# Shai-Hulud-style npm supply-chain attacks: malware plants these so Claude Code
# SessionStart, VS Code folderOpen, Cursor project hooks, or nested git-hook installers
# re-execute a loader without npm install.
#
# This does NOT replace enableScripts: false / the age gate — those stop the
# primary preinstall payload. This layer removes a common secondary persistence
# surface if those paths ever appear in the working tree.
#
# Exit 1 if any blocked path was present (after deleting), so install/CI/hooks
# refuse to continue on a potentially compromised tree.
#
# POSIX sh so Alpine (no bash) Docker installs can run this via ./yarn.

set -eu

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT"

# Repo-root only — package tarballs under node_modules are out of scope for
# workspace autostart (those tools read the project root).
# Paths ending in / are directories (removed recursively).
found=0
for rel in \
  ".claude/settings.json" \
  ".vscode/tasks.json" \
  ".cursor/hooks.json" \
  ".cursor/hooks/" \
  ".husky/"
do
  # Trim trailing slash for existence checks; keep display name as listed.
  check_rel=${rel%/}
  path="$ROOT/$check_rel"
  if [ -e "$path" ] || [ -L "$path" ]; then
    printf '%b\n' "${RED}SECURITY: blocked IDE/agent autostart path present: ${rel}${NC}" >&2
    if [ -d "$path" ] && [ ! -L "$path" ]; then
      rm -rf "$path"
    else
      rm -f "$path"
    fi
    printf '%b\n' "${YELLOW}Removed ${rel}. Treat this machine as suspect if you did not create that path.${NC}" >&2
    printf '%b\n' "${YELLOW}These paths are a known persistence surface in Shai-Hulud-style supply-chain worms.${NC}" >&2
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  printf '%b\n' "${RED}Refusing to continue until the working tree stays clean of these paths.${NC}" >&2
  printf '%b\n' "${RED}Re-run your command after investigating; a second clean run should succeed.${NC}" >&2
  exit 1
fi

exit 0
