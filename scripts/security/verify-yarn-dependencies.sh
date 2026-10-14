#!/bin/sh

# Exact dependency pins + engines consistency. POSIX sh.
# Workspace package.json + yarn.lock walks run in an embedded Node stdlib
# program (no package.json dependencies). Standalone .mjs is reserved for
# Cursor hooks only.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
ALLOWED_VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

if [ ! -f "package.json" ]; then
  printf '%b\n' "${RED}Error: package.json is missing. This file is required for Yarn dependency management.${NC}"
  exit 1
fi

if [ ! -f "yarn.lock" ]; then
  printf '%b\n' "${RED}Error: yarn.lock is missing. This file should be committed to version control.${NC}"
  exit 1
fi

ENGINES_NODE=$(node -p "(require('./package.json').engines || {}).node || ''")
ENGINES_YARN=$(node -p "(require('./package.json').engines || {}).yarn || ''")

if [ -z "$ENGINES_NODE" ] || [ -z "$ENGINES_YARN" ]; then
  printf '%b\n' "${RED}Error: package.json must set exact engines.node and engines.yarn pins.${NC}"
  printf '%b\n' "${YELLOW}Example: \"engines\": { \"node\": \"24.18.0\", \"yarn\": \"4.17.1\" }${NC}"
  exit 1
fi

if ! printf '%s' "$ENGINES_NODE" | grep -Eq "$ALLOWED_VERSION_RE"; then
  printf '%b\n' "${RED}Error: engines.node must be an exact version (e.g. 24.18.0), found: ${ENGINES_NODE}${NC}"
  printf '%b\n' "${YELLOW}Ranges like >=24.0.0 or ^24.18.0 are not allowed.${NC}"
  exit 1
fi

if ! printf '%s' "$ENGINES_YARN" | grep -Eq "$ALLOWED_VERSION_RE"; then
  printf '%b\n' "${RED}Error: engines.yarn must be an exact version (e.g. 4.17.1), found: ${ENGINES_YARN}${NC}"
  printf '%b\n' "${YELLOW}Ranges like >=4.0.0 or ^4.17.1 are not allowed.${NC}"
  exit 1
fi

if [ -f ".node-version" ]; then
  NODE_FILE_VERSION=$(grep -v '^#' .node-version | grep -v '^$' | head -n 1 | tr -d '[:space:]' | sed 's/^v//')
  if [ "$ENGINES_NODE" != "$NODE_FILE_VERSION" ]; then
    printf '%b\n' "${RED}Error: engines.node (${ENGINES_NODE}) does not match .node-version (${NODE_FILE_VERSION}).${NC}"
    exit 1
  fi
fi

PACKAGE_MANAGER=$(node -p "require('./package.json').packageManager || ''")
PACKAGE_MANAGER_YARN=$(printf '%s' "$PACKAGE_MANAGER" | sed -n 's/^yarn@\([^+]*\).*/\1/p')
if [ -n "$PACKAGE_MANAGER_YARN" ] && [ "$ENGINES_YARN" != "$PACKAGE_MANAGER_YARN" ]; then
  printf '%b\n' "${RED}Error: engines.yarn (${ENGINES_YARN}) does not match packageManager (${PACKAGE_MANAGER_YARN}).${NC}"
  exit 1
fi

printf '%b\n' "${GREEN}engines.node and engines.yarn are exact and consistent${NC}"

DEP_JS=$(mktemp)
# EXIT cleans the temp Node program. INT/TERM must exit explicitly under POSIX.
trap 'rm -f "$DEP_JS"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cat >"$DEP_JS" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function collectPackageJsonFiles() {
  const rootPkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const files = ["package.json"];
  const workspaces = rootPkg.workspaces || [];
  const globs = Array.isArray(workspaces) ? workspaces : workspaces.packages || [];

  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const dir = glob.slice(0, -2);
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgPath = path.join(dir, entry.name, "package.json");
        if (fs.existsSync(pkgPath)) files.push(pkgPath);
      }
      continue;
    }

    const pkgPath = path.join(glob, "package.json");
    if (fs.existsSync(pkgPath)) files.push(pkgPath);
  }

  return files;
}

function checkPackageJson(file) {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  const invalid = [];
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section] || {};
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== "string" || !ALLOWED_VERSION_RE.test(version)) {
        invalid.push('  "' + name + '": "' + version + '" (' + section + ")");
      }
    }
  }
  if (invalid.length > 0) {
    return [
      "Error: Found dependencies in " + file + " that are not in an allowed locked format:",
      ...invalid,
      "Allowed formats: 1.2.3 or 1.2.3-suffix (for example: 5.0.0-beta.2).",
      "Please lock dependency versions to one of these formats only.",
    ].join("\n");
  }
  return null;
}

function checkYarnLock() {
  const lines = fs.readFileSync("yarn.lock", "utf8").split(/\r?\n/);
  const invalid = [];
  let inMetadata = false;
  let currentKey = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "__metadata:") {
      inMetadata = true;
      currentKey = line;
      continue;
    }
    if (/^[^\s].*:$/.test(line)) {
      currentKey = line;
      inMetadata = line === "__metadata:";
      continue;
    }
    if (inMetadata) continue;

    const match = line.match(/^\s+version(?:\s|:)\s*"?([^"]+)"?\s*$/);
    if (!match) continue;
    const version = match[1];
    if (!ALLOWED_VERSION_RE.test(version)) {
      invalid.push("  line " + (i + 1) + " (" + currentKey + "): " + line);
    }
  }

  if (invalid.length > 0) {
    return [
      "Error: Found non-exact resolved versions in yarn.lock:",
      ...invalid,
      "Please regenerate yarn.lock with locked versions.",
      "Run './yarn install' after fixing package.json to update yarn.lock.",
    ].join("\n");
  }
  return null;
}

for (const file of collectPackageJsonFiles()) {
  const packageError = checkPackageJson(file);
  if (packageError) {
    console.error(packageError);
    process.exit(1);
  }
}

const lockError = checkYarnLock();
if (lockError) {
  console.error(lockError);
  process.exit(1);
}
EOF

set +e
DEP_CHECK_OUTPUT=$(node "$DEP_JS" 2>&1)
DEP_CHECK_STATUS=$?
set -e

if [ "$DEP_CHECK_STATUS" -ne 0 ]; then
  printf '%s\n' "$DEP_CHECK_OUTPUT" | while IFS= read -r line || [ -n "$line" ]; do
    printf '%b\n' "${RED}${line}${NC}"
  done
  exit 1
fi

printf '%b\n' "${GREEN}All package.json dependencies are version locked${NC}"
printf '%b\n' "${GREEN}All yarn.lock dependencies are version locked${NC}"

exit 0
