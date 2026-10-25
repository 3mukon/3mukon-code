#!/bin/sh
# Invariant 9, no provider keys: app code never names an API key or a token, as a setting or as an
# environment variable, because providers sign in through their own tools (ADR-0001). It covers every
# code file under src/, tests included. It prints only the file and line of each match, never the text,
# in case a key itself was pasted in. Exits 1 if anything matches.
set -u
cd "$(dirname "$0")/../.." || exit 2
[ -d src ] || exit 0

hits=$(grep -r -n -i -E --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs' \
  -e 'api[_-]?keys?' \
  -e '(auth|access|refresh)[_-]?tokens?' \
  src | cut -d: -f1,2 | sort -u)
[ -z "$hits" ] && exit 0
printf '%s\n' "$hits" | while IFS= read -r location; do
  echo "no provider keys: $location: names an API key or token"
done
exit 1
