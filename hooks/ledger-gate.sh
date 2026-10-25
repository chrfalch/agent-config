#!/bin/bash
# PreToolUse gate on Write, Edit, MultiEdit and Bash: a task ledger lives in a
# linked worktree, never in a repo's main checkout. Denies a write to
# .claude/ledger.md in a main checkout. Also denies new text for any ledger, in
# a worktree or in ~/.claude/ledger-backlog/, that cites a file in a Claude Code
# session folder: macOS deletes those. Exits 0 and stays silent otherwise.

self="$0"
if [ -L "$self" ]; then self=$(readlink "$self"); fi
repo=$(cd "$(dirname "$self")/.." 2>/dev/null; pwd)

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""')

ledger='["'"'"']?[^[:space:];&|<>"'"'"']*\.claude/(ledger|ledger-backlog/[^/[:space:]]+/[^/[:space:]]+)\.md["'"'"']?'
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

deny() {
  printf '%s' "$1" | jq -Rs '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: .
    }
  }'
  exit 0
}

denied="" writes_ledger=""
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
    */.claude/ledger.md) writes_ledger=1 ;;
    */.claude/ledger-backlog/*/*.md) writes_ledger=1; continue ;;
    *) continue ;;
  esac
  if in_main_checkout "$target"; then denied="$denied $target"; fi
done <<< "$targets"

if [ -n "$denied" ]; then
  deny "$(printf '%s\n' \
    "This would write a task ledger in a repo's main checkout:$denied" \
    "" \
    "A ledger belongs in the task's worktree, never in the main checkout." \
    "Start the task first. This writes its ledger to the backlog, with no branch or worktree yet:" \
    "  $repo/bin/cc-task-new <slug> --goal '<one paragraph>'" \
    "Then give it a branch and a worktree, and move its ledger in:" \
    "  $repo/bin/cc-task-new --promote <slug>" \
    "Then work in the worktree that cc-task-new --promote prints." \
    "This check does not follow cd: from the main checkout, use the absolute path to the worktree's .claude/ledger.md.")"
fi

[ -n "$writes_ledger" ] || exit 0

# Only the text being written: an Edit's old_string may still name an old path.
# For Bash the whole command is checked, a heuristic like written_by.
new_text=$(printf '%s' "$input" | jq -r '.tool_input | [.content, .new_string, .edits[]?.new_string, .command] | map(strings) | join("\n")')
uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
session_citation="/tmp/claude-[0-9]+/[^/[:space:]]+/$uuid|<scratchpad>/[^[:space:]]|scratchpad/[A-Za-z0-9_.-]"
printf '%s\n' "$new_text" | grep -qE "$session_citation" || exit 0

deny "A task ledger may not cite files in the Claude Code session folder or its scratchpad, because macOS deletes them. Move the file to .claude/evidence/ in the task's worktree and cite that path, for example .claude/evidence/xcodebuild-red.log. Copy the file and write the ledger in two separate commands."
