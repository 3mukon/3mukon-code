#!/bin/sh
# Protected-path guard: a Codex PreToolUse hook for patches (apply_patch). Codex hooks cannot ask for approval,
# so a patch that adds, changes, moves or deletes a protected file is refused, and the maintainer applies it.
# Usage: protected-paths-guard.sh [LIST] < hook-json
#   LIST holds globs relative to the repository root, one per line; default: protected-paths.txt next to this script.
# Exit 0 allows; exit 2 blocks with the reason on stderr.
set -u
here=$(cd "$(dirname "$0")" && pwd)
list=${1:-$here/protected-paths.txt}

block() {
  echo "protected-path guard: $1" >&2
  exit 2
}

[ -f "$list" ] || block "the protected-path list is missing, so every patch is refused until it is restored."
input=$(cat) || block "the hook input could not be read."
[ -n "$input" ] || block "the hook input is empty, so the patch cannot be checked."

top=$(git rev-parse --show-toplevel 2>/dev/null) || top=
prefix=$(git rev-parse --show-prefix 2>/dev/null) || prefix=
# The patch arrives JSON-encoded: turn \n escapes into lines, then read the file markers of the patch format.
paths=$(printf '%s' "$input" | awk '{ gsub(/\\n/, "\n"); print }' \
  | sed -n -E 's/^.*\*\*\* (Add File|Update File|Delete File|Move to): (.*)$/\2/p' | sed 's/\\r$//')
[ -n "$paths" ] || block "cannot tell which files this patch changes, so it is refused."
globs=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$list")
case $list in
  "$top"/*) shown=${list#"$top"/} ;;
  *) shown=$list ;;
esac

set -f
while IFS= read -r path; do
  case $path in
    /*) [ -n "$top" ] && path=${path#"$top"/} ;;
    *) path=$prefix${path#./} ;;
  esac
  for glob in $globs; do
    case $path in
      $glob) block "$path is a protected file: it is on $shown, which enforces the Protected files sections named in its header. Propose the change; the maintainer applies it." ;;
    esac
  done
done <<EOF
$paths
EOF
exit 0
