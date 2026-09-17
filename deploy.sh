#!/usr/bin/env bash
# Deploy agent-config.
#
#   ./deploy.sh              symlink the owned files; apply policy; Codex if present
#   ./deploy.sh --no-codex   skip Codex entirely
#   ./deploy.sh --codex      require Codex, fail if ~/.codex/config.toml is missing
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

AGENTS=(researcher runner opus-implementer sol-implementer astra-implementer astra-reviewer reviewer)

link() {
  local src="$1" dst="$2"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then return; fi
  mkdir -p "$(dirname "$dst")" "$BACKUP"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then cp -p "$dst" "$BACKUP/"; fi
  ln -sfn "$src" "$dst"
  echo "linked   ${dst/#$HOME/~}"
}

link "$REPO/CLAUDE.md"                        "$CLAUDE/CLAUDE.md"
link "$REPO/ledger.template.md"               "$CLAUDE/ledger.template.md"
link "$REPO/notes/model-routing-rationale.md" "$CLAUDE/notes/model-routing-rationale.md"
for a in "${AGENTS[@]}"; do
  link "$REPO/agents/$a.md" "$CLAUDE/agents/$a.md"
done

python3 "$REPO/tools/apply-policy.py" --backup-dir "$BACKUP" "$@"

if [ -d "$BACKUP" ]; then
  echo "backup   ${BACKUP/#$HOME/~}"
fi
