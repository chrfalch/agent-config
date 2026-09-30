#!/usr/bin/env bash
# Deploy agent-config.
#
#   ./deploy.sh                  link the owned files; apply policy; Codex if present
#   ./deploy.sh --dry-run        print every change and write nothing
#   ./deploy.sh --no-codex       skip Codex, and the three agents that drive it
#   ./deploy.sh --codex          require Codex; fail if ~/.codex/config.toml is missing
#   ./deploy.sh --no-argent      skip ui-runner and the UI automation rule
#   ./deploy.sh --no-stacks      skip the stacked-PR rule (needs the gh stack extension)
#   ./deploy.sh --no-githooks    skip the git hook guard; leave core.hooksPath alone
#   ./deploy.sh --agents a,b,c   deploy only these agents
#   ./deploy.sh --models a,b     keep only these models in the routing rules
#   ./deploy.sh --force          replace a file of your own without asking
#   ./deploy.sh --revert         undo the last deploy
#
# Run --dry-run first against a config you care about.
#
# The contract ships as rule files in ~/.claude/rules/, which Claude Code loads
# for every project. Your own ~/.claude/CLAUDE.md is never touched.
#
# NOTE for Cowork users: a Cowork session on the desktop skips a symlinked
# ~/.claude/rules/ file that points outside the session's working directory, so
# these rules do not load there. Claude Code in the terminal is unaffected.
#
# Deploy also installs a chaining git hook dispatcher in ~/.config/git/hooks and
# points core.hooksPath at it. Each hook strips AI attribution trailers from the
# commit message, then hands over to the repository's own hook of the same name,
# so nothing a project keeps in .git/hooks stops working. If core.hooksPath is
# already set to something else, deploy leaves it alone and says so. --revert
# removes the files but does not unset core.hooksPath.
#
# Deploy does NOT own ~/.claude/settings.json or ~/.codex/config.toml. Those hold
# local state the apps write: project trust levels, plugins, marketplaces, MCP
# servers, your model choice. It merges a few policy keys and leaves the rest.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
RULES="$CLAUDE/rules"
MANIFEST="$CLAUDE/.agent-config-manifest"
BACKUP="$CLAUDE/backups/deploy-$(date +%Y-%m-%d-%H%M%S)"
BUILD="$REPO/tools/build-rules.py"
GITHOOKS="$HOME/.config/git/hooks"

ALL_AGENTS=(researcher runner ui-runner opus-implementer sol-implementer astra-implementer astra-reviewer reviewer)
CODEX_AGENTS=(sol-implementer astra-implementer astra-reviewer)
ARGENT_AGENTS=(ui-runner)

DRY=0; FORCE=0; REVERT=0; NO_CODEX=0; NO_ARGENT=0; NO_STACKS=0; NO_GITHOOKS=0
PICK=""; MODELS=""
ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY=1 ;;
    --force)     FORCE=1 ;;
    --revert)    REVERT=1 ;;
    --no-argent) NO_ARGENT=1 ;;
    --no-stacks) NO_STACKS=1 ;;
    --no-githooks) NO_GITHOOKS=1 ;;
    --agents)    shift; PICK="${1:-}"
                 if [ -z "$PICK" ]; then echo "--agents needs a comma-separated list" >&2; exit 1; fi ;;
    --agents=*)  PICK="${1#--agents=}" ;;
    --models)    shift; MODELS="${1:-}"
                 if [ -z "$MODELS" ]; then echo "--models needs a comma-separated list" >&2; exit 1; fi ;;
    --models=*)  MODELS="${1#--models=}" ;;
    --no-codex)  NO_CODEX=1; ARGS+=("$1") ;;
    --codex)     ARGS+=("$1") ;;
    -h|--help)   sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

note() { if [ "$DRY" = 1 ]; then echo "would $*"; else echo "$*"; fi; }

# What the last deploy wrote. Anything in here is ours to replace silently.
OLD_WROTE=()
if [ -f "$MANIFEST" ]; then
  while IFS= read -r line; do
    if [ -n "$line" ]; then OLD_WROTE+=("$line"); fi
  done < "$MANIFEST"
fi

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

# Anything narrowed means the rules must be generated rather than linked.
FILTERED=0
if [ -n "$PICK" ] || [ -n "$MODELS" ] || [ "$NO_CODEX" = 1 ] || [ "$NO_ARGENT" = 1 ] || [ "$NO_STACKS" = 1 ]; then
  FILTERED=1
fi

features() {
  local f=""
  local a
  for a in ${AGENTS[@]+"${AGENTS[@]}"}; do f="$f,$a"; done
  if [ -n "$MODELS" ]; then f="$f,$MODELS"; else f="$f,gpt-5.6-sol,sonnet-5,opus-5.5,gpt-6-astra,fable-5"; fi
  if [ "$NO_CODEX"  = 0 ]; then f="$f,codex"; fi
  if [ "$NO_ARGENT" = 0 ]; then f="$f,argent"; fi
  if [ "$NO_STACKS" = 0 ]; then f="$f,gh-stack"; fi
  echo "${f#,}"
}

# ----------------------------------------------------------------- revert ----

revert() {
  local p target newest rel found=0
  if [ -f "$MANIFEST" ]; then
    while IFS= read -r p; do
      if [ -z "$p" ] || { [ ! -e "$p" ] && [ ! -L "$p" ]; }; then continue; fi
      found=$((found + 1))
      if [ "$DRY" = 1 ]; then echo "remove   $(short "$p")"; else rm -f "$p"; echo "removed  $(short "$p")"; fi
    done < "$MANIFEST"
    if [ "$DRY" = 0 ]; then rm -f "$MANIFEST"; fi
  fi
  if [ "$found" = 0 ]; then echo "nothing from this repo is in place"; fi

  newest="$(ls -d "$CLAUDE"/backups/deploy-* 2>/dev/null | tail -1 || true)"
  if [ -z "$newest" ]; then echo "no backup to restore"; return 0; fi
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
  if [ "$DRY" = 1 ]; then echo "DRY RUN -- nothing below is written."; echo; fi
  revert
  if [ "$DRY" = 1 ]; then echo; echo "DRY RUN -- nothing was written."; fi
  exit 0
fi

# ------------------------------------------------------------------ deploy ---

if [ "$DRY" = 1 ]; then echo "DRY RUN -- nothing below is written."; echo; fi

WROTE=()

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
  WROTE+=("$dst")
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then return 0; fi

  if [ "$DRY" = 1 ]; then
    if [ -L "$dst" ]; then
      echo "relink   $s   (now points at $(readlink "$dst"))"
    elif [ -e "$dst" ] && [[ "$dst" == "$RULES"/* ]] && in_list "$dst" ${OLD_WROTE[@]+"${OLD_WROTE[@]}"}; then
      echo "relink   $s   (replaces a copy an earlier deploy generated)"
    elif [ -e "$dst" ]; then
      echo "REPLACE  $s   (a file of your own: deploy would ask, then back it up)"
    else
      echo "link     $s"
    fi
    return 0
  fi

  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    # Only a generated rule counts as ours. A real file anywhere else is the
    # user's, even if an earlier deploy put a symlink at that path.
    if [[ "$dst" == "$RULES"/* ]] && in_list "$dst" ${OLD_WROTE[@]+"${OLD_WROTE[@]}"}; then
      rm -f "$dst"          # our own generated copy, not the user's file
    else
      if ! confirm_replace "$s"; then return 0; fi
      mkdir -p "$BACKUP/$(dirname "${dst#"$HOME"/}")"
      cp -p "$dst" "$BACKUP/${dst#"$HOME"/}"
    fi
  fi
  mkdir -p "$(dirname "$dst")"
  ln -sfn "$src" "$dst"
  echo "linked   $s"
}

# Earlier versions owned ~/.claude/CLAUDE.md. The contract now ships as rules,
# so retire that symlink and leave any file of the user's own alone.
OLD="$CLAUDE/CLAUDE.md"
if [ -L "$OLD" ] && [[ "$(readlink "$OLD")" == "$REPO"/* ]]; then
  note "retire   $(short "$OLD")   (the contract now ships as rules)"
  if [ "$DRY" = 0 ]; then rm "$OLD"; fi
fi

FEAT="$(features)"
if [ "$FILTERED" = 0 ]; then
  for f in "$REPO"/rules/*.md; do
    link "$f" "$RULES/$(basename "$f")"
  done
else
  # Always build into a temp directory. Building straight into $RULES would let
  # the glob below pick up files an earlier, wider deploy left there.
  OUT="$(mktemp -d)"
  python3 "$BUILD" --src "$REPO/rules" --out "$OUT" --features "$FEAT"
  mkdir -p "$RULES"
  for f in "$OUT"/*.md; do
    d="$RULES/$(basename "$f")"
    WROTE+=("$d")
    if [ "$DRY" = 1 ]; then
      echo "generate $(short "$d")"
    else
      rm -f "$d"      # it may be a symlink into the repo; never write through it
      cp "$f" "$d"
      echo "generated $(short "$d")"
    fi
  done
  rm -rf "$OUT"
  echo "rules    generated, not linked: edits in the repo need another deploy"
fi

link "$REPO/ledger.template.md" "$CLAUDE/ledger.template.md"
link "$REPO/notes/model-routing-rationale.md" "$CLAUDE/notes/model-routing-rationale.md"
for a in ${AGENTS[@]+"${AGENTS[@]}"}; do
  link "$REPO/agents/$a.md" "$CLAUDE/agents/$a.md"
done

# --------------------------------------------------------------- git hooks ---
# A global core.hooksPath replaces a repository's own .git/hooks entirely, so
# the dispatcher chains: policy first, then that repository's own hook.
if [ "$NO_GITHOOKS" = 0 ]; then
  link "$REPO/githooks/_chain" "$GITHOOKS/_chain"
  for h in commit-msg prepare-commit-msg pre-commit pre-merge-commit pre-push pre-rebase post-checkout post-merge post-commit post-rewrite; do
    link "$GITHOOKS/_chain" "$GITHOOKS/$h"
  done
  CUR="$(git config --global core.hooksPath || true)"
  if [ -z "$CUR" ]; then
    note "set      core.hooksPath -> $(short "$GITHOOKS")"
    if [ "$DRY" = 0 ]; then git config --global core.hooksPath "$GITHOOKS"; fi
  elif [ "$CUR" != "$GITHOOKS" ]; then
    echo "hooks    core.hooksPath is $CUR -- left alone, so the guard is not active"
    echo "         to use it: git config --global core.hooksPath $(short "$GITHOOKS")"
  fi
fi

SKIPPED=()
for a in "${ALL_AGENTS[@]}"; do
  if ! in_list "$a" ${AGENTS[@]+"${AGENTS[@]}"}; then SKIPPED+=("$a"); fi
done
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo "agents   not deployed: ${SKIPPED[*]}"
fi

# A rule an earlier deploy wrote that this one does not write is stale. Removing
# it here, rather than removing every rule up front, keeps an unchanged symlink
# unchanged, so the dry run and the real run report the same work.
if [ -f "$MANIFEST" ]; then
  while IFS= read -r p; do
    case "$p" in
      "$RULES"/*)
        if ! in_list "$p" ${WROTE[@]+"${WROTE[@]}"}; then
          if [ "$DRY" = 1 ]; then echo "remove   $(short "$p")   (no longer selected)"
          else rm -f "$p"; echo "removed  $(short "$p")"; fi
        fi ;;
    esac
  done < "$MANIFEST"
fi

if [ "$DRY" = 0 ]; then
  printf '%s\n' ${WROTE[@]+"${WROTE[@]}"} > "$MANIFEST"
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
