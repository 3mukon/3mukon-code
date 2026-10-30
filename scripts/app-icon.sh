#!/bin/sh
# Makes the app's icons from a square picture (scripts/app-icon.swift): resources/icon.icns, the
# picture as a full square in the sizes macOS takes, for the packaged app (electron-builder.yml); and
# resources/dock-icon.png, the picture in macOS's icon shape at 512 pixels, the Dock's largest, which
# the app shows in the Dock while it runs unpackaged.
# Usage: sh scripts/app-icon.sh <picture>
set -eu
cd "$(dirname "$0")/.."

picture=$1
work=$(mktemp -d "${TMPDIR:-/tmp}/app-icon.XXXXXX")
trap 'rm -rf "$work"' EXIT

swift scripts/app-icon.swift "$picture" "$work"

iconset="$work/icon.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$work/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$work/icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
mkdir -p resources
iconutil -c icns "$iconset" -o resources/icon.icns
sips -z 512 512 "$work/dock-icon.png" --out resources/dock-icon.png >/dev/null
