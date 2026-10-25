#!/bin/sh
# Invariant 8, macOS only: electron-builder is configured for macOS targets only, the build commands ask
# for no other platform, and desktop app code never detects the platform it runs on, since there is only
# one. Desktop app code is everything under src/; once code for remote hosts exists, it lives in modules
# of its own that this check leaves out. Prints each problem and exits 1 if there is any.
set -u
cd "$(dirname "$0")/../.." || exit 2

status=0
problem() {
  echo "macOS only: $1"
  status=1
}
# report RULE: turns "file:line:text" lines on standard input into problems that name the file and line.
report() {
  while IFS=: read -r file line _; do
    echo "macOS only: $file:$line: $1"
  done
}

for file in electron-builder.json electron-builder.json5 electron-builder.yaml electron-builder.toml \
  electron-builder.js electron-builder.cjs electron-builder.mjs electron-builder.ts; do
  [ ! -e "$file" ] || problem "$file: electron-builder is configured in electron-builder.yml only"
done
if [ -f package.json ] && jq -e 'has("build")' package.json > /dev/null; then
  problem 'package.json: its "build" field would configure electron-builder; use electron-builder.yml'
fi

if [ -f electron-builder.yml ]; then
  hits=$(grep -H -n -E '^(win|nsis|nsisWeb|portable|appx|msi|msiWrapper|squirrelWindows|linux|appImage|snap|deb|rpm|freebsd|pacman|p5p|apk|flatpak)[[:space:]]*:' electron-builder.yml)
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | report "configures a target for another platform"
    status=1
  fi
fi

hits=$(grep -H -n -E -e '--(win|windows|linux)([^A-Za-z0-9-]|$)' package.json scripts/*.sh 2>/dev/null)
if [ -n "$hits" ]; then
  printf '%s\n' "$hits" | report "asks electron-builder for another platform"
  status=1
fi

if [ -d src ]; then
  hits=$(grep -r -n -E --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs' \
    -e 'process[?[:space:]]*\.[[:space:]]*platform' \
    -e 'process[[:space:]]*\[[[:space:]]*["'"'"'`]platform' \
    -e '\{[^}]*platform[^}]*\}[[:space:]]*=[[:space:]]*process' \
    -e '(^|[^A-Za-z0-9_$])platform\(' \
    -e 'import[^;]*[^A-Za-z0-9_$]platform[^A-Za-z0-9_$][^;]*from[[:space:]]*["'"'"'](node:)?os["'"'"']' \
    -e '(^|[^A-Za-z0-9_$])os[[:space:]]*\.[[:space:]]*(platform|type)' \
    -e 'navigator[[:space:]]*\.[[:space:]]*(platform|userAgent)' \
    -e '(^|[^A-Za-z0-9_$])win32([^A-Za-z0-9_$]|$)' \
    src | sort -u)
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits" | report "detects the platform; desktop app code runs on macOS only"
    status=1
  fi
fi
exit "$status"
