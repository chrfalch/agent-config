#!/usr/bin/env bash
# Deploy agent-config.
#
#   ./deploy.sh              symlink the owned files; apply policy; Codex if present
#   ./deploy.sh --no-codex   skip Codex entirely
#   ./deploy.sh --codex      require Codex, fail if ~/.codex/config.toml is missing
#   ./deploy.sh --dry-run    print every change and write nothing
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

AGENTS=(researcher runner ui-runner opus-implementer sol-implementer astra-implementer astra-reviewer reviewer)

# --dry-run is handled here. Every other flag goes to apply-policy.py.
DRY=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then DRY=1; else ARGS+=("$arg"); fi
done
if [ "$DRY" = 1 ]; then
  echo "DRY RUN -- nothing below is written."
  echo
fi

link() {
  local src="$1" dst="$2"
  local short="${dst/#$HOME/~}"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then return; fi
  if [ "$DRY" = 1 ]; then
    if [ -L "$dst" ]; then
      echo "relink   $short   (now points at $(readlink "$dst"))"
    elif [ -e "$dst" ]; then
      echo "REPLACE  $short   (a real file: deploy would back it up first)"
    else
      echo "link     $short"
    fi
    return
  fi
  mkdir -p "$(dirname "$dst")" "$BACKUP"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then cp -p "$dst" "$BACKUP/"; fi
  ln -sfn "$src" "$dst"
  echo "linked   $short"
}

link "$REPO/CLAUDE.md"                        "$CLAUDE/CLAUDE.md"
link "$REPO/ledger.template.md"               "$CLAUDE/ledger.template.md"
link "$REPO/notes/model-routing-rationale.md" "$CLAUDE/notes/model-routing-rationale.md"
for a in "${AGENTS[@]}"; do
  link "$REPO/agents/$a.md" "$CLAUDE/agents/$a.md"
done

DRY_FLAG=()
if [ "$DRY" = 1 ]; then DRY_FLAG=(--dry-run); fi
python3 "$REPO/tools/apply-policy.py" --backup-dir "$BACKUP" ${DRY_FLAG[@]+"${DRY_FLAG[@]}"} ${ARGS[@]+"${ARGS[@]}"}

if [ "$DRY" = 1 ]; then
  echo
  echo "DRY RUN -- nothing was written."
elif [ -d "$BACKUP" ]; then
  echo "backup   ${BACKUP/#$HOME/~}"
fi
