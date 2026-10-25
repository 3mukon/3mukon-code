#!/bin/sh
# Builds the macOS app into dist/, with the targets electron-builder.yml lists.
# electron-builder finds the production dependencies by running `pnpm` from PATH. pnpm runs through
# Corepack, so PATH may hold no pnpm or a different version; a Corepack shim, which runs the version
# package.json pins, goes first on PATH while the build runs.
set -eu
cd "$(dirname "$0")/.."

shims=$(mktemp -d "${TMPDIR:-/tmp}/pnpm-shim.XXXXXX")
trap 'rm -rf "$shims"' EXIT
corepack enable --install-directory "$shims" pnpm
PATH="$shims:$PATH"
export PATH

pnpm exec electron-vite build
pnpm exec electron-builder --mac
