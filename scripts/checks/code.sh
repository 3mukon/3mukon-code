#!/bin/sh
# Code checks: typecheck, lint, module rules, formatting, unit tests, and the smoke test on the built app.
# Each runs as a package.json script through the pnpm version that package.json pins; every check runs
# even when an earlier one fails, and each failure is named.
set -u
cd "$(dirname "$0")/../.." || exit 2

if [ ! -d node_modules ]; then
  echo "code checks: dependencies are not installed; run: corepack pnpm install --frozen-lockfile" >&2
  exit 1
fi

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
status=0
for script in typecheck lint lint:modules format:check test test:smoke; do
  if ! corepack pnpm run "$script"; then
    echo "code checks: $script failed" >&2
    status=1
  fi
done
exit "$status"
