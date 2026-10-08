#!/bin/bash
# PreToolUse gate on Bash: one build folder per worktree and configuration.
# Denies any -derivedDataPath that points outside that one folder.
# Exits 0 and stays silent for every other command.

self="$0"
if [ -L "$self" ]; then self=$(readlink "$self"); fi
repo=$(cd "$(dirname "$self")/.." 2>/dev/null; pwd)

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')

case "$command" in
  *-derivedDataPath*) ;;
  *) exit 0 ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // ""')
root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
if [ -z "$root" ]; then
  exit 0
fi

hash=$(printf '%s' "$root" | shasum | cut -c1-6)
prefix="$HOME/Library/Developer/Xcode/DerivedData/cc-$(basename "$root")-$hash-"

paths=$(printf '%s' "$command" \
  | grep -oE -- '-derivedDataPath[= ]+[^ ;|]+' \
  | sed -E 's/^-derivedDataPath[= ]+//' \
  | tr -d '"'"'"'' \
  | sed -E "s|^~|$HOME|")

bad=$(printf '%s\n' "$paths" | grep -v '^$' | grep -v "^$prefix")
if [ -z "$bad" ]; then
  exit 0
fi

reason=$(printf '%s\n' \
  "Build folder is not reusable: $(printf '%s' "$bad" | tr '\n' ' ')" \
  "" \
  "Use one folder per worktree and configuration. The path must start with:" \
  "  $prefix" \
  "followed by the configuration, for example ${prefix}Debug-sim." \
  "" \
  "Get the exact path with: $repo/bin/cc-dd-path <configuration>" \
  "Never put a build folder in the session scratchpad or in /tmp.")

printf '%s' "$reason" | jq -Rs '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: .
  }
}'
