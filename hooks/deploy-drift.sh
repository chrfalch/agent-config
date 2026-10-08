#!/bin/bash
# SessionStart check: warns when ~/.claude is behind the agent-config repo.
# Read-only. It never deploys and never writes.

self="$0"
if [ -L "$self" ]; then self=$(readlink "$self"); fi
repo=$(cd "$(dirname "$self")/.." 2>/dev/null; pwd)
claude="$HOME/.claude"
if [ ! -d "$repo/rules" ]; then
  exit 0
fi

issues=""
add() {
  issues="${issues}  $1
"
}

check() {
  if [ -L "$2" ]; then
    if [ "$(readlink "$2")" != "$1" ]; then
      add "stale link: ${2#"$HOME"/}"
    fi
    return
  fi
  if [ ! -e "$2" ]; then
    add "not deployed: ${2#"$HOME"/}"
  fi
}

for f in "$repo"/rules/*.md; do
  if [ -e "$f" ]; then check "$f" "$claude/rules/$(basename "$f")"; fi
done
for f in "$repo"/agents/*.md; do
  if [ -e "$f" ]; then check "$f" "$claude/agents/$(basename "$f")"; fi
done
for f in "$repo"/hooks/*.sh; do
  if [ -e "$f" ]; then check "$f" "$claude/hooks/$(basename "$f")"; fi
done

if command -v jq >/dev/null 2>&1; then
  keys=$(jq -r -n \
    --slurpfile p "$repo/settings.policy.json" \
    --slurpfile s "$claude/settings.json" '
      (($s[0]) // {}) as $cur
      | (($p[0]) // {}) | to_entries
      | map(. as $e | ($cur[$e.key]) as $c
          | select(
              (if ($e.value | type) == "object"
               then (($c | type) == "object") and ($c | contains($e.value))
               else $c == $e.value end) | not))
      | map(.key) | join(", ")' 2>/dev/null)
  if [ -n "$keys" ]; then
    add "policy not applied: $keys"
  fi
fi

if [ -z "$issues" ]; then
  exit 0
fi

printf '%s' "agent-config: ~/.claude is behind the repo. Run bin/deploy.
$issues" | jq -Rs '{systemMessage: .}'
