#!/bin/sh

# Yarn binary maintainer (POSIX sh).
#
# Usage:
#   ./scripts/security/yarn-binary.sh get [--print-hash] [version]
#   ./scripts/security/yarn-binary.sh update
#   ./scripts/security/yarn-binary.sh upgrade <version>
#
# get     — download the official Yarn release and print its SHA-256
# update  — refresh .yarn/yarn-binary-hash.txt + package.json from the pinned binary
# upgrade — set version, verify against official hash, update pins, verify

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
HASH_FILE=".yarn/yarn-binary-hash.txt"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/security/yarn-binary.sh get [--print-hash] [version]
  ./scripts/security/yarn-binary.sh update
  ./scripts/security/yarn-binary.sh upgrade <version>

Commands:
  get      Download the official Yarn release and print its SHA-256
  update   Refresh hash pins from the currently pinned .yarn/releases binary
  upgrade  Install a Yarn version, verify against the official hash, and pin it
EOF
}

sha256_file() {
  node -e "const fs=require('node:fs');const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$1"
}

yarn_path_from_rc() {
  if [ ! -f .yarnrc.yml ]; then
    printf '%b\n' "${RED}Error: .yarnrc.yml not found${NC}" >&2
    exit 1
  fi
  yarn_path=$(grep '^yarnPath:' .yarnrc.yml | head -n1 | awk '{print $2}')
  if [ -z "$yarn_path" ]; then
    printf '%b\n' "${RED}Error: yarnPath not set in .yarnrc.yml${NC}" >&2
    exit 1
  fi
  printf '%s\n' "$yarn_path"
}

yarn_version_from_path() {
  basename "$1" | sed -n 's/^yarn-\(.*\)\.cjs$/\1/p'
}

cmd_get() {
  PRINT_HASH_ONLY=0
  YARN_VERSION=""
  for arg in "$@"; do
    case "$arg" in
      --print-hash) PRINT_HASH_ONLY=1 ;;
      -*)
        printf '%b\n' "${RED}Error: Unknown option $arg${NC}"
        usage
        exit 1
        ;;
      *) YARN_VERSION="$arg" ;;
    esac
  done

  if [ -z "$YARN_VERSION" ] && [ -f .yarnrc.yml ]; then
    YARN_PATH=$(yarn_path_from_rc)
    YARN_VERSION=$(yarn_version_from_path "$YARN_PATH")
  fi

  if [ -z "${YARN_VERSION:-}" ]; then
    printf '%b\n' "${RED}Error: Yarn version required (pass as argument, or set yarnPath in .yarnrc.yml)${NC}"
    usage
    exit 1
  fi

  DOWNLOAD_TIMEOUT_MS=30000
  TEMP_DIR=$(mktemp -d)
  TEMP_YARN="$TEMP_DIR/yarn-$YARN_VERSION.cjs"

  cleanup() {
    if [ -d "$TEMP_DIR" ]; then
      rm -rf "$TEMP_DIR" || exit 1
    fi
  }
  trap cleanup EXIT INT TERM

  printf '%b\n' "${YELLOW}Downloading official Yarn $YARN_VERSION binary...${NC}" >&2
  # Single-quoted so Node template literals / JS are not expanded by the shell.
  # shellcheck disable=SC2016
  if ! node -e '
const fs = require("node:fs");
const { createHash } = require("node:crypto");

const version = process.argv[1];
const outPath = process.argv[2];
const timeoutMs = Number(process.argv[3]);
const url = `https://repo.yarnpkg.com/${version}/packages/yarnpkg-cli/bin/yarn.js`;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

(async () => {
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (response.url && !response.url.startsWith("https://")) {
      throw new Error(`Refusing non-HTTPS final URL: ${response.url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outPath, buffer);
    process.stdout.write(createHash("sha256").update(buffer).digest("hex"));
  } catch (error) {
    const message = error && error.name === "AbortError"
      ? `Timed out after ${timeoutMs}ms`
      : (error && error.message) || String(error);
    console.error(message);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
})();
' "$YARN_VERSION" "$TEMP_YARN" "$DOWNLOAD_TIMEOUT_MS" > "$TEMP_DIR/hash.txt"; then
    printf '%b\n' "${RED}Error: Failed to download official Yarn binary${NC}" >&2
    exit 1
  fi

  HASH=$(tr -d '[:space:]' < "$TEMP_DIR/hash.txt")
  if [ -z "$HASH" ]; then
    printf '%b\n' "${RED}Error: Failed to hash official Yarn binary${NC}" >&2
    exit 1
  fi

  if [ "$PRINT_HASH_ONLY" -eq 1 ]; then
    echo "$HASH"
    exit 0
  fi

  printf '%b\n' "${GREEN}Official Yarn $YARN_VERSION binary hash:${NC}"
  printf '%b\n' "${YELLOW}SHA-256:${NC} $HASH"
  printf '%b\n' "${YELLOW}For package.json:${NC} yarn@$YARN_VERSION+sha256.$HASH"
  echo
  printf '%b\n' "${GREEN}To upgrade this repository to $YARN_VERSION:${NC}"
  printf '%b\n' "${YELLOW}./scripts/security/yarn-binary.sh upgrade $YARN_VERSION${NC}"
  echo
  printf '%b\n' "${GREEN}If the binary is already in place, refresh the pinned hashes with:${NC}"
  printf '%b\n' "${YELLOW}./scripts/security/yarn-binary.sh update${NC}"
}

cmd_update() {
  YARN_PATH=$(yarn_path_from_rc)
  YARN_BASENAME=$(basename "$YARN_PATH")
  YARN_VERSION=$(yarn_version_from_path "$YARN_PATH")
  if [ -z "$YARN_VERSION" ]; then
    printf '%b\n' "${RED}Error: Could not parse Yarn version from $YARN_PATH${NC}"
    exit 1
  fi

  if [ ! -f "$YARN_PATH" ]; then
    printf '%b\n' "${RED}Error: Yarn binary not found at $YARN_PATH${NC}"
    exit 1
  fi

  NEW_HASH=$(sha256_file "$YARN_PATH")
  printf '%b\n' "${GREEN}New Yarn binary hash: $NEW_HASH${NC}"

  printf '%b\n' "${YELLOW}Updating hash file...${NC}"
  cat > "$HASH_FILE" << EOF
# This file contains the SHA-256 hash of the Yarn binary ($YARN_PATH)
# This hash is used to verify the integrity of the Yarn binary in both local development and CI.
# If you update the Yarn binary, you MUST update this hash to match.
# The hash is also stored in package.json for Yarn's own verification.

# Current hash for $YARN_BASENAME
$NEW_HASH
EOF

  printf '%b\n' "${YELLOW}Updating package.json...${NC}"
  NEW_PACKAGE_MANAGER="yarn@$YARN_VERSION+sha256.$NEW_HASH"

  # Single-quoted so Node template literals are not expanded by the shell.
  # shellcheck disable=SC2016
  node -e '
const fs = require("node:fs");
const pkgPath = "package.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.packageManager = process.argv[1];
pkg.engines = pkg.engines || {};
pkg.engines.yarn = process.argv[2];
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
' "$NEW_PACKAGE_MANAGER" "$YARN_VERSION"

  printf '%b\n' "${GREEN}Successfully updated Yarn binary hash in both $HASH_FILE and package.json${NC}"
  printf '%b\n' "${GREEN}Set engines.yarn to $YARN_VERSION${NC}"
  printf '%b\n' "${YELLOW}Please commit these changes to version control.${NC}"
  printf '%b\n' "${YELLOW}You can verify the hash with: ./scripts/security/verify-yarn-hash.sh${NC}"
}

cmd_upgrade() {
  if [ -z "${1:-}" ]; then
    printf '%b\n' "${RED}Error: Yarn version required${NC}"
    usage
    exit 1
  fi

  YARN_VERSION="$1"
  if ! printf '%s' "$YARN_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$'; then
    printf '%b\n' "${RED}Error: Invalid Yarn version '$YARN_VERSION'${NC}"
    usage
    exit 1
  fi

  if [ ! -x ./yarn ]; then
    printf '%b\n' "${RED}Error: ./yarn launcher not found or not executable${NC}"
    exit 1
  fi

  OLD_YARN_PATH=$(yarn_path_from_rc)
  OLD_VERSION=$(yarn_version_from_path "${OLD_YARN_PATH:-}" || true)

  if [ "$OLD_VERSION" = "$YARN_VERSION" ]; then
    printf '%b\n' "${YELLOW}Already on Yarn $YARN_VERSION; refreshing hashes and verifying...${NC}"
  else
    printf '%b\n' "${YELLOW}Upgrading Yarn ${OLD_VERSION:-unknown} → $YARN_VERSION...${NC}"
    ./yarn set version "$YARN_VERSION"
  fi

  NEW_YARN_PATH=$(yarn_path_from_rc)
  if [ ! -f "$NEW_YARN_PATH" ]; then
    printf '%b\n' "${RED}Error: Expected Yarn binary missing at $NEW_YARN_PATH${NC}"
    exit 1
  fi

  for release in .yarn/releases/yarn-*.cjs; do
    [ -f "$release" ] || continue
    if [ "$release" != "$NEW_YARN_PATH" ]; then
      printf '%b\n' "${YELLOW}Removing old binary $release${NC}"
      rm -f "$release"
    fi
  done

  printf '%b\n' "${YELLOW}Checking official Yarn $YARN_VERSION hash...${NC}"
  OFFICIAL_HASH=$(cmd_get --print-hash "$YARN_VERSION")
  ACTUAL_HASH=$(sha256_file "$NEW_YARN_PATH")
  if [ -z "$OFFICIAL_HASH" ]; then
    printf '%b\n' "${RED}Error: Could not obtain official hash for Yarn $YARN_VERSION${NC}"
    exit 1
  fi
  if [ "$ACTUAL_HASH" != "$OFFICIAL_HASH" ]; then
    printf '%b\n' "${RED}Error: Installed binary does not match the official Yarn $YARN_VERSION release${NC}"
    echo "Official: $OFFICIAL_HASH"
    echo "Actual:   $ACTUAL_HASH"
    exit 1
  fi
  printf '%b\n' "${GREEN}Installed binary matches official Yarn $YARN_VERSION${NC}"

  cmd_update
  "$SCRIPT_DIR/verify-yarn-hash.sh"

  if [ -n "${OLD_VERSION:-}" ] && [ "$OLD_VERSION" != "$YARN_VERSION" ]; then
    for doc in README.md AGENTS.md cloudbuild.yaml; do
      if [ -f "$doc" ] && grep -q "$OLD_VERSION" "$doc"; then
        printf '%b\n' "${YELLOW}Updating $OLD_VERSION → $YARN_VERSION in $doc${NC}"
        sed -i.bak "s/$OLD_VERSION/$YARN_VERSION/g" "$doc"
        rm -f "$doc.bak"
      fi
    done
  fi

  echo
  printf '%b\n' "${GREEN}Yarn is now $YARN_VERSION${NC}"
  ./yarn --version
  echo
  printf '%b\n' "${YELLOW}Next steps:${NC}"
  echo "1. If ./yarn install --immutable fails because the lockfile needs a migration,"
  echo "   temporarily set enableImmutableInstalls: false in .yarnrc.yml, run"
  echo "   ./yarn install, then set it back to true."
  echo "2. Commit .yarn/releases/, .yarn/yarn-binary-hash.txt, .yarnrc.yml, package.json,"
  echo "   yarn.lock (if changed), and any updated docs/scripts."
}

cd "$ROOT"

if [ "$#" -lt 1 ]; then
  usage
  exit 1
fi

COMMAND="$1"
shift

case "$COMMAND" in
  get) cmd_get "$@" ;;
  update) cmd_update "$@" ;;
  upgrade) cmd_upgrade "$@" ;;
  -h|--help|help) usage ;;
  *)
    printf '%b\n' "${RED}Error: Unknown command '$COMMAND'${NC}"
    usage
    exit 1
    ;;
esac
