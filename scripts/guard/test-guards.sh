#!/bin/sh
# Self-tests for the guards in this directory: feeds constructed hook input to each guard and checks the exit
# code (0 allows, 2 blocks). Prints PASS or FAIL per case and exits 1 if any case fails.
set -u
here=$(cd "$(dirname "$0")" && pwd)
bypass=$here/bypass-guard.sh
protected=$here/protected-paths-guard.sh
failures=0

expect() {
  expected=$1
  name=$2
  shift 2
  printf '%s' "$input" | sh "$@" >/dev/null 2>&1
  actual=$?
  if [ "$actual" -eq "$expected" ]; then
    echo "PASS $name"
  else
    echo "FAIL $name (expected exit $expected, got $actual)"
    failures=$((failures + 1))
  fi
}
shell_command() {
  input=$(printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1")
}
patch() {
  input=$(printf '{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\\n*** %s: %s\\n@@\\n-a\\n+b\\n*** End Patch\\n"}}' "$1" "$2")
}

shell_command 'git commit --no-verify -m wip'; expect 2 "bypass: --no-verify on commit" "$bypass"
shell_command 'git push --no-verify origin main'; expect 2 "bypass: --no-verify on push" "$bypass"
shell_command 'git commit -n -m wip'; expect 2 "bypass: -n on commit" "$bypass"
shell_command 'git -C repo commit -anm wip'; expect 2 "bypass: -n inside combined flags" "$bypass"
shell_command 'git -c core.hooksPath=/dev/null commit -m wip'; expect 2 "bypass: core.hooksPath override" "$bypass"
shell_command 'git config --global core.hookspath .husky'; expect 2 "bypass: core.hooksPath change" "$bypass"
shell_command 'rm .git/hooks/pre-commit'; expect 2 "bypass: edit under .git/hooks" "$bypass"
input=''; expect 2 "bypass: empty input blocks" "$bypass"
shell_command 'git commit -m fix'; expect 0 "bypass: ordinary commit" "$bypass"
shell_command 'git commit --amend -m fix'; expect 0 "bypass: amend" "$bypass"
shell_command 'git push -n origin main'; expect 0 "bypass: push dry run" "$bypass"
shell_command 'ls -la'; expect 0 "bypass: unrelated command" "$bypass"

patch 'Update File' 'docs/architecture.md'; expect 2 "protected: architecture.md" "$protected"
patch 'Add File' 'scripts/guard/new-guard.sh'; expect 2 "protected: new guard script" "$protected"
patch 'Delete File' '.codex/hooks.json'; expect 2 "protected: agent settings" "$protected"
patch 'Move to' 'AGENTS.md'; expect 2 "protected: move onto an entry file" "$protected"
patch 'Update File' './CLAUDE.md'; expect 2 "protected: path with ./ prefix" "$protected"
patch 'Update File' 'README.md'; expect 0 "protected: README is not protected" "$protected"
patch 'Add File' 'docs/adr/ADR-0001-example.md'; expect 0 "protected: a new ADR is not protected" "$protected"
input='{"tool_name":"apply_patch","tool_input":{"command":"no file markers"}}'
expect 2 "protected: unreadable patch blocks" "$protected"
patch 'Update File' 'README.md'; expect 2 "protected: missing list blocks" "$protected" /nonexistent/protected-paths.txt

[ "$failures" -eq 0 ] || exit 1
exit 0
