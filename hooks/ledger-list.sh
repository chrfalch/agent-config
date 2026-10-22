#!/bin/bash
# Lists task ledgers for the session's working directory.
# Mode: session-start (default) prints them as SessionStart hook JSON, titling
# the session with the slug when the only ledger is this folder's own; pre-compact names them;
# paths prints only their absolute paths, one per line.
# prompt-submit reads UserPromptSubmit hook JSON and, for a prompt of exactly
# `go <slug>` naming an active ledger in any worktree of the repo, titles the
# session with that slug. It replaces no title, a ledger slug, or an archived
# slug from ~/.claude/ledger-archive/<repo>/; any other title came from /rename
# and stays. It prints nothing else, because plain stdout reaches the model.
# backlog prints the paths of this repository's backlog ledgers, one per line.
#
# Ledgers are found through git, not through a fixed directory layout:
# - main checkout: one per linked worktree, wherever that worktree lives
#   (.claude/worktrees/, .worktrees/, a sibling folder, ...). Never the main
#   checkout's own ledger: a ledger lives only in a linked worktree;
# - linked worktree: only that worktree's own ledger.
# Outside a git repo: the ledger here, plus the fixed globs.
# Worktrees whose path no longer exists (prunable) are skipped.

mode="${1:-session-start}"

slug() {
  sed -n -E '/^# Task ledger[[:space:]]*(—|-)[[:space:]]*/{s///;s/[[:space:]]+$//;p;q;}' "$1"
}

contains() {
  local needle="$1" x
  shift
  for x in "$@"; do [ "$x" = "$needle" ] && return 0; done
  return 1
}

prompt_submit() {
  local input target cwd title line worktree repo="" f name
  local active=() archived=()
  command -v jq >/dev/null 2>&1 || return 0
  input=$(cat)
  target=$(printf '%s' "$input" | jq -r '.prompt | capture("\\A\\s*go[ \\t]+(?<slug>\\S+)\\s*\\z").slug' 2>/dev/null) || return 0
  [ -n "$target" ] || return 0
  cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null) || return 0
  title=$(printf '%s' "$input" | jq -r '.session_title // ""' 2>/dev/null) || return 0
  if [ -n "$cwd" ]; then cd "$cwd" 2>/dev/null || return 0; fi

  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        worktree=${line#worktree }
        [ -n "$repo" ] || repo=$(basename "$worktree")
        [ -f "$worktree/.claude/ledger.md" ] && active+=("$(slug "$worktree/.claude/ledger.md")")
        ;;
    esac
  done < <(git worktree list --porcelain 2>/dev/null)

  contains "$target" "${active[@]}" || return 0
  [ "$title" = "$target" ] && return 0
  if [ -n "$title" ] && ! contains "$title" "${active[@]}"; then
    for f in "$HOME/.claude/ledger-archive/$repo"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*.md; do
      [ -f "$f" ] || continue
      name=${f##*/}
      name=${name#??????????-}
      archived+=("${name%.md}")
    done
    # A title that names no task came from /rename; the operator keeps it.
    contains "$title" "${archived[@]}" || return 0
  fi
  jq -nc --arg title "$target" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", sessionTitle: $title}}' 2>/dev/null
}

# Parent and child formats and statuses as bin/cc-ledger-parent writes and shows them.
section() {
  awk -v heading="## $2" '/^## / { title = $0; sub(/[ \t\r]+$/, "", title); inside = title == heading; next } inside' "$1" | tr -d '\r'
}

# The main checkout as cc-task-new works it out. Another repository with the same folder name
# shares the backlog folder; its ledgers name another main checkout.
backlog_ledgers() {
  local common main candidate
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 0
  main=$(dirname "$common")
  for candidate in "$HOME/.claude/ledger-backlog/$(basename "$main")"/*.md; do
    [ -f "$candidate" ] || continue
    [ "$(section "$candidate" Location | sed -n -E 's/^- main:[[:space:]]*(.*[^[:space:]])[[:space:]]*$/\1/p' | head -n 1)" = "$main" ] && printf '%s\n' "$candidate"
  done
  return 0
}

case "$mode" in
  prompt-submit)
    prompt_submit
    exit 0
    ;;
  backlog)
    backlog_ledgers
    exit 0
    ;;
esac

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

ledger_titled() {
  local line candidate
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        candidate="${line#worktree }/.claude/ledger.md"
        if [ -f "$candidate" ] && [ "$(slug "$candidate")" = "$1" ]; then
          printf '%s\n' "$candidate"
          return 0
        fi
        ;;
    esac
  done < <(git worktree list --porcelain 2>/dev/null)
  return 1
}

in_backlog() {
  local candidate
  while IFS= read -r candidate; do
    [ "$(slug "$candidate")" = "$1" ] && return 0
  done < <(backlog_ledgers)
  return 1
}

task_status() {
  local ledger
  if ! ledger=$(ledger_titled "$1"); then
    if in_backlog "$1"; then echo backlog; else echo missing; fi
    return
  fi
  if section "$ledger" 'Next step' | grep -v -m 1 '^[[:space:]]*$' | grep -q -E '^[[:space:]]*Parked:[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]]*(—|-)'; then
    echo parked
  else
    echo active
  fi
}

relations() {
  local parent child mark date
  parent=$(section "$1" Location | sed -n -E '/^- parent:[[:space:]]*</d; s/^- parent:[[:space:]]*([^[:space:]]+)[[:space:]]*$/\1/p' | head -n 1)
  [ -n "$parent" ] && echo "Parent task: $parent ($(task_status "$parent"))."
  section "$1" Children | sed -n -E 's/^- ([A-Za-z0-9._-]+)( \((retired|started) ([0-9]{4}-[0-9]{2}-[0-9]{2})\))?[[:space:]]*$/\1 \3 \4/p' |
    while read -r child mark date; do
      if [ "$mark" = retired ]; then
        echo "Child task: $child (retired $date)."
      else
        echo "Child task: $child ($(task_status "$child"))."
      fi
    done
}

session_start_text() {
  if [ "$n" -eq 1 ]; then
    echo "A task ledger exists at ${ledgers[0]}. Contents follow. If it has open steps, continue from Next step without re-verifying finished steps."
    relations "${ledgers[0]}"
    echo
    cat "${ledgers[0]}"
  else
    echo "$n task ledgers exist. Summary of each follows. If asked what we are working on, answer from this. Before continuing one, ask which, then read its full ledger."
    for f in "${ledgers[@]}"; do
      echo
      echo "=== $f"
      relations "$f"
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

# The hook is deployed as a symlink, so readlink -f finds the repo's bin/. The registry is best
# effort: it must never change this hook's output or exit code.
register_ledgers() {
  [ "${#ledgers[@]}" -gt 0 ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  "$(dirname "$(readlink -f "$0")")/../bin/cc-ledgers" upsert "${ledgers[@]}" >/dev/null 2>&1 || true
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
    register_ledgers
    title=""
    [ "$n" -eq 1 ] && [ "$own" -eq 1 ] && title=$(slug "${ledgers[0]}")
    session_start_text | session_start_json "$title"
    ;;
esac
