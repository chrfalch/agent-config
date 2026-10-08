#!/bin/bash
# PermissionDenied: lets the model retry when the denial landed on a read-only
# call. A denial of anything that can write stands.

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')

retry() {
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}'
  exit 0
}

case "$tool" in
  Read|Grep|Glob|NotebookRead) retry ;;
  Bash) ;;
  *) exit 0 ;;
esac

command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
if [ -z "$command" ]; then
  exit 0
fi

# Quoted text can hold a pipe or a redirect that is not shell syntax. Blank the
# quoted spans before reading the command's structure.
bare=$(printf '%s' "$command" | sed -E 's/"[^"]*"/Q/g; s/'"'"'[^'"'"']*'"'"'/Q/g')

case "$bare" in
  *'>'*|*'`'*|*'$('*) exit 0 ;;
esac

segments=$(printf '%s' "$bare" | sed -E 's/(\|\||&&|;|\|)/\n/g')

while IFS= read -r seg; do
  set -- $seg
  verb="${1:-}"
  if [ -z "$verb" ]; then
    continue
  fi
  case "$verb" in
    grep|rg|cat|head|tail|ls|wc|jq|awk|sort|uniq|cut|tr|stat|file|basename|dirname|pwd|echo|du|df|nl|column) ;;
    find)
      case " $seg " in
        *" -delete "*|*" -exec"*|*" -execdir"*|*" -fls "*|*" -fprint"*) exit 0 ;;
      esac
      ;;
    sed)
      case " $seg " in
        *" -i"*) exit 0 ;;
      esac
      case " $seg " in
        *" -n "*) ;;
        *) exit 0 ;;
      esac
      ;;
    git)
      case "${2:-}" in
        log|status|diff|show|rev-parse|ls-files|blame|describe) ;;
        worktree)
          case "${3:-}" in
            list) ;;
            *) exit 0 ;;
          esac
          ;;
        *) exit 0 ;;
      esac
      ;;
    *) exit 0 ;;
  esac
done <<EOF
$segments
EOF

retry
