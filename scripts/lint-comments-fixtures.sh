#!/bin/sh

# Tests for scripts/lint-comments.sh. POSIX sh. Each case writes source files
# into a throwaway git repository that holds a copy of the script, so the
# rules tested are the rules that run.
#
# The inputs are written from here and not committed as .ts files: a committed
# fixture with a comment in it would be counted by the gate itself.
#
#   1. What the scanner counts as a comment (`list`).
#   2. What check and update accept: a new hash at the same line count, a
#      baseline that gained lines against the base branch or against HEAD,
#      a deleted baseline that comes back larger, staged against unstaged
#      content.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# A pre-commit hook may run this, and git gives a hook its own variables.
# With them set, the git commands below would act on the repository being
# committed to instead of the temporary ones.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/scripts/lint-comments.sh"
FAILED=0
CASES=0

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git_q() {
  git -c user.name=fixture -c user.email=fixture@example.invalid \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    -c core.autocrlf=false "$@" >/dev/null 2>&1
}

new_repo() {
  REPO="$WORK/$1"
  mkdir -p "$REPO/scripts" "$REPO/src"
  cp "$SCRIPT" "$REPO/scripts/lint-comments.sh"
  (cd "$REPO" && git_q init)
}

# Runs the copied script with CI's variables cleared, so a case decides them.
# GITHUB_TOKEN is cleared too: a real token would make a missing-sha case fetch.
run_gate() {
  (cd "$REPO" && GITHUB_EVENT_NAME="${CASE_EVENT:-}" COMMENTS_BASE_REV="${CASE_BASE:-}" \
    PR_BASE_SHA="${CASE_SHA:-}" GITHUB_TOKEN="${CASE_TOKEN:-}" \
    ./scripts/lint-comments.sh "$@" 2>&1)
}

ok() {
  CASES=$((CASES + 1))
  printf 'pass %s\n' "$1"
}

bad() {
  CASES=$((CASES + 1))
  FAILED=1
  printf '%b\n' "${RED}FAIL $1${NC}" >&2
  shift
  printf '  %s\n' "$@" >&2
}

# $1 case name, $2 the comments expected from src/case.ts, joined by " | ".
# The file content comes on stdin.
expect_list() {
  name=$1
  want=$2
  cat >"$REPO/src/case.ts"
  got=$(run_gate list | node -e '
    const lines = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
    const texts = lines.map((l) => JSON.parse(l)).filter((c) => c.file === "src/case.ts");
    process.stdout.write(texts.map((c) => c.text.replace(/\s+/g, " ").trim()).join(" | "));
  ')
  if [ "$got" = "$want" ]; then
    ok "list: $name"
  else
    bad "list: $name" "expected: $want" "got:      $got"
  fi
}

# Writes a baseline that matches the tree, without going through update.
# Used where the test is the ratchet, not update's own refusal.
write_matching_baseline() {
  run_gate list | node -e '
    const fs = require("node:fs");
    const lines = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
    const out = lines
      .map((l) => {
        const c = JSON.parse(l);
        return c.hash + " " + c.file;
      })
      .sort()
      .join("\n");
    process.stdout.write(out === "" ? "" : out + "\n");
  ' >"$REPO/scripts/comments-baseline.txt"
}

# $1 case name, $2 pass|fail, $3 text the output must contain ('' for none),
# then the script's arguments.
expect_gate() {
  name=$1
  want=$2
  text=$3
  shift 3
  if out=$(run_gate "$@"); then
    got=pass
  else
    got=fail
  fi
  if [ "$got" != "$want" ]; then
    bad "$name" "expected the gate to $want, it did not:" "$out"
  elif [ -n "$text" ] && ! printf '%s\n' "$out" | grep -qF "$text"; then
    bad "$name" "expected output with: $text" "got: $out"
  else
    ok "$name"
  fi
}

# --- 1. What the scanner counts ---

new_repo scanner

expect_list 'line and block comments' '// one | /* two */ | /** three */' <<'EOF'
const a = 1; // one
/* two */
/** three */
export const b = a;
EOF

expect_list 'division, then a comment' '// c' <<'EOF'
const c = a / b // c
EOF

expect_list 'a regex with a slash in a class' '' <<'EOF'
const r = /[/]\/\/x/g;
const s = text.replace(/\/\/+/, "/");
EOF

expect_list 'slashes inside strings' '' <<'EOF'
const u = "https://example.com//path";
const v = 'a // b';
const w = "say \"hi\" // still a string";
EOF

expect_list 'a URL in JSX text' '' <<'EOF'
const link = <a href={url}>wc://connect</a>;
const text = <p>See https://example.com</p>;
EOF

expect_list 'nested templates' '' <<'EOF'
const t = `a ${ `b ${c} // not a comment` } // still not`;
const u = `${a}${`${b}/*not*/`}`;
EOF

expect_list 'a comment inside a template expression' '/* inner */ | // after' <<'EOF'
const t = `a ${ b /* inner */ } c`; // after
EOF

expect_list 'braces inside a template expression' '// end' <<'EOF'
const t = `x ${ { a: 1 }.a } // not ${ [1].map((n) => { return n; }) }`; // end
EOF

expect_list 'tool directives are not counted' '' <<'EOF'
/// <reference types="node" />
// biome-ignore lint/suspicious/noExplicitAny: fixture
// @ts-expect-error fixture
// @ts-ignore
const p = /* #__PURE__ */ make();
/* @__PURE__ */ make();
EOF

expect_list 'JSDoc that tools read is not counted' '/** plain */ | /* @deprecated not JSDoc */' <<'EOF'
/** @deprecated use b */
/**
 * Old entry point.
 * @internal
 */
/** plain */
/* @deprecated not JSDoc */
EOF

expect_list 'backwards-compatibility markers are not counted' '// Compatibility with nothing' <<'EOF'
// Backwards compatibility: clients before 2.0 send a string
/* Backward-compat: remove with v1 */
// Compatibility with nothing
EOF

expect_list 'a shebang line' '// real' <<'EOF'
#!/usr/bin/env node
const a = 1; // real
EOF

expect_list 'a block comment is not nested' '/* outer /* inner */ | // after the block' <<'EOF'
/* outer /* inner */ // after the block
const a = 1;
EOF

mkdir -p "$REPO/vendor" "$REPO/node_modules/x" "$REPO/patches"
echo '// vendored' >"$REPO/vendor/lib.js"
echo '// dependency' >"$REPO/node_modules/x/index.js"
echo '// patch' >"$REPO/patches/fix.js"
echo '// declaration' >"$REPO/src/types.d.ts"
echo '// not source' >"$REPO/src/notes.md"
expect_list 'vendor, node_modules, patches, .d.ts and other files are skipped' '// kept' <<'EOF'
const a = 1; // kept
EOF
if run_gate list | grep -qE 'vendored|dependency|patch|declaration|not source'; then
  bad 'list: skipped paths stay out of the whole list' "$(run_gate list)"
else
  ok 'list: skipped paths stay out of the whole list'
fi

printf 'const a = 1; // named\n' >"$REPO/src/métadonnées.ts"
printf 'const a = 1; // named\n' >"$REPO/src/a \"quoted\" name.ts"
(cd "$REPO" && git_q add -A)
names=$(run_gate list | grep -c '// named' || true)
staged_names=$(run_gate check --staged | grep -c '// named' || true)
if [ "$names" = 2 ] && [ "$staged_names" = 2 ]; then
  ok 'list: files with non-ASCII and quoted names are read'
else
  bad 'list: files with non-ASCII and quoted names are read' "listed: $names of 2, staged: $staged_names of 2"
fi
(cd "$REPO" && git_q rm -f --cached -r . && rm "$REPO/src/métadonnées.ts" "$REPO/src/a \"quoted\" name.ts")

printf 'const a = 1; // same text  \r\nconst b = 2; //   same   text\r\n' >"$REPO/src/crlf.ts"
printf 'const a = 1; // same text\n' >"$REPO/src/lf.ts"
hashes=$(run_gate list | node -e '
  const lines = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
  const set = new Set(lines.map((l) => JSON.parse(l)).filter((c) => /lf\.ts$/.test(c.file)).map((c) => c.hash));
  process.stdout.write(String(set.size));
')
if [ "$hashes" = 1 ]; then
  ok 'list: CRLF, LF and trailing spaces give one hash'
else
  bad 'list: CRLF, LF and trailing spaces give one hash' "distinct hashes: $hashes"
fi

# --- 2. What check and update accept ---

new_repo gate
printf 'export const a = 1; // first\nexport const b = 2; /* second */\n' >"$REPO/src/a.ts"
printf 'export const c = 3;\n' >"$REPO/src/b.ts"

expect_gate 'check without a baseline fails on every comment' fail 'New comments (2)'
expect_gate 'update records every comment when there is no baseline' pass 'Baseline: 2 comments' update
expect_gate 'check passes with the recorded baseline' pass '2 comments left'
(cd "$REPO" && git_q add -A && git_q commit -m baseline)

printf 'export const c = 3; // new\n' >"$REPO/src/b.ts"
expect_gate 'check fails on a new comment' fail 'src/b.ts:1'
expect_gate 'update refuses a comment that grows the baseline' fail 'would grow' update
if (cd "$REPO" && git diff --quiet -- scripts/comments-baseline.txt); then
  ok 'a refused update leaves the baseline alone'
else
  bad 'a refused update leaves the baseline alone' 'the baseline changed'
fi

printf 'export const c = 3;\n' >"$REPO/src/b.ts"
printf 'export const a = 1; // first\nexport const b = 2; // kept\n' >"$REPO/src/a.ts"
expect_gate 'update records a new hash when the line count stays the same' pass 'Baseline: 2 comments (was 2)' update
expect_gate 'check passes after a same-count hash change' pass '2 comments left'
CASE_BASE=HEAD expect_gate 'a same-count new hash passes against HEAD' pass '2 comments left'
(cd "$REPO" && git_q add -A && git_q commit -m replaced)

printf 'export const c = 3; // first\n' >"$REPO/src/b.ts"
expect_gate 'a second copy of a recorded comment is a new comment' fail 'New comments (1)'

printf 'export const c = 3; // new\n' >"$REPO/src/b.ts"
rm "$REPO/scripts/comments-baseline.txt"
expect_gate 'update refuses a deleted baseline that would come back larger' fail 'would grow' update
if [ ! -f "$REPO/scripts/comments-baseline.txt" ]; then
  ok 'a refused regeneration does not recreate the baseline'
else
  bad 'a refused regeneration does not recreate the baseline' 'the file was written'
fi
CASE_BASE=HEAD expect_gate 'a deleted baseline with more comments than the base fails' fail 'was deleted'

write_matching_baseline
expect_gate 'check alone accepts a hand-grown baseline' pass '3 comments left'
CASE_BASE=HEAD expect_gate 'check against the base branch refuses the grown baseline' fail 'gained lines'
CASE_EVENT=pull_request expect_gate 'a pull request without a base sha fails' fail 'not 40 lowercase hex'
CASE_EVENT=pull_request CASE_SHA=0123456789abcdef0123456789abcdef01234567 \
  expect_gate 'a pull request whose base sha is not local fails without a token' fail 'no token to fetch it'
(cd "$REPO" && git_q add -A && git_q commit -m grown)
CASE_EVENT=pull_request CASE_SHA=$(git -C "$REPO" rev-parse 'HEAD^1') \
  expect_gate 'a pull request is compared with the base sha' fail 'gained lines'
CASE_EVENT=push expect_gate 'a push compares the baseline with the parent' fail 'parent commit'
CASE_EVENT=workflow_dispatch expect_gate 'a manual run compares the baseline with the parent' fail 'parent commit'
CASE_BASE='HEAD^1' expect_gate 'COMMENTS_BASE_REV names the base' fail 'gained lines'

printf 'export const c = 3;\n' >"$REPO/src/b.ts"
expect_gate 'check fails when a recorded comment is gone' fail 'Baseline is out of date'
expect_gate 'update shrinks the baseline' pass 'Baseline: 2 comments (was 3)' update
CASE_BASE=HEAD expect_gate 'a shrunk baseline passes against the base branch' pass '2 comments left'

(cd "$REPO" && git mv src/a.ts src/moved.ts)
expect_gate 'a moved file makes the baseline out of date' fail 'Baseline is out of date'
expect_gate 'update follows a moved file' pass 'Baseline: 2 comments (was 2)' update
CASE_BASE=HEAD expect_gate 'a moved comment is not a new entry' pass ''
(cd "$REPO" && git_q add -A && git_q commit -m moved)

new_repo adoption
printf 'export const a = 1;\n' >"$REPO/src/a.ts"
(cd "$REPO" && git_q add -A && git_q commit -m first)
printf 'export const a = 1; // old\n' >"$REPO/src/a.ts"
run_gate update >/dev/null
CASE_BASE=HEAD expect_gate 'a base branch without a baseline is adoption' pass '1 comments left'
CASE_EVENT=push expect_gate 'a push with no parent skips the ratchet' pass 'skipped'
CASE_EVENT=workflow_dispatch expect_gate 'a manual run with no parent skips the ratchet' pass 'skipped'

new_repo regenerated
printf 'export const a = 1; // first\nexport const b = 2; // second\n' >"$REPO/src/a.ts"
run_gate update >/dev/null
(cd "$REPO" && git_q add -A && git_q commit -m baseline)
rm "$REPO/scripts/comments-baseline.txt"
printf 'export const a = 1; // first\nexport const b = 2; // edited\n' >"$REPO/src/a.ts"
expect_gate 'update regenerates a deleted baseline when the count does not grow' pass 'Baseline: 2 comments (was 0)' update
CASE_BASE=HEAD expect_gate 'a same-size regenerated baseline passes against HEAD' pass '2 comments left'
rm "$REPO/scripts/comments-baseline.txt"
printf 'export const c = 3; // third\n' >>"$REPO/src/a.ts"
expect_gate 'update refuses a regeneration that is larger than HEAD' fail 'would grow' update
if [ ! -f "$REPO/scripts/comments-baseline.txt" ]; then
  ok 'the larger regeneration is not written'
else
  bad 'the larger regeneration is not written' 'the file was written'
fi

# --- Staged content (pre-commit) ---

new_repo staged
printf 'export const a = 1; // first\n' >"$REPO/src/a.ts"
run_gate update >/dev/null
(cd "$REPO" && git_q add -A && git_q commit -m baseline)

printf '// scratch\n' >"$REPO/src/scratch.ts"
expect_gate 'check reads an untracked file' fail 'src/scratch.ts:1'
expect_gate 'check --staged does not read an untracked file' pass '1 comments left' check --staged
rm "$REPO/src/scratch.ts"

printf 'export const a = 1; // first\nexport const b = 2; // staged\n' >"$REPO/src/a.ts"
(cd "$REPO" && git_q add src/a.ts)
printf 'export const a = 1;\nexport const b = 2; // staged\n' >"$REPO/src/a.ts"
expect_gate 'check --staged reads the staged content, not the file on disk' fail 'New comments (1)' check --staged
(cd "$REPO" && git_q reset --hard)

(cd "$REPO" && git_q rm src/a.ts)
expect_gate 'check --staged fails when a staged deletion leaves the baseline stale' fail 'Baseline is out of date' check --staged
run_gate update >/dev/null
expect_gate 'check --staged reads the staged baseline, not the one on disk' fail 'Baseline is out of date' check --staged
(cd "$REPO" && git_q add -A)
expect_gate 'check --staged passes once the updated baseline is staged' pass '0 comments left' check --staged

mkdir -p "$REPO/src"
printf 'export const a = 1; // back\n' >"$REPO/src/a.ts"
write_matching_baseline
(cd "$REPO" && git_q add -A)
expect_gate 'check --staged allows a new hash at the same count as HEAD' pass '1 comments left' check --staged
printf 'export const b = 2; // more\n' >>"$REPO/src/a.ts"
write_matching_baseline
(cd "$REPO" && git_q add -A)
expect_gate 'check --staged fails when the staged baseline is larger than HEAD' fail 'gained lines' check --staged

expect_gate 'update --staged is refused' fail 'Usage' update --staged
expect_gate 'an unknown mode is refused' fail 'Usage' everything

# --- The pre-commit hook's own decision (deletions, baseline-only, index) ---

install_hook() {
  mkdir -p "$REPO/scripts/security" "$REPO/.git-hooks"
  cp "$ROOT/.git-hooks/pre-commit" "$REPO/.git-hooks/pre-commit"
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$REPO/scripts/security/block-ide-autostart-hooks.sh"
  printf '%s\n' '#!/bin/sh' 'exit 1' >"$REPO/scripts/security/check-core-changes.sh"
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$REPO/scripts/security/verify-version-tags-if-changed.sh"
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$REPO/yarn"
  chmod +x "$REPO/scripts/security/block-ide-autostart-hooks.sh" \
    "$REPO/scripts/security/check-core-changes.sh" \
    "$REPO/scripts/security/verify-version-tags-if-changed.sh" \
    "$REPO/yarn" "$REPO/.git-hooks/pre-commit"
}

run_hook() {
  # Pre-commit, not the CI job. These fixtures run inside a pull_request
  # workflow, which would otherwise hand the hook an empty PR_BASE_SHA.
  (cd "$REPO" && env -u GITHUB_EVENT_NAME -u PR_BASE_SHA -u GITHUB_TOKEN -u COMMENTS_BASE_REV \
    ./.git-hooks/pre-commit 2>&1)
}

new_repo hook
install_hook
printf 'export const a = 1; // first\n' >"$REPO/src/a.ts"
run_gate update >/dev/null
(cd "$REPO" && git_q add -A && git_q commit -m baseline)

(cd "$REPO" && git_q rm src/a.ts)
if out=$(run_hook); then
  bad 'the hook fails when only a deletion of a baselined file is staged' "the hook passed: $out"
else
  if printf '%s\n' "$out" | grep -qF 'Baseline is out of date'; then
    ok 'the hook fails when only a deletion of a baselined file is staged'
  else
    bad 'the hook fails when only a deletion of a baselined file is staged' "$out"
  fi
fi
(cd "$REPO" && git_q reset --hard)

printf 'aaaaaaaaaaaa src/nope.ts\n' >>"$REPO/scripts/comments-baseline.txt"
(cd "$REPO" && git_q add scripts/comments-baseline.txt)
if out=$(run_hook); then
  bad 'the hook runs when only the baseline is staged' "the hook passed: $out"
else
  if printf '%s\n' "$out" | grep -qF 'Baseline is out of date'; then
    ok 'the hook runs when only the baseline is staged'
  else
    bad 'the hook runs when only the baseline is staged' "$out"
  fi
fi
(cd "$REPO" && git_q reset --hard)

printf 'export const z = 1;\n' >"$REPO/src/b.ts"
printf '// scratch\n' >"$REPO/src/scratch.ts"
(cd "$REPO" && git_q add src/b.ts)
if out=$(run_hook); then
  ok 'the hook ignores an untracked file when something else is staged'
else
  bad 'the hook ignores an untracked file when something else is staged' "$out"
fi
rm "$REPO/src/scratch.ts"
printf 'export const z = 1;\nexport const y = 2; // unstaged\n' >"$REPO/src/b.ts"
if out=$(run_hook); then
  ok 'the hook ignores an unstaged edit'
else
  bad 'the hook ignores an unstaged edit' "$out"
fi
(cd "$REPO" && git_q reset --hard)
printf 'export const a = 1; // first\nexport const b = 2; // more\n' >"$REPO/src/a.ts"
write_matching_baseline
(cd "$REPO" && git_q add src/a.ts scripts/comments-baseline.txt)
if out=$(run_hook); then
  bad 'the hook fails when the staged baseline is larger than HEAD' "the hook passed: $out"
else
  if printf '%s\n' "$out" | grep -qF 'gained lines'; then
    ok 'the hook fails when the staged baseline is larger than HEAD'
  else
    bad 'the hook fails when the staged baseline is larger than HEAD' "$out"
  fi
fi

# A depth-1 checkout does not contain the parent. With a token, the gate
# fetches that sha from origin and still applies the line-count ratchet.
new_repo fetchbase
printf 'export const a = 1; // one\n' >"$REPO/src/a.ts"
run_gate update >/dev/null
(cd "$REPO" && git_q add -A && git_q commit -m one)
fetch_base=$(git -C "$REPO" rev-parse HEAD)
printf 'export const b = 2; // two\n' >>"$REPO/src/a.ts"
write_matching_baseline
(cd "$REPO" && git_q add -A && git_q commit -m two)
git -C "$REPO" config uploadpack.allowReachableSHA1InWant true
git clone -q --depth 1 "file://$REPO" "$WORK/fetch-shallow"
REPO="$WORK/fetch-shallow"
CASE_EVENT=pull_request CASE_SHA="$fetch_base" CASE_TOKEN=dummy \
  expect_gate 'a missing base sha is fetched when a token is set' fail 'gained lines'

if [ "$FAILED" -ne 0 ]; then
  printf '%b\n' "${RED}lint-comments fixtures failed.${NC}" >&2
  exit 1
fi
printf '%b\n' "${GREEN}All ${CASES} lint-comments fixtures behaved as expected.${NC}"
