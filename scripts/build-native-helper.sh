#!/bin/sh
# Build the pinned Swift package in scratch storage. With a configured signing certificate,
# stage a stable application bundle. Compile-only mode neither signs nor starts the helper.
set -eu
cd "$(dirname "$0")/.."
package="$(pwd)/src/computer/native"
pin=69764083b16397845dc68b5c0ddb4f674290ae70
name='Computer Use Helper'
bundle_id=io.github.3mukon.3mukon-code.computer-use
identity=${APP_NATIVE_HELPER_IDENTITY:-}
mode=${1:-bundle}
destination=${2:-out/native}
case "$mode" in
  compile) ;;
  bundle)
    case "$identity" in
      *[!0-9A-Fa-f]*|'') echo "Set APP_NATIVE_HELPER_IDENTITY to the signing certificate's SHA-1 fingerprint." >&2; exit 1 ;;
    esac
    [ "${#identity}" -eq 40 ] || exit 1
    ;;
  *) echo "Use build-native-helper.sh compile or build-native-helper.sh bundle [destination]." >&2; exit 1 ;;
esac

scratch=$(mktemp -d "${TMPDIR:-/tmp}/native-helper-build.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
cp -R "$package/Package.swift" "$package/Package.resolved" "$package/Sources" "$scratch/"
mkdir -p "$scratch/cache" "$scratch/config"
swift_package() {
  /usr/bin/xcrun swift "$@" --package-path "$scratch" --cache-path "$scratch/cache" --config-path "$scratch/config"
}
swift_package package --disable-dependency-cache --force-resolved-versions resolve
checkout="$scratch/.build/checkouts/Peekaboo"
[ -d "$checkout" ] || checkout="$scratch/.build/checkouts/peekaboo"
[ "$(/usr/bin/git -C "$checkout" rev-parse HEAD)" = "$pin" ]
/usr/bin/git -C "$checkout" apply --check "$package/coordination-root.patch"
/usr/bin/git -C "$checkout" apply "$package/coordination-root.patch"
swift_package build --arch arm64 --configuration release --force-resolved-versions --product AutomationHelper
binary="$(swift_package build --arch arm64 --configuration release --show-bin-path)/AutomationHelper"
[ -x "$binary" ]
[ "$mode" = bundle ] || exit 0

# Sign and verify in scratch before replacing the development output or supplying the packager.
app="$scratch/$name.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
install -m 755 "$binary" "$app/Contents/MacOS/AutomationHelper"
cp resources/icon.icns "$app/Contents/Resources/icon.icns"
# The checkouts' files are read-only, which a copy would keep.
install -m 644 "$checkout/LICENSE" "$app/Contents/Resources/Peekaboo-LICENSE.txt"
for dependency in "$scratch"/.build/checkouts/*; do
  for license in LICENSE LICENSE.txt; do
    if [ -f "$dependency/$license" ]; then
      install -m 644 "$dependency/$license" "$app/Contents/Resources/$(basename "$dependency")-LICENSE.txt"
    fi
  done
done
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$bundle_id</string>
<key>CFBundleName</key><string>$name</string>
<key>CFBundleDisplayName</key><string>$name</string>
<key>CFBundleExecutable</key><string>AutomationHelper</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
PLIST
requirement="identifier \"$bundle_id\" and certificate leaf = H\"$identity\""
/usr/bin/codesign --force --sign "$identity" --options runtime --timestamp=none \
  --requirements "=designated => $requirement" "$app"
/usr/bin/codesign --verify --strict --deep -R "=$requirement" "$app"

mkdir -p "$destination"
/usr/bin/ditto "$app" "$destination/$name.app"
printf '{"certificate":"%s"}\n' "$identity" > "$destination/native-helper-identity.json"
