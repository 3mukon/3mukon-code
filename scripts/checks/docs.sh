#!/bin/sh
# Knowledge check: every Markdown file with frontmatter, outside docs/templates/, must carry the core fields,
# be visibility: public, and have a row in docs/INDEX.md that repeats its ID, link, status, title and summary.
# Every link in docs/INDEX.md must point to an existing file. Prints each problem and exits 1 if there is any.
set -u
cd "$(dirname "$0")/../.." || exit 2

index=docs/INDEX.md
if [ ! -f "$index" ]; then
  echo "docs: $index is missing"
  exit 1
fi
list=$(mktemp "${TMPDIR:-/tmp}/docs-check.XXXXXX") || exit 2
trap 'rm -f "$list"' EXIT
find . -type f -name '*.md' -not -path './.git/*' -not -path '*/node_modules/*' -not -path './docs/templates/*' | sort > "$list"

status=0
problem() {
  echo "docs: $1"
  status=1
}
field() {
  printf '%s\n' "$frontmatter" | sed -n "s/^$1:[[:space:]]*//p" | head -n 1
}

while IFS= read -r file; do
  [ "$(head -n 1 "$file")" = "---" ] || continue
  path=${file#./}
  frontmatter=$(awk 'NR == 1 { next } /^---[[:space:]]*$/ { exit } { print }' "$file")
  for name in id type title status visibility date summary scope tags; do
    printf '%s\n' "$frontmatter" | grep -q "^$name:" || problem "$path: missing core field $name"
  done
  [ "$(field visibility)" = public ] || problem "$path: visibility must be public in this repository"
  case $path in
    docs/*) link=${path#docs/} ;;
    *) link=../$path ;;
  esac
  if [ "$(field type)" = lesson ]; then
    row="| [$(field id)]($link) | $(field status) | $(field level) | $(field title) | $(field summary) |"
  else
    row="| [$(field id)]($link) | $(field status) | $(field title) | $(field summary) |"
  fi
  grep -F -x -q -- "$row" "$index" || problem "$path: $index needs a row that repeats this document's ID, link, status, title and summary"
done < "$list"

for target in $(grep -oE '\]\([^)]+\)' "$index" | sed -E 's/^\]\(//; s/\)$//'); do
  [ -f "docs/$target" ] || problem "$index links to docs/$target, which does not exist"
done
exit "$status"
