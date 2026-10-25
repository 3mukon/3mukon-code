#!/bin/sh
# Catalog parity: every directory under src/ that holds a UI string catalog holds both en.json and
# zh-Hans.json, the two contain the same keys, and every value is a non-empty string, so no UI string
# exists in one language only. Plural forms count once per base key, because languages have different
# plural categories (English has one and other, Chinese only other) and i18next marks them with the
# suffixes _zero, _one, _two, _few, _many and _other. Prints each problem and exits 1 if there is any.
set -u
cd "$(dirname "$0")/../.." || exit 2
[ -d src ] || exit 0

work=$(mktemp -d "${TMPDIR:-/tmp}/catalogs.XXXXXX") || exit 2
trap 'rm -rf "$work"' EXIT

status=0
problem() {
  echo "catalogs: $1"
  status=1
}
# keys FILE: the catalog's key paths with plural suffixes folded, one per line, sorted.
keys() {
  jq -r 'paths(scalars) | map(tostring) | join(".")' "$1" | sed -E 's/_(zero|one|two|few|many|other)$//' | sort -u
}
# blanks FILE: the key paths whose value is not a non-empty string.
blanks() {
  jq -r 'paths(scalars) as $p | select((getpath($p) | type) != "string" or getpath($p) == "") | $p | map(tostring) | join(".")' "$1"
}

find src -type f \( -name en.json -o -name zh-Hans.json \) -exec dirname {} \; | sort -u > "$work/dirs"
while IFS= read -r dir; do
  complete=yes
  for lang in en zh-Hans; do
    if [ ! -f "$dir/$lang.json" ]; then
      problem "$dir: $lang.json is missing"
      complete=no
    elif ! jq empty "$dir/$lang.json" 2> /dev/null; then
      problem "$dir/$lang.json: not valid JSON"
      complete=no
    else
      bad=$(blanks "$dir/$lang.json" | tr '\n' ' ' | sed 's/ $//')
      [ -z "$bad" ] || problem "$dir/$lang.json: empty or non-string values: $bad"
    fi
  done
  [ "$complete" = yes ] || continue
  keys "$dir/en.json" > "$work/en"
  keys "$dir/zh-Hans.json" > "$work/zh-Hans"
  only=$(comm -23 "$work/en" "$work/zh-Hans" | tr '\n' ' ' | sed 's/ $//')
  [ -z "$only" ] || problem "$dir: keys only in en.json: $only"
  only=$(comm -13 "$work/en" "$work/zh-Hans" | tr '\n' ' ' | sed 's/ $//')
  [ -z "$only" ] || problem "$dir: keys only in zh-Hans.json: $only"
done < "$work/dirs"
exit "$status"
