#!/bin/sh

# Comments are banned in JS/TS source. The few that are left are recorded in
# scripts/comments-baseline.txt. A comment that is not in that file fails.
#
#   ./scripts/lint-comments.sh          check the working tree (CI)
#   ./scripts/lint-comments.sh check --staged
#                                       check what is staged (pre-commit): the
#                                       files and the baseline as they are in
#                                       the index, not on disk. The line count
#                                       is compared with HEAD.
#   ./scripts/lint-comments.sh update   rewrite the baseline so it matches the
#                                       tree, including a new hash. Refuses
#                                       when that would have more lines than
#                                       HEAD. With no baseline at HEAD, this
#                                       is adoption and records every comment.
#   ./scripts/lint-comments.sh list     every counted comment as JSON lines
#
# CI reads only the working tree: every comment is in the baseline, and the
# baseline lists nothing that is gone. It does not compare with another
# commit. The baseline is under CODEOWNERS (/scripts/), so a pull request that
# makes it longer needs owner review. Locally, update and pre-commit refuse a
# baseline with more lines than HEAD; a new hash at the same count passes.
#
# Not counted: tool directives (biome-ignore, @ts-expect-error, @ts-ignore,
# @ts-nocheck, /// <reference, PURE annotations, Lingui i18n markers), JSDoc
# blocks carrying @deprecated / @private / @package / @internal (tools read
# them), and comments that start with "Backwards compatibility".
#
# A comment is matched by a hash of its text, wherever it sits, so moving a
# file or a comment needs only `update`. Editing its text changes the hash;
# `update` records the new one when the line count does not grow. Carriage
# returns and trailing whitespace are stripped before hashing, and runs of
# whitespace count as one space, so CRLF and LF checkouts give the same hash.
#
# Runs before install: POSIX sh entrypoint, embedded Node stdlib program, no
# packages. The scanner is not a parser: `//` in JSX text is read as a comment
# unless a colon comes right before it (URLs). Its rules are tested by
# scripts/lint-comments-fixtures.sh.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ROOT"

usage() {
  printf '%b\n' "${RED}Usage: lint-comments.sh [check [--staged]|update|list]${NC}" >&2
  exit 1
}

MODE=${1:-check}
STAGED=0
case "$MODE" in
  check | update | list) ;;
  *) usage ;;
esac
case "${2:-}" in
  '') ;;
  --staged)
    [ "$MODE" = check ] || usage
    STAGED=1
    ;;
  *) usage ;;
esac

BASELINE=scripts/comments-baseline.txt
WORK=$(mktemp -d)
SCAN_JS="$WORK/scan.cjs"
FILE_LIST="$WORK/files"
HEAD_LIST="$WORK/head-baseline"
STAGE_DIR="$WORK/index"
# EXIT cleans up. INT/TERM must exit explicitly under POSIX.
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Where the files are read from: the working tree, or a copy of the index.
# The list is NUL-separated (-z): without it git quotes a name that has a
# non-ASCII character, a quote or a backslash, and the file would not be found.
SCAN_ROOT=.
if [ "$STAGED" -eq 1 ]; then
  # Untracked files and unstaged edits are not part of the commit, so they are
  # not read. Only source files and the baseline are copied out of the index.
  mkdir "$STAGE_DIR"
  git ls-files -z --cached >"$FILE_LIST"
  git ls-files --cached -z -- "$BASELINE" \
    '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' |
    git checkout-index -z --stdin --prefix="$STAGE_DIR/"
  SCAN_ROOT=$STAGE_DIR
else
  git ls-files -z --cached --others --exclude-standard >"$FILE_LIST"
fi

# pre-commit and update compare the line count with HEAD. No file at HEAD is
# adoption (the first baseline, or a repository
# that has not adopted the gate).
HEAD_ARG=''
if [ "$MODE" = update ] || [ "$STAGED" -eq 1 ]; then
  if git rev-parse --verify -q 'HEAD^{commit}' >/dev/null 2>&1 &&
    git cat-file -e "HEAD:${BASELINE}" 2>/dev/null
  then
    git show "HEAD:${BASELINE}" >"$HEAD_LIST"
    HEAD_ARG=$HEAD_LIST
  fi
fi

cat >"$SCAN_JS" <<'EOF'
const fs = require("node:fs");
const crypto = require("node:crypto");

const path = require("node:path");

const [mode, fileListPath, baselineName, root, headBaselinePath] = process.argv.slice(2);
const baselinePath = path.join(root, baselineName);

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIPPED = /(^|\/)(node_modules|\.yarn|vendor|patches)\/|(^|\/)\.pnp\.|\.d\.ts$/;
const REGEX_AFTER = new Set([
  "return", "typeof", "case", "do", "else", "in", "of", "void", "delete", "throw", "new",
  "yield", "await", "instanceof",
]);
const TOOL_DIRECTIVE =
  /^(biome-ignore\b|@ts-(expect-error|ignore|nocheck)\b|\/\s*<reference\s|[#@]__PURE__|i18n\b)/;
const JSDOC_TOOL_TAG = /(^|\s)@(deprecated|private|package|internal)\b/;
const BACKWARDS_COMPAT = /^backwards?[- ]compat/i;

function scan(text) {
  const comments = [];
  const templates = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let prev = "op";
  let prevChar = "";

  function countLines(from, to) {
    for (let k = from; k < to; k++) if (text.charCodeAt(k) === 10) line++;
  }

  function templateBody() {
    const start = i;
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        i++;
        countLines(start, i);
        prev = "value";
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        i += 2;
        countLines(start, i);
        templates.push(0);
        prev = "op";
        return;
      } else {
        i++;
      }
    }
    countLines(start, n);
  }

  if (text.startsWith("#!")) {
    while (i < n && text[i] !== "\n") i++;
  }

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\n") {
      line++;
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (c === "/" && next === "/" && text[i - 1] === ":") {
      i += 2;
    } else if (c === "/" && next === "/") {
      const start = i;
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
      comments.push({ line, endLine: line, start, end: i });
    } else if (c === "/" && next === "*") {
      const start = i;
      const startLine = line;
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      countLines(start, i);
      comments.push({ line: startLine, endLine: line, start, end: i });
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      if (text[i] === c) i++;
      prev = "value";
    } else if (c === "`") {
      i++;
      templateBody();
    } else if (c === "/") {
      let end = -1;
      if (prev !== "value" && prevChar !== "<" && next !== ">") {
        let k = i + 1;
        let inClass = false;
        while (k < n && text[k] !== "\n") {
          const r = text[k];
          if (r === "\\") k++;
          else if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) {
            end = k + 1;
            break;
          }
          k++;
        }
      }
      if (end === -1) {
        i++;
        prev = "op";
        prevChar = c;
      } else {
        i = end;
        while (i < n && /[a-z]/.test(text[i])) i++;
        prev = "value";
        prevChar = "";
      }
    } else if (/[A-Za-z0-9_$]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(text[i])) i++;
      prev = REGEX_AFTER.has(text.slice(start, i)) ? "op" : "value";
      prevChar = "";
    } else {
      if (c === "{" && templates.length > 0) {
        templates[templates.length - 1]++;
      } else if (c === "}" && templates.length > 0) {
        if (templates[templates.length - 1] === 0) {
          templates.pop();
          i++;
          templateBody();
          continue;
        }
        templates[templates.length - 1]--;
      }
      prev = c === ")" || c === "]" || c === "}" ? "value" : "op";
      prevChar = c;
      i++;
    }
  }
  return comments;
}

function inner(raw) {
  if (raw.startsWith("//")) return raw.slice(2).trim();
  return raw
    .slice(2, raw.endsWith("*/") ? -2 : undefined)
    .split("\n")
    .map((l) => l.replace(/^\s*\*+\s?/, "").trim())
    .join("\n")
    .trim();
}

function isExempt(raw) {
  const body = inner(raw);
  if (TOOL_DIRECTIVE.test(body) || BACKWARDS_COMPAT.test(body)) return true;
  return raw.startsWith("/**") && JSDOC_TOOL_TAG.test(body);
}

function hash(raw) {
  const text = raw
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

const files = fs
  .readFileSync(fileListPath, "utf8")
  .split("\0")
  .filter((f) => SOURCE.test(f) && !SKIPPED.test(f) && fs.existsSync(path.join(root, f)))
  .sort();

const found = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  for (const c of scan(text)) {
    const raw = text.slice(c.start, c.end);
    if (isExempt(raw)) continue;
    found.push({ file, line: c.line, endLine: c.endLine, hash: hash(raw), text: raw });
  }
}

if (mode === "list") {
  fs.writeFileSync(1, found.map((c) => `${JSON.stringify(c)}\n`).join(""));
  process.exit(0);
}

function readBaseline(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean);
}

function countByHash(lines) {
  const counts = new Map();
  for (const l of lines) {
    const h = l.slice(0, 12);
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return counts;
}

const baselineMissing = !fs.existsSync(baselinePath);
const baselineLines = baselineMissing ? [] : readBaseline(baselinePath);
const allowance = countByHash(baselineLines);
const added = [];
for (const c of found) {
  const left = allowance.get(c.hash) ?? 0;
  if (left > 0) allowance.set(c.hash, left - 1);
  else added.push(c);
}
const current = found
  .map((c) => `${c.hash} ${c.file}`)
  .sort()
  .join("\n");
const stale = current !== baselineLines.join("\n");

function failDeleted(compared, comparedCount) {
  console.error(
    `The baseline was deleted and the tree has more comments (${found.length}) than ${compared} lists (${comparedCount}). ` +
      "Deleting the file and regenerating it records every comment, including new ones, so a larger result fails.",
  );
  for (const c of found) {
    console.error(`  ${c.file}:${c.line}  ${c.text.split("\n")[0].slice(0, 90)}`);
  }
  process.exit(3);
}

function failGained(compared, comparedCount, hereCount) {
  console.error(
    `The baseline gained lines (${comparedCount} on ${compared}, ${hereCount} here). ` +
      "A new hash is allowed only when the line count does not grow.",
  );
  process.exit(3);
}

if (mode === "update") {
  if (headBaselinePath) {
    const headLines = readBaseline(headBaselinePath);
    if (found.length > headLines.length) {
      console.error(
        `The baseline would grow (${headLines.length} at HEAD, ${found.length} now). ` +
          "A new comment is allowed only when the line count does not grow. " +
          "Deleting the baseline and regenerating it follows the same rule.",
      );
      process.exit(1);
    }
  }
  fs.writeFileSync(baselinePath, current === "" ? "" : `${current}\n`);
  console.log(`Baseline: ${found.length} comments (was ${baselineLines.length}).`);
  process.exit(0);
}
if (headBaselinePath && baselineMissing) {
  const headLines = readBaseline(headBaselinePath);
  if (found.length > headLines.length) failDeleted("HEAD", headLines.length);
}
if (added.length > 0) {
  console.error(`New comments (${added.length}). Comments are banned: say it in code, or in an ADR.`);
  for (const c of added) {
    console.error(`  ${c.file}:${c.line}  ${c.text.split("\n")[0].slice(0, 90)}`);
  }
  process.exit(1);
}
if (stale) {
  console.error(
    `Baseline is out of date (${baselineLines.length} recorded, ${found.length} found). ` +
      "Run ./scripts/lint-comments.sh update and commit the result.",
  );
  process.exit(2);
}
if (headBaselinePath && baselineLines.length > readBaseline(headBaselinePath).length) {
  const headLines = readBaseline(headBaselinePath);
  failGained("HEAD", headLines.length, baselineLines.length);
}
console.log(`${found.length} comments left in the baseline. No new comments.`);
EOF

STATUS=0
node "$SCAN_JS" "$MODE" "$FILE_LIST" "$BASELINE" "$SCAN_ROOT" "$HEAD_ARG" || STATUS=$?

if [ "$MODE" = list ]; then
  exit "$STATUS"
fi
if [ "$STATUS" -ne 0 ]; then
  printf '%b\n' "${RED}Comment check failed.${NC}" >&2
  exit 1
fi
printf '%b\n' "${GREEN}Comment check passed.${NC}"
echo ""
