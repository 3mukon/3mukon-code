#!/bin/sh
# Builds the macOS app into dist/, with the targets electron-builder.yml lists.
# electron-builder finds the production dependencies by running `pnpm` from PATH. pnpm runs through
# Corepack, so PATH may hold no pnpm or a different version; a Corepack shim, which runs the version
# package.json pins, goes first on PATH while the build runs.
set -eu
cd "$(dirname "$0")/.."

shims=$(mktemp -d "${TMPDIR:-/tmp}/pnpm-shim.XXXXXX")
helper_stage=
helper_manifest=
chrome_stage=
cleanup() {
  rm -rf "$shims"
  if [ -n "$helper_stage" ]; then rm -rf "$helper_stage"; fi
  if [ -n "$helper_manifest" ]; then rm -f "$helper_manifest"; fi
  if [ -n "$chrome_stage" ]; then rm -rf "$chrome_stage"; fi
}
trap cleanup EXIT
corepack enable --install-directory "$shims" pnpm
PATH="$shims:$PATH"
export PATH

pnpm exec electron-vite build
unset APP_NATIVE_HELPER_STAGE APP_CHROME_CONNECTOR_STAGE
if [ -n "${APP_NATIVE_HELPER_IDENTITY:-}" ]; then
  helper_stage=$(mktemp -d "${TMPDIR:-/tmp}/native-helper-stage.XXXXXX")
  sh scripts/build-native-helper.sh bundle "$helper_stage"
  helper_manifest=out/native-helper-identity.json
  cp "$helper_stage/native-helper-identity.json" "$helper_manifest"
  APP_NATIVE_HELPER_STAGE=$helper_stage
  export APP_NATIVE_HELPER_STAGE
fi
chrome_stage=$(mktemp -d "${TMPDIR:-/tmp}/chrome-connector-stage.XXXXXX")
APP_CHROME_CONNECTOR_STAGE=$chrome_stage/connector
node scripts/build-chrome-profile-candidate.mjs "$APP_CHROME_CONNECTOR_STAGE"
export APP_CHROME_CONNECTOR_STAGE
pnpm exec electron-builder --mac
