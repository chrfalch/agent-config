#!/bin/bash
# PreToolUse gate on Bash: a worktree keeps its task ledger until the ledger
# is archived. Denies a removal that would take an unarchived ledger with it.
# Exits 0 and stays silent for every other command.

self="$0"
if [ -L "$self" ]; then self=$(readlink "$self"); fi
repo=$(cd "$(dirname "$self")/.." 2>/dev/null; pwd)

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

case "$command" in
  *cc-worktree-retire*) exit 0 ;;
esac

case "$command" in
  *"worktree remove"*|*"rm -rf"*|*"rm -fr"*) ;;
  *) exit 0 ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // ""')
if [ -n "$cwd" ]; then cd "$cwd" 2>/dev/null || true; fi

archive="$HOME/.claude/ledger-archive"
unarchived=""

for token in $command; do
  case "$token" in
    -*) continue ;;
  esac
  token=$(printf '%s' "$token" | tr -d '"'"'"'')
  token="${token%/}"
  case "$token" in
    "~"/*) token="$HOME/${token#"~"/}" ;;
  esac
  if [ ! -f "$token/.claude/ledger.md" ]; then continue; fi
  abs=$(cd "$token" 2>/dev/null; pwd)
  if [ -z "$abs" ]; then continue; fi
  if grep -rqF -- "- worktree: $abs" "$archive" 2>/dev/null; then continue; fi
  unarchived="$unarchived $abs"
done

if [ -z "$unarchived" ]; then
  exit 0
fi

reason=$(printf '%s\n' \
  "This would remove a worktree whose task ledger is not archived:$unarchived" \
  "" \
  "The ledger is the record of the task. The worktree is not." \
  "Retire it instead, which archives the ledger and then removes the worktree:" \
  "  $repo/bin/cc-worktree-retire <worktree>" \
  "" \
  "Archived ledgers live in ~/.claude/ledger-archive/<repo>/.")

printf '%s' "$reason" | jq -Rs '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: .
  }
}'
