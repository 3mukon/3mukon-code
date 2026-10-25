#!/bin/sh
# The check command: runs every fast check. Run it before calling work done; CI runs it on every push.
# Exits 1 if any check fails.
set -u
cd "$(dirname "$0")/.." || exit 2

status=0
run() {
  name=$1
  shift
  if "$@"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    status=1
  fi
}

run "docs: core fields and INDEX rows" sh scripts/checks/docs.sh
run "guards: self-tests" sh scripts/guard/test-guards.sh
run "invariant 8: macOS only" sh scripts/checks/macos-only.sh
run "invariant 9: no provider keys" sh scripts/checks/no-provider-keys.sh
run "catalogs: en and zh-Hans hold the same keys" sh scripts/checks/catalogs.sh
run "code checks" sh scripts/checks/code.sh

if [ "$status" -eq 0 ]; then
  echo "check: all passed"
else
  echo "check: FAILED"
fi
exit "$status"
