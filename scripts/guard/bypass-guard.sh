#!/bin/sh
# Bypass guard: an agent PreToolUse hook for shell commands. Blocks commands that skip or disable git hooks:
# --no-verify, -n on git commit, any change to core.hooksPath, and any command that mentions .git/hooks.
# Input: the hook's JSON on stdin. Exit 0 allows; exit 2 blocks with the reason on stderr.
# Matching is deliberately simple: a visible false positive costs less than a silent bypass.
set -u

block() {
  echo "bypass guard: blocked ($1). The hooks enforce this repository's invariants: fix what the hook" \
    "reports instead of skipping it, or ask the maintainer." >&2
  exit 2
}

input=$(cat) || block "the hook input could not be read"
[ -n "$input" ] || block "the hook input is empty, so the command cannot be checked"

printf '%s' "$input" | grep -q -e '--no-verify' && block "--no-verify skips git hooks"
printf '%s' "$input" | grep -q -i 'core\.hookspath' && block "core.hooksPath redirects git hooks"
printf '%s' "$input" | grep -q '\.git/hooks' \
  && block "a command that mentions .git/hooks could change the installed hooks; read those files with the file tools instead"
printf '%s' "$input" | grep -q -E 'git[^|;&]*[[:space:]]commit([[:space:]][^|;&]*)?[[:space:]]-[A-Za-z]*n' \
  && block "-n on git commit skips git hooks"
exit 0
