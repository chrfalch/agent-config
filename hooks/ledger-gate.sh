#!/bin/bash
# PreToolUse gate on Write, Edit, MultiEdit and Bash: a task ledger lives in a
# linked worktree, never in a repo's main checkout. Denies a write to
# .claude/ledger.md in a main checkout. Exits 0 and stays silent otherwise.

self="$0"
if [ -L "$self" ]; then self=$(readlink "$self"); fi
repo=$(cd "$(dirname "$self")/.." 2>/dev/null; pwd)

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""')

ledger='["'"'"']?[^[:space:];&|<>"'"'"']*\.claude/ledger\.md["'"'"']?'
# A command name at the start of a command, behind wrappers such as sudo, env,
# xargs, then, or a variable assignment, and optionally given as a full path.
command_start='(^|[;&|({])[[:space:]]*((sudo|xargs|env|command|exec|nohup|then|do|else|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*)[[:space:]]+(-[^[:space:]]*[[:space:]]+)*)*(/[^[:space:]]*/)?'
arguments='[^;&|)]*'

# Bash detection is a heuristic. A command writes the ledger when the ledger is
# a redirect target, a tee or sed -i argument, or the last argument of cp or mv.
written_by() {
  {
    printf '%s\n' "$1" | grep -oE '>[[:space:]]*[^[:space:];&|<>]+' | sed -E 's/^>[[:space:]]*//'
    printf '%s\n' "$1" | grep -oE "${command_start}tee[[:space:]]$arguments" | sed -E 's/[0-9]*<<?<?[[:space:]]*[^[:space:]]*//g' | tr -s '[:space:]' '\n'
    printf '%s\n' "$1" | grep -oE "${command_start}sed[[:space:]]($arguments[[:space:]])?-(-in-place|[[:alpha:]]*i)$arguments" | tr -s '[:space:]' '\n'
    printf '%s\n' "$1" | grep -oE "${command_start}(cp|mv)[[:space:]]$arguments" | sed -E 's/[0-9]*(>[>|&]?|<<?<?)[[:space:]]*[^[:space:]]*//g' | awk '{ print $NF }'
  } | grep -xE "$ledger"
}

case "$tool" in
  Bash) targets=$(written_by "$(printf '%s' "$input" | jq -r '.tool_input.command // ""')") ;;
  *) targets=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""') ;;
esac

in_main_checkout() {
  local folder git_dir common_dir
  folder=$(dirname "$1")
  while [ ! -d "$folder" ]; do folder=$(dirname "$folder"); done
  git_dir=$(git -C "$folder" rev-parse --path-format=absolute --git-dir 2>/dev/null) || return 1
  common_dir=$(git -C "$folder" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ "$git_dir" = "$common_dir" ]
}

denied=""
while IFS= read -r target; do
  target=$(printf '%s' "$target" | tr -d '"'"'"'')
  case "$target" in
    "~"/*) target="$HOME/${target#"~"/}" ;;
  esac
  case "$target" in
    /*) ;;
    *) target="$cwd/$target" ;;
  esac
  case "$target" in
    */.claude/ledger.md) ;;
    *) continue ;;
  esac
  if in_main_checkout "$target"; then denied="$denied $target"; fi
done <<< "$targets"

if [ -z "$denied" ]; then
  exit 0
fi

reason=$(printf '%s\n' \
  "This would write a task ledger in a repo's main checkout:$denied" \
  "" \
  "A ledger belongs in the task's worktree, never in the main checkout." \
  "Start the task first. This writes its ledger to the backlog, with no branch or worktree yet:" \
  "  $repo/bin/cc-task-new <slug> --goal '<one paragraph>'" \
  "Then give it a branch and a worktree, and move its ledger in:" \
  "  $repo/bin/cc-task-new --promote <slug>" \
  "Then work in the worktree that cc-task-new --promote prints." \
  "This check does not follow cd: from the main checkout, use the absolute path to the worktree's .claude/ledger.md.")

printf '%s' "$reason" | jq -Rs '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: .
  }
}'
