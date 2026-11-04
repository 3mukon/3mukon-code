#!/bin/sh
# Builds the app and installs it on this Mac: the ad-hoc signed app goes into /Applications, or into
# the folder given as the first argument, in place of an earlier copy, which must not be running. The
# app's data in ~/Library/Application Support/3mukon-code stays as it is.
set -eu
cd "$(dirname "$0")/.."

folder=${1:-/Applications}
name=3mukon-code.app
target="$folder/$name"

if pgrep -qf "$target/Contents/MacOS/"; then
  echo "install: 3mukon-code is running from $target; quit it first." >&2
  exit 1
fi

sh scripts/package.sh
built="dist/mac-arm64/$name"
codesign --verify --deep --strict "$built"

# The new copy is made beside the old one and then takes its place, so that a copy that fails leaves
# the old one as it was.
mkdir -p "$folder"
staged="$folder/.$name.installing"
rm -rf "$staged"
ditto "$built" "$staged"
rm -rf "$target"
mv "$staged" "$target"
echo "install: 3mukon-code is installed at $target."
