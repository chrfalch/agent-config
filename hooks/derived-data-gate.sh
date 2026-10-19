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

# Strips quotes, expands ~, and makes $1 absolute against directory $2.
absolute() {
  local p
  p=$(printf '%s' "$1" | tr -d '"'"'"'')
  case "$p" in
    "~" | "~/"*) p="$HOME${p#\~}" ;;
  esac
  case "$p" in
    /*) printf '%s' "$p" ;;
    *) printf '%s' "$2/$p" ;;
  esac
}

value='("[^"]*"|'"'"'[^'"'"']*'"'"'|[^ ;|&]+)'

repository_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null
}

# The app being built decides the build folder, not the session cwd. Use the
# first of these folders that is inside a git repository: the folder of
# -workspace/-project, a leading `cd <dir> &&`, the cwd. A path the hook cannot
# resolve, such as one in a shell variable, then falls back to the cwd.
cwd=$(printf '%s' "$input" | jq -r '.cwd // ""')
base="$cwd"
cd_dir=$(printf '%s' "$command" | head -1 \
  | sed -nE "s/^[[:space:]]*cd[[:space:]]+$value[[:space:]]*&&.*/\\1/p")
if [ -n "$cd_dir" ]; then
  base=$(absolute "$cd_dir" "$cwd")
fi
app=$(printf '%s' "$command" \
  | grep -oE -- "(^|[[:space:]])-(workspace|project)[= ]+$value" \
  | head -1 \
  | sed -E 's/^[[:space:]]*-(workspace|project)[= ]+//')

root=""
if [ -n "$app" ]; then
  root=$(repository_root "$(dirname "$(absolute "$app" "$base")")")
fi
if [ -z "$root" ] && [ -n "$cd_dir" ]; then
  root=$(repository_root "$base")
fi
if [ -z "$root" ]; then
  root=$(repository_root "$cwd")
fi
if [ -z "$root" ]; then
  exit 0
fi

hash=$(printf '%s' "$root" | shasum | cut -c1-6)
prefix="$HOME/Library/Developer/Xcode/DerivedData/cc-$(basename "$root")-$hash-"

paths=$(printf '%s' "$command" \
  | grep -oE -- "-derivedDataPath[= ]+$value" \
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
  "Write the path in full in the command, not as a shell variable such as \$D." \
  "This hook reads the command text and cannot see what a variable holds." \
  "" \
  "Get the exact path: run $repo/bin/cc-dd-path <configuration>" \
  "in the folder of the app you build." \
  "Never put a build folder in the session scratchpad or in /tmp.")

printf '%s' "$reason" | jq -Rs '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: .
  }
}'
