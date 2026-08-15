#!/bin/sh

# Exit 0 if staged files include security-sensitive paths (run checks).
# Exit 1 if none (skip checks). POSIX sh.

set -eu

# Get staged security-sensitive files using pathspecs.
# '*package.json' also matches workspace package.json files in subdirectories.
SECURITY_STAGED_FILES=$(git diff --cached --name-only -- \
  '*package.json' \
  'yarn.lock' \
  '.yarnrc' \
  '.yarnrc.yml' \
  'yarn.config.js' \
  'yarn' \
  '.yarn/**' \
  '.github/**' \
  '.git-hooks/**' \
  'scripts/install-git-hooks.sh' \
  '.node-version' \
  '.nvmrc' \
  'Gemfile' \
  'Gemfile.lock' \
  '.bundle/**' \
  '.gitignore' \
  '.gitattributes' \
  '.env*' \
  'tsconfig.json' \
  'scripts/security/**')

if [ -n "$SECURITY_STAGED_FILES" ]; then
  exit 0
fi

exit 1
