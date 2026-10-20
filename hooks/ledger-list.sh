#!/bin/bash
# Lists task ledgers for the session's working directory.
# Mode: session-start (default) prints them as SessionStart hook JSON, titling
# the session with the slug when the only ledger is this folder's own; pre-compact names them;
# paths prints only their absolute paths, one per line.
#
# Ledgers are found through git, not through a fixed directory layout:
# - main checkout: one per linked worktree, wherever that worktree lives
#   (.claude/worktrees/, .worktrees/, a sibling folder, ...). Never the main
#   checkout's own ledger: a ledger lives only in a linked worktree;
# - linked worktree: only that worktree's own ledger.
# Outside a git repo: the ledger here, plus the fixed globs.
# Worktrees whose path no longer exists (prunable) are skipped.

mode="${1:-session-start}"
ledgers=()

add() {
  local f="$1" abs x
  [ -f "$f" ] || return 0
  abs="$(cd "$(dirname "$f")" 2>/dev/null && pwd)" || return 0
  abs="$abs/$(basename "$f")"
  for x in "${ledgers[@]}"; do [ "$x" = "$abs" ] && return 0; done
  ledgers+=("$abs")
}

own=0
if top=$(git rev-parse --show-toplevel 2>/dev/null); then
  gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null)
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  if [ -n "$gitdir" ] && [ "$gitdir" = "$common" ]; then
    main=1
    while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          [ -n "$main" ] && { main=; continue; }
          add "${line#worktree }/.claude/ledger.md"
          ;;
      esac
    done < <(git worktree list --porcelain 2>/dev/null)
  else
    add "$top/.claude/ledger.md"
    own=${#ledgers[@]}
  fi
else
  add ".claude/ledger.md"
  own=${#ledgers[@]}
  for f in .claude/worktrees/*/.claude/ledger.md .worktrees/*/.claude/ledger.md; do
    add "$f"
  done
fi

n=${#ledgers[@]}
[ "$n" -eq 0 ] && exit 0

slug() {
  sed -n -E '/^# Task ledger[[:space:]]*(—|-)[[:space:]]*/{s///;s/[[:space:]]+$//;p;q;}' "$1"
}

session_start_text() {
  if [ "$n" -eq 1 ]; then
    echo "A task ledger exists at ${ledgers[0]}. Contents follow. If it has open steps, continue from Next step without re-verifying finished steps."
    echo
    cat "${ledgers[0]}"
  else
    echo "$n task ledgers exist. Summary of each follows. If asked what we are working on, answer from this. Before continuing one, ask which, then read its full ledger."
    for f in "${ledgers[@]}"; do
      echo
      echo "=== $f"
      awk '/^## Goal/{g=1;next} /^## Location/{g=0} /^## Next step/{n=1;next} /^## /{n=0} g||n{print}' "$f"
    done
  fi
}

# If jq is missing or fails, plain text still reaches the model as context; only the title is lost.
session_start_json() {
  local text json
  text=$(cat; printf x)
  text=${text%x}
  if json=$(printf '%s' "$text" | jq -Rs --arg title "$1" '{hookSpecificOutput: ({hookEventName: "SessionStart", additionalContext: .}
      + if $title == "" then {} else {sessionTitle: $title} end)}' 2>/dev/null); then
    printf '%s\n' "$json"
  else
    printf '%s' "$text"
  fi
}

case "$mode" in
  paths)
    printf '%s\n' "${ledgers[@]}"
    ;;
  pre-compact)
    if [ "$n" -eq 1 ]; then
      echo "Task ledger at ${ledgers[0]} is authoritative. Preserve its path and its Next step section verbatim."
    else
      echo "$n task ledgers exist (most recently modified first). Preserve the path of the ledger this session is working on, and its Next step section verbatim:"
      ls -t "${ledgers[@]}"
    fi
    ;;
  *)
    title=""
    [ "$n" -eq 1 ] && [ "$own" -eq 1 ] && title=$(slug "${ledgers[0]}")
    session_start_text | session_start_json "$title"
    ;;
esac
