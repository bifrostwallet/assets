#!/bin/sh
# Fail if outreach PII leaked into the (soon public) data/ tree.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

leaks=0

if find data -type f -name 'submission.json' 2>/dev/null | grep -q .; then
  echo "error: data/**/submission.json must not exist (legacy contact envelope)" >&2
  find data -type f -name 'submission.json' >&2
  leaks=1
fi

# Outreach / sealed forensics must never appear under the public data tree
if rg -n --glob '*.json' \
  -e '"contactEmail"' -e '"contactTelegram"' -e '"submitterContext"' -e '"clientContext"' \
  -e '"sealedPrivate"' -e '"contactName"' -e '"contactPhone"' -e '"contactCountry"' \
  data >/dev/null 2>&1; then
  echo "error: contact/submitter PII keys must not appear under data/" >&2
  rg -n --glob '*.json' \
    -e '"contactEmail"' -e '"contactTelegram"' -e '"submitterContext"' -e '"clientContext"' \
    -e '"sealedPrivate"' -e '"contactName"' -e '"contactPhone"' -e '"contactCountry"' \
    data >&2 || true
  leaks=1
fi

if [ "$leaks" -ne 0 ]; then
  exit 1
fi

echo "OK: no outreach / submitter PII under data/"
