#!/bin/sh
# Code checks. While the repository has no application code they skip visibly. Once code exists they fail
# until the stack's typecheck, lint and test commands are wired in below, because until then nothing can
# tell whether the code is sound.
set -u
cd "$(dirname "$0")/../.." || exit 2

manifest=$(find . \( -name .git -o -name node_modules \) -prune -o \
  \( -name package.json -o -name Package.swift -o -name '*.xcodeproj' -o -name '*.xcworkspace' \
     -o -name go.mod -o -name Cargo.toml -o -name pyproject.toml \) -print | head -n 1)
source=$(find . \( -name .git -o -name node_modules \) -prune -o -type f \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.swift' \
     -o -name '*.m' -o -name '*.go' -o -name '*.rs' -o -name '*.py' \) -print | head -n 1)

if [ -z "$manifest" ] && [ -z "$source" ]; then
  echo "SKIP code checks: no application code yet"
  exit 0
fi

echo "code checks: application code exists, but no checks are wired into scripts/checks/code.sh;" \
  "add the stack's typecheck, lint and test commands here" >&2
exit 1
