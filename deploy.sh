#!/usr/bin/env bash
# Deploy agent-config.
#
#   ./deploy.sh                  symlink the owned files; apply policy; Codex if present
#   ./deploy.sh --dry-run        print every change and write nothing
#   ./deploy.sh --no-codex       skip Codex, and the three agents that drive it
#   ./deploy.sh --codex          require Codex; fail if ~/.codex/config.toml is missing
#   ./deploy.sh --no-argent      skip ui-runner, which needs the argent MCP server
#   ./deploy.sh --agents a,b,c   deploy only these agents
#   ./deploy.sh --force          replace a file of your own without asking
#   ./deploy.sh --revert         remove this repo's symlinks, restore the newest backup
#
# Run --dry-run first against a config you care about.
#
# The repo owns CLAUDE.md, the agents, the ledger template and the notes, and
# symlinks them, so editing the repo IS deploying them.
#
# It does NOT own ~/.claude/settings.json or ~/.codex/config.toml. Those hold
# local state that the apps write: project trust levels, plugins, marketplaces,
# MCP servers, your model choice. Deploy merges a few policy keys into them and
# leaves everything else alone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
BACKUP="$CLAUDE/backups/deploy-$(date +%Y-%m-%d-%H%M%S)"

ALL_AGENTS=(researcher runner ui-runner opus-implementer sol-implementer astra-implementer astra-reviewer reviewer)
CODEX_AGENTS=(sol-implementer astra-implementer astra-reviewer)
ARGENT_AGENTS=(ui-runner)

OWNED_TOP=(CLAUDE.md ledger.template.md)

DRY=0
FORCE=0
REVERT=0
NO_CODEX=0
NO_ARGENT=0
PICK=""
ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY=1 ;;
    --force)     FORCE=1 ;;
    --revert)    REVERT=1 ;;
    --no-argent) NO_ARGENT=1 ;;
    --agents)    shift; PICK="${1:-}"
                 if [ -z "$PICK" ]; then echo "--agents needs a comma-separated list" >&2; exit 1; fi ;;
    --agents=*)  PICK="${1#--agents=}" ;;
    --no-codex)  NO_CODEX=1; ARGS+=("$1") ;;
    --codex)     ARGS+=("$1") ;;
    -h|--help)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           echo "unknown flag: $1   (try --help)" >&2; exit 1 ;;
  esac
  shift
done

# The replacement is escaped: bash tilde-expands it back to $HOME otherwise.
short() { echo "${1/#$HOME/\~}"; }

in_list() {
  local needle="$1"; shift
  local x
  for x in "$@"; do
    if [ "$x" = "$needle" ]; then return 0; fi
  done
  return 1
}

# ------------------------------------------------------------ agent choice ---

AGENTS=()
if [ -n "$PICK" ]; then
  IFS=',' read -r -a WANT <<< "$PICK"
  for a in "${WANT[@]}"; do
    if in_list "$a" "${ALL_AGENTS[@]}"; then
      AGENTS+=("$a")
    else
      echo "unknown agent: $a" >&2
      echo "known agents: ${ALL_AGENTS[*]}" >&2
      exit 1
    fi
  done
else
  for a in "${ALL_AGENTS[@]}"; do
    if [ "$NO_CODEX" = 1 ] && in_list "$a" "${CODEX_AGENTS[@]}"; then continue; fi
    if [ "$NO_ARGENT" = 1 ] && in_list "$a" "${ARGENT_AGENTS[@]}"; then continue; fi
    AGENTS+=("$a")
  done
fi

# ----------------------------------------------------------------- revert ----

revert() {
  local dst target newest rel
  local found=0
  for dst in "$CLAUDE/CLAUDE.md" "$CLAUDE/ledger.template.md" \
             "$CLAUDE/notes/model-routing-rationale.md" "$CLAUDE"/agents/*.md; do
    if [ ! -L "$dst" ]; then continue; fi
    case "$(readlink "$dst")" in
      "$REPO"/*)
        found=$((found + 1))
        if [ "$DRY" = 1 ]; then
          echo "unlink   $(short "$dst")"
        else
          rm "$dst"
          echo "unlinked $(short "$dst")"
        fi ;;
    esac
  done
  if [ "$found" = 0 ]; then echo "no symlinks from this repo are in place"; fi

  newest="$(ls -d "$CLAUDE"/backups/deploy-* 2>/dev/null | tail -1 || true)"
  if [ -z "$newest" ]; then
    echo "no backup to restore"
    return 0
  fi
  echo "backup   $(short "$newest")"
  while IFS= read -r f; do
    rel="${f#"$newest"/}"
    target="$HOME/$rel"
    if [ "$DRY" = 1 ]; then
      echo "restore  $(short "$target")"
    else
      mkdir -p "$(dirname "$target")"
      cp -p "$f" "$target"
      echo "restored $(short "$target")"
    fi
  done < <(find "$newest" -type f)
  echo
  echo "Restored each file as it was at that deploy. Later local edits to those"
  echo "files are gone. Older backups are still in $(short "$CLAUDE/backups")."
}

if [ "$REVERT" = 1 ]; then
  if [ "$DRY" = 1 ]; then
    echo "DRY RUN -- nothing below is written."
    echo
  fi
  revert
  if [ "$DRY" = 1 ]; then
    echo
    echo "DRY RUN -- nothing was written."
  fi
  exit 0
fi

# ------------------------------------------------------------------ deploy ---

if [ "$DRY" = 1 ]; then
  echo "DRY RUN -- nothing below is written."
  echo
fi

confirm_replace() {
  local s="$1"
  if [ "$FORCE" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then
    echo "" >&2
    echo "$s is a file of your own, not a symlink." >&2
    echo "Deploy would back it up and replace it with a symlink into this repo." >&2
    echo "Run ./deploy.sh --dry-run to see every change, then --force to proceed." >&2
    exit 1
  fi
  printf '%s is your own file. Back it up and replace it with a symlink? [y/N] ' "$s"
  local reply=""
  read -r reply < /dev/tty || true
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) echo "skipped  $s"; return 1 ;;
  esac
}

link() {
  local src="$1" dst="$2"
  local s
  s="$(short "$dst")"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then return 0; fi

  if [ "$DRY" = 1 ]; then
    if [ -L "$dst" ]; then
      echo "relink   $s   (now points at $(readlink "$dst"))"
    elif [ -e "$dst" ]; then
      echo "REPLACE  $s   (a file of your own: deploy would ask, then back it up)"
    else
      echo "link     $s"
    fi
    return 0
  fi

  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    if ! confirm_replace "$s"; then return 0; fi
    mkdir -p "$BACKUP/$(dirname "${dst#"$HOME"/}")"
    cp -p "$dst" "$BACKUP/${dst#"$HOME"/}"
  fi
  mkdir -p "$(dirname "$dst")"
  ln -sfn "$src" "$dst"
  echo "linked   $s"
}

for f in "${OWNED_TOP[@]}"; do
  link "$REPO/$f" "$CLAUDE/$f"
done
link "$REPO/notes/model-routing-rationale.md" "$CLAUDE/notes/model-routing-rationale.md"
for a in "${AGENTS[@]}"; do
  link "$REPO/agents/$a.md" "$CLAUDE/agents/$a.md"
done

SKIPPED=()
for a in "${ALL_AGENTS[@]}"; do
  if ! in_list "$a" ${AGENTS[@]+"${AGENTS[@]}"}; then SKIPPED+=("$a"); fi
done
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo "agents   not deployed: ${SKIPPED[*]}"
fi

DRY_FLAG=()
if [ "$DRY" = 1 ]; then DRY_FLAG=(--dry-run); fi
python3 "$REPO/tools/apply-policy.py" --backup-dir "$BACKUP" ${DRY_FLAG[@]+"${DRY_FLAG[@]}"} ${ARGS[@]+"${ARGS[@]}"}

if [ "$DRY" = 1 ]; then
  echo
  echo "DRY RUN -- nothing was written."
elif [ -d "$BACKUP" ]; then
  echo "backup   $(short "$BACKUP")"
fi
