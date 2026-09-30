# Installation

## Prerequisites

Required: Claude Code, `python3` 3.11 or later (for `tomllib`), and `bash`.

Optional. Deploy works without any of them, and each has a flag that removes the
parts that depend on it:

| Optional | Used by | Skip with |
|---|---|---|
| Codex CLI | `sol-implementer`, `astra-implementer`, `astra-reviewer`, and the second-opinion path in `reviewer` | `--no-codex` |
| argent MCP server | `ui-runner`, and the UI automation rule | `--no-argent` |
| `gh stack` extension | the stacked-PR rule | `--no-stacks` |

## Deploy

```sh
git clone <this repo>
cd agent-config
./deploy.sh --dry-run   # print every change, write nothing
./deploy.sh
```

Run the dry run first. It tells you which files would be linked, which policy
keys would change, and whether any file of your own would be replaced.

| Flag | Effect |
|---|---|
| *(none)* | Apply everything. Codex policy too, if `~/.codex/config.toml` exists. |
| `--dry-run` | Print every change and write nothing. Run this first. |
| `--no-codex` | Skip Codex, and the three agents that drive it. |
| `--codex` | Require Codex; fail if its config is missing. |
| `--no-argent` | Skip `ui-runner` and the UI automation rule. |
| `--no-stacks` | Skip the stacked-PR rule. |
| `--agents a,b,c` | Deploy only the agents named. |
| `--models a,b` | Keep only these models in the routing rules. |
| `--force` | Replace a file of your own without asking. |
| `--revert` | Remove this repo's symlinks and restore the newest backup. |
| `--help` | Print the flag list. |

Examples:

```sh
./deploy.sh --no-codex                    # Claude-only fleet
./deploy.sh --models opus-5.5,sonnet-5.5  # drop models your plan lacks
./deploy.sh --agents runner,reviewer      # a minimal two-agent setup
```

## Environment variables

These are not part of any file deploy writes. Add them to your shell profile:

```sh
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30   # let a session fill further before compacting
export BASH_MAX_OUTPUT_LENGTH=10000         # cap a Bash result before it enters context
export MAX_MCP_OUTPUT_TOKENS=10000          # cap an MCP result before it enters context
```

The first matters most on a model with a 1M-token window. It trades a longer
usable session for a higher context bill, which makes clearing between tasks the
main brake. The other two stop one verbose command from being re-read on every
later turn.

## What deploy owns

Owned outright, and symlinked into `~/.claude/`. Editing the repo deploys them:

| Path | Live location |
|---|---|
| `rules/*.md` | `~/.claude/rules/` |
| `ledger.template.md` | `~/.claude/ledger.template.md` |
| `notes/model-routing-rationale.md` | `~/.claude/notes/` |
| `agents/*.md` | `~/.claude/agents/` |

**Your own `~/.claude/CLAUDE.md` is never touched.** The contract ships as rule
files in `~/.claude/rules/` instead, which Claude Code loads for every project.
If deploy finds a `~/.claude/CLAUDE.md` left as a symlink by an older version of
this repo, it retires that link and says so.

For the few files deploy does own, if one is already a file of your own it asks
before replacing it. With no terminal attached it refuses and tells you to use
`--force`, so an unattended run cannot overwrite anything.

## What deploy does not own

These two files hold state the apps write for themselves. Deploy merges a few
keys into them and leaves the rest alone:

| Policy file | Merged into | Keys asserted |
|---|---|---|
| `settings.policy.json` | `~/.claude/settings.json` | `statusLine`, `hooks`, `tui`, `skipWorkflowUsageWarning` |
| `codex/policy.toml` | `~/.codex/config.toml` | `approval_policy`, `sandbox_mode` |

Everything else in those files stays yours and stays local: Codex project trust
levels, plugins, marketplaces, MCP servers, `permissions`, your model choice.
None of it is stored here. Running `./deploy.sh` never removes it, and deploy
prints what it left alone so you can check.

Policy keys are merged one level down. The repo asserts two hook events,
`PreCompact` and `SessionStart`. Any other hook event you have keeps working.

Re-running deploy is safe. It changes only keys that differ, and backs up any
file it rewrites into `~/.claude/backups/deploy-<timestamp>/`, under that file's
own path relative to your home directory.

## How the contract ships

The orchestrator contract lives in `rules/`, one file per topic, and deploys
into `~/.claude/rules/`. Rules there apply to every project on your machine, and
load at the start of every session.

Two of those files, and parts of others, are gated on tools and models you may
not have. See [customizing.md](customizing.md) for how gating works.

With no selection flags, the rule files are symlinked, so an edit in the repo is
live at once. With `--models`, `--agents`, `--no-codex`, `--no-argent` or
`--no-stacks`, deploy writes filtered copies instead, and says so; after that,
repo edits need another deploy.

> **Cowork.** A Cowork session on the desktop skips a symlinked
> `~/.claude/rules/` file whose target is outside the session's working
> directory, so these rules do not load there. Claude Code in the terminal is
> unaffected.

## The hooks

Deploy asserts two hook events in `~/.claude/settings.json`:

- **SessionStart** — finds `.claude/ledger.md`, in the working directory or in a
  worktree, and reads it into the new session. With several ledgers it prints a
  summary of each instead. This is what makes `/clear` then `go` work.
- **PreCompact** — tells the compaction pass that the ledger is authoritative,
  and that its path and Next step must survive verbatim.

## Undoing a deploy

```sh
./deploy.sh --revert --dry-run
./deploy.sh --revert
```

Revert removes only symlinks that point into this repo, then restores the newest
backup directory. It restores each file as it was at that deploy, so local edits
made since are lost. Older backups stay in `~/.claude/backups/`.

## Tests

Both write only to a temporary directory. Neither touches your own config.

```sh
python3 tools/test-apply-policy.py   # the policy merge
python3 tools/test-deploy.py         # dry run, confirm, force, revert, agent selection
```

Run them after any change to `deploy.sh` or `tools/apply-policy.py`.
