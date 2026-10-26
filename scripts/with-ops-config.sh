#!/bin/sh
# Load operator deploy config into the environment, then run a command.
#
# Sources (already-exported shell env always wins; each step only fills unset vars):
#   1. Secret Manager ops JSON (`assets-ops-config`) — team source of truth
#   2. Gitignored .ops.env — local cache from `./yarn ops:pull-env` (fills gaps / offline)
#
# Usage:
#   ./yarn with:ops-config -- ./yarn upload:bucket
#   ./yarn with:ops-config -- ./yarn pull:submissions
#
# Operator CDN/bucket values live in Secret Manager, not in git. After secret updates:
#   ASSETS_OPS_PROJECT=<your-gcp-project> ./yarn ops:pull-env
#
# Override:
#   ASSETS_OPS_PROJECT=… ASSETS_OPS_SECRET=… ./yarn with:ops-config -- …

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" = "--" ]; then
  shift
fi

if [ "$#" -lt 1 ]; then
  echo "Usage: with:ops-config -- <command> [args…]" >&2
  exit 2
fi

PROJECT="${ASSETS_OPS_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
SECRET="${ASSETS_OPS_SECRET:-assets-ops-config}"

if [ -z "${PROJECT}" ] || [ "${PROJECT}" = "(unset)" ]; then
  echo "Set ASSETS_OPS_PROJECT or: gcloud config set project <id>" >&2
  exit 1
fi

# Emit ops helpers (tsc → build/scripts/*.js) before invoking via Yarn PnP.
(
  cd "${ROOT}"
  ./yarn tsc -p tsconfig.scripts.json
)

# 1) Secret Manager (preferred)
if ASSETS_OPS_JSON="$(
  gcloud secrets versions access latest --secret="${SECRET}" --project="${PROJECT}" 2>/dev/null
)"; then
  export ASSETS_OPS_JSON
  eval "$(cd "${ROOT}" && ./yarn node build/scripts/ops-config-exports.js)"
  unset ASSETS_OPS_JSON
else
  echo "warning: could not read secret ${SECRET} in ${PROJECT}; falling back to .ops.env if present" >&2
fi

# 2) Local cache — only keys still unset (stale file cannot override Secret Manager)
OPS_ENV_FILE="${ASSETS_OPS_ENV_FILE:-${ROOT}/.ops.env}"
if [ -f "${OPS_ENV_FILE}" ]; then
  eval "$(cd "${ROOT}" && ./yarn node build/scripts/load-ops-env-unset.js "${OPS_ENV_FILE}")"
fi

# Empty BUCKET_PREFIX is intentional (objects at bucket root; LB strips /<uuid>/static/).
# Only ASSET_BASE_URL missing means published logoURL falls back to GitHub-raw.
if [ -z "${ASSET_BASE_URL:-}" ]; then
  echo "warning: ASSET_BASE_URL unset — upload will use GitHub-raw logos." >&2
  echo "  Add assetBaseUrl to Secret Manager (${SECRET}), then: ./yarn ops:pull-env" >&2
fi

exec "$@"
