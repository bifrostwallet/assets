#!/bin/sh

# Every tsconfig declares exactly one of two module lanes, explicitly.
#
# Same idea as nodeLinker (pnp where possible, node-modules declared where
# not): there is a default lane and one declared exception, and the file says
# which one it is. No path or package-name exemptions.
#
#   NodeNext  module: NodeNext + moduleResolution: NodeNext
#             Node services, CLIs, scripts, tests (tsc -> dist -> node).
#   Bundler   module: Preserve + moduleResolution: Bundler
#             UI that a bundler emits: Vite web apps, Expo/Metro.
#
# A config that sets neither key passes only if it extends a local tsconfig
# ("./" or "../") that this scan also checks: the target must resolve (".json"
# added as tsc does) to a scanned tsconfig*.json outside node_modules/.yarn,
# so its own lane is checked here too. Extending a package config (e.g.
# expo/tsconfig.base, or ./node_modules/...) or a file the scan skips (e.g.
# ./config/base.json) is not enough: restate the lane. Casing is ignored (tsc
# accepts nodenext / NodeNext).
#
# Scans tracked and untracked (not ignored) tsconfig*.json files. Runs before
# install: POSIX sh entrypoint, embedded Node stdlib program, no packages.
# TSCONFIG_LANES_DIR points the scan at another directory (fixtures only).

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -n "${TSCONFIG_LANES_DIR:-}" ]; then
  ROOT=$TSCONFIG_LANES_DIR
else
  ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
fi
cd "$ROOT"

LANES_JS=$(mktemp)
FILE_LIST=$(mktemp)
# EXIT cleans up. INT/TERM must exit explicitly under POSIX.
trap 'rm -f "$LANES_JS" "$FILE_LIST"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "${TSCONFIG_LANES_DIR:-}" ]; then
  find . -type f | sed 's|^\./||' >"$FILE_LIST"
else
  git ls-files --cached --others --exclude-standard >"$FILE_LIST"
fi

cat >"$LANES_JS" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

// tsconfig is JSONC: drop comments and trailing commas outside strings.
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += n;
        i++;
      } else if (c === '"') {
        inString = false;
      }
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const files = fs
  .readFileSync(process.argv[2], "utf8")
  .split("\n")
  .filter((f) => /(^|\/)tsconfig(\.[^/]*)?\.json$/.test(f))
  .filter((f) => !/(^|\/)(node_modules|\.yarn)\//.test(f))
  .filter((f) => fs.existsSync(f));

const scanned = new Set(files.map((f) => path.normalize(f)));

// Resolve a local extends the way tsc does (".json" added when the path has
// no such file). Returns the normalized path, or null if it is not a scanned
// tsconfig (missing, outside the repo, under node_modules/.yarn, or a name
// the scan skips).
function localTarget(file, ext) {
  let target = path.normalize(path.join(path.dirname(file), ext));
  if (!fs.existsSync(target) && fs.existsSync(target + ".json")) target += ".json";
  if (target.startsWith("..") || path.isAbsolute(target)) return null;
  if (/(^|\/)(node_modules|\.yarn)\//.test(target)) return null;
  return scanned.has(target) ? target : null;
}

const failures = [];
for (const file of files) {
  let config;
  try {
    config = parseJsonc(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(file + ": cannot parse (" + error.message + ")");
    continue;
  }
  const options = config.compilerOptions || {};
  const mod = typeof options.module === "string" ? options.module.toLowerCase() : undefined;
  const res =
    typeof options.moduleResolution === "string"
      ? options.moduleResolution.toLowerCase()
      : undefined;
  const ext = typeof config.extends === "string" ? config.extends : undefined;

  if (mod === undefined && res === undefined) {
    if (ext && (ext.startsWith("./") || ext.startsWith("../"))) {
      if (localTarget(file, ext)) continue;
      failures.push(
        file +
          ": no module/moduleResolution (extends " +
          ext +
          ", which is not a tsconfig*.json this check scans: restate the lane)",
      );
      continue;
    }
    failures.push(
      file +
        ": no module/moduleResolution" +
        (ext ? " (extends " + ext + ", a package config: restate the lane)" : ""),
    );
    continue;
  }
  if (mod === "nodenext" && res === "nodenext") continue;
  if (mod === "preserve" && res === "bundler") continue;
  failures.push(
    file +
      ": module=" +
      (options.module ?? "(unset)") +
      " moduleResolution=" +
      (options.moduleResolution ?? "(unset)"),
  );
}

if (failures.length > 0) {
  for (const line of failures) console.log(line);
  process.exit(1);
}
console.log(String(files.length));
EOF

if OUT=$(node "$LANES_JS" "$FILE_LIST"); then
  printf '%b\n' "${GREEN}All ${OUT} tsconfig files declare a lane (NodeNext or Bundler).${NC}"
  exit 0
fi

printf '%b\n' "${RED}Error: tsconfig files outside the two module lanes:${NC}" >&2
printf '%s\n' "$OUT" >&2
printf '%b\n' "${YELLOW}Use module + moduleResolution NodeNext (Node code) or Preserve + Bundler (Vite / Expo UI).${NC}" >&2
printf '%b\n' "${YELLOW}See README.md, Security: Repository rules checked in CI.${NC}" >&2
exit 1
