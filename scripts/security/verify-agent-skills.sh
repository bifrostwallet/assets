#!/bin/sh

# Agent skills (.claude/skills/): absent (default) or pinned closed-world
# SHA-256, the same two modes as pinned project hooks.
#
# A skill is loaded by Claude Code and by other agents that read this folder,
# and an agent can pick one up on its own when the skill's description matches
# the task. A planted skill is a way to run commands through the agent, like a
# planted hook, and .gitignore no longer hides the folder.
#
# Absent mode (no .claude/skills.sha256):
#   .claude/skills must not exist. The check fails and names it. Nothing is
#   deleted: the folder may be a developer's own work.
#
# Pinned mode (.claude/skills.sha256 present):
#   Only the files listed in the manifest may exist under .claude/skills, and
#   each must match its SHA-256. Extra files, missing files, symlinks and hash
#   mismatches fail. A SKILL.md whose frontmatter declares `hooks` or
#   `allowed-tools` fails too, as does an executable script (a shebang, a
#   `.sh` file, or an executable bit). A path listed in
#   .claude/skills-allowlist.txt is the only exception. A skill here is
#   instructions, and may not run a command by itself or approve its own tools.
#
#   verify-agent-skills.sh          verify
#   verify-agent-skills.sh update   rewrite the manifest from the files on
#                                   disk, then verify
#
# Trust root is git and CODEOWNERS review of the manifest and the skills
# (/.claude/). The check runs on ./yarn, pre-commit and security-checks.sh. It
# does not stop an agent from loading a skill before the next check.
#
# POSIX sh so Alpine (no bash) Docker installs can run this via ./yarn.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT"

MANIFEST=".claude/skills.sha256"
SKILLS_DIR=".claude/skills"
ALLOWLIST=".claude/skills-allowlist.txt"

MODE=${1:-verify}
case "$MODE" in
  verify | update) ;;
  *)
    echo "Usage: $0 [verify|update]" >&2
    exit 2
    ;;
esac

# sha256sum (Linux) or shasum (macOS) first, so repos without a Node
# toolchain can verify pins; node is a fallback.
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    _h=$(sha256sum "$1") || return 1
  elif command -v shasum >/dev/null 2>&1; then
    _h=$(shasum -a 256 "$1") || return 1
  elif command -v node >/dev/null 2>&1; then
    _h=$(node -e "const fs=require('node:fs');const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$1") || return 1
  else
    printf '%s\n' "Error: need sha256sum, shasum or node to hash $1" >&2
    return 1
  fi
  printf '%s' "${_h%% *}"
}

fail_msg() {
  printf '%b\n' "${RED}$1${NC}" >&2
}

# Fails when anything on the way to the skills is a symlink.
refuse_symlinks() {
  if [ -L .claude ] || [ -L "$MANIFEST" ] || [ -L "$SKILLS_DIR" ] || [ -L "$ALLOWLIST" ]; then
    fail_msg "SECURITY: refusing a symlinked .claude, ${SKILLS_DIR}, ${MANIFEST} or ${ALLOWLIST}"
    exit 1
  fi
  if [ -d "$SKILLS_DIR" ]; then
    SYMS=$(find -P "$SKILLS_DIR" -type l 2>/dev/null || true)
    if [ -n "$SYMS" ]; then
      fail_msg "SECURITY: symlinks under ${SKILLS_DIR}/ are not allowed:"
      printf '%s\n' "$SYMS" >&2
      exit 1
    fi
  fi
}

list_skill_files() {
  if [ -d "$SKILLS_DIR" ]; then
    find -P "$SKILLS_DIR" -type f -print | sed 's|^\./||' | sort
  fi
}

# Prints the frontmatter keys of $1 that a skill here may not declare.
banned_frontmatter_keys() {
  awk '
    { sub(/\r$/, "") }
    NR == 1 { if ($0 != "---") exit; next }
    $0 == "---" { exit }
    /^(hooks|allowed-tools)[ \t]*:/ { sub(/[ \t]*:.*/, ""); print }
  ' "$1"
}

# A file the agent can be told to run: executable bit, shebang, or a shell name.
is_executable_script() {
  if [ -x "$1" ]; then
    return 0
  fi
  case "$1" in
    *.sh) return 0 ;;
  esac
  first=$(head -n 1 "$1" 2>/dev/null || true)
  case "$first" in
    '#!'*) return 0 ;;
  esac
  return 1
}

if [ "$MODE" = update ]; then
  refuse_symlinks
  FILES=$(list_skill_files)
  if [ -z "$FILES" ]; then
    fail_msg "Error: no files under ${SKILLS_DIR}/ to pin. For absent mode, delete ${MANIFEST} if present."
    exit 1
  fi
  {
    echo "# Agent skills integrity (closed world)."
    echo "# Regenerate after a deliberate skill change:"
    echo "#   ./scripts/security/verify-agent-skills.sh update"
    echo "# Commit the skill and this file together; CODEOWNERS review required."
    echo "#"
    printf '%s\n' "$FILES" | while IFS= read -r path; do
      # sha256sum-compatible: hash, two spaces, path
      printf '%s  %s\n' "$(sha256_file "$path")" "$path"
    done
  } >"$MANIFEST"
  printf '%b\n' "${GREEN}Wrote ${MANIFEST}${NC}"
  printf '%b\n' "${YELLOW}Commit the skills and the manifest together; CODEOWNERS review required.${NC}"
fi

# --- Absent mode ---
if [ ! -e "$MANIFEST" ] && [ ! -L "$MANIFEST" ]; then
  if [ -e "$SKILLS_DIR" ] || [ -L "$SKILLS_DIR" ]; then
    fail_msg "SECURITY: ${SKILLS_DIR}/ is present without ${MANIFEST}."
    fail_msg "An agent loads every skill in that folder. Nothing was deleted."
    printf '%b\n' "${YELLOW}If you did not create it, treat this machine as suspect and delete the folder.${NC}" >&2
    printf '%b\n' "${YELLOW}To keep it, review each file and run ./scripts/security/verify-agent-skills.sh update.${NC}" >&2
    exit 1
  fi
  # Silent success — this runs on every ./yarn; do not print (pollutes command substitution).
  exit 0
fi

# --- Pinned mode ---
refuse_symlinks

EXPECTED_TMP=$(mktemp)
ALLOW_TMP=$(mktemp)
trap 'rm -f "$EXPECTED_TMP" "$ALLOW_TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# One path per line. Comments and blank lines are skipped. A listed path may
# declare hooks or allowed-tools, or be an executable script. Nothing else may.
if [ -f "$ALLOWLIST" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    cr=$(printf '\r')
    case "$line" in
      *"$cr") line=${line%"$cr"} ;;
    esac
    case "$line" in
      '' | \#*) continue ;;
    esac
    case "$line" in
      .claude/skills/*) ;;
      *)
        fail_msg "Error: ${ALLOWLIST} lists a path outside ${SKILLS_DIR}/: ${line}"
        exit 1
        ;;
    esac
    case "$line" in
      *..*)
        fail_msg "Error: ${ALLOWLIST} lists a path that is not a file under ${SKILLS_DIR}/: ${line}"
        exit 1
        ;;
    esac
    printf '%s\n' "$line" >>"$ALLOW_TMP"
  done <"$ALLOWLIST"
fi

path_allowlisted() {
  want=$1
  [ -s "$ALLOW_TMP" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$line" = "$want" ] && return 0
  done <"$ALLOW_TMP"
  return 1
}

# Manifest lines are "hash<two spaces>path". Comments and blank lines are skipped.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | \#*) continue ;;
  esac
  hash=${line%%  *}
  path=${line#*  }
  if [ "$hash" = "$line" ] || [ -z "$path" ]; then
    fail_msg "Error: malformed line in ${MANIFEST}: ${line}"
    exit 1
  fi
  if ! printf '%s\n' "$hash" | grep -Eq '^[a-f0-9]{64}$'; then
    fail_msg "Error: invalid SHA-256 in ${MANIFEST} for ${path}"
    exit 1
  fi
  case "$path" in
    *..* | */)
      fail_msg "Error: ${MANIFEST} lists a path that is not a file under ${SKILLS_DIR}/: ${path}"
      exit 1
      ;;
    .claude/skills/*) ;;
    *)
      fail_msg "Error: ${MANIFEST} may only list files under ${SKILLS_DIR}/, got ${path}"
      exit 1
      ;;
  esac
  printf '%s\t%s\n' "$hash" "$path" >>"$EXPECTED_TMP"
done <"$MANIFEST"

if [ ! -s "$EXPECTED_TMP" ]; then
  fail_msg "Error: ${MANIFEST} has no hash entries. Delete it for absent mode, or run verify-agent-skills.sh update."
  exit 1
fi

fail=0
PRESENT=$(list_skill_files)

# Every present file must be listed and match.
while IFS= read -r path || [ -n "$path" ]; do
  [ -n "$path" ] || continue
  exp=$(awk -F '\t' -v p="$path" '$2 == p {print $1; exit}' "$EXPECTED_TMP")
  if [ -z "$exp" ]; then
    fail_msg "SECURITY: unpinned agent skill file present: ${path}"
    printf '%b\n' "${YELLOW}Delete it, or review it and run ./scripts/security/verify-agent-skills.sh update.${NC}" >&2
    fail=1
    continue
  fi
  act=$(sha256_file "$path")
  if [ "$act" != "$exp" ]; then
    fail_msg "SECURITY: agent skill hash mismatch: ${path}"
    echo "  Expected: $exp" >&2
    echo "  Actual:   $act" >&2
    printf '%b\n' "${YELLOW}If this was intentional, run ./scripts/security/verify-agent-skills.sh update and get CODEOWNERS review.${NC}" >&2
    fail=1
  fi
  case "$path" in
    */SKILL.md)
      keys=$(banned_frontmatter_keys "$path")
      if [ -n "$keys" ] && ! path_allowlisted "$path"; then
        fail_msg "SECURITY: ${path} declares $(printf '%s' "$keys" | tr '\n' ' ')in its frontmatter."
        printf '%b\n' "${YELLOW}A skill here is instructions only: no hooks, and no tools it approves for itself. List the path in ${ALLOWLIST} only after review.${NC}" >&2
        fail=1
      fi
      ;;
  esac
  if is_executable_script "$path" && ! path_allowlisted "$path"; then
    fail_msg "SECURITY: ${path} is an executable script and is not in ${ALLOWLIST}."
    printf '%b\n' "${YELLOW}A skill here is instructions only. List the path in ${ALLOWLIST} only after review.${NC}" >&2
    fail=1
  fi
done <<EOF
$PRESENT
EOF

# Every listed file must be present.
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  path=$(printf '%s\n' "$line" | cut -f2)
  if [ ! -f "$path" ]; then
    fail_msg "SECURITY: pinned agent skill file missing: ${path}"
    fail=1
  fi
done <"$EXPECTED_TMP"

if [ "$fail" -ne 0 ]; then
  fail_msg "Agent skills integrity check failed."
  exit 1
fi

# Silent success — this runs on every ./yarn; do not print (pollutes command substitution).
exit 0
