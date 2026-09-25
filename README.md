# agent-config

A Claude Code multi-agent setup: an orchestrator contract, eight subagents, a
task ledger that survives context compaction, and hooks that restore it.

## Before you install

You need Claude Code, `python3` (3.11 or later, for `tomllib`), and `bash`.

Three things are optional. Deploy works without any of them, and each has a flag
that removes the parts that depend on it:

| Optional | Used by | Skip with |
|---|---|---|
| Codex CLI | `sol-implementer`, `astra-implementer`, `astra-reviewer`, and the second-opinion path in `reviewer` | `--no-codex` |
| argent MCP server | `ui-runner`, and the UI automation section of `CLAUDE.md` | `--no-argent` |
| `gh stack` extension | the Stacked PRs section of `CLAUDE.md` | nothing to skip; ignore the section |

## Install

```sh
git clone <this repo>
cd agent-config
./deploy.sh --dry-run   # print every change, write nothing
./deploy.sh
```

Run the dry run first. It tells you exactly which files would be linked, which
policy keys would change, and whether any file of your own would be replaced.

| Flag | Effect |
|---|---|
| *(none)* | Apply everything. Codex policy too, if `~/.codex/config.toml` exists. |
| `--dry-run` | Print every change and write nothing. Run this first. |
| `--no-codex` | Skip Codex, and the three agents that drive it. |
| `--codex` | Require Codex; fail if its config is missing. |
| `--no-argent` | Skip `ui-runner`, which needs the argent MCP server. |
| `--agents a,b,c` | Deploy only the agents named. |
| `--force` | Replace a file of your own without asking. |
| `--revert` | Remove this repo's symlinks and restore the newest backup. |
| `--help` | Print the flag list. |

If `~/.claude/CLAUDE.md` is already a file of your own, deploy asks before it
replaces that file with a symlink. With no terminal attached it refuses and
tells you to use `--force`, so an unattended run cannot overwrite your contract.

To undo a deploy:

```sh
./deploy.sh --revert --dry-run
./deploy.sh --revert
```

Revert removes only symlinks that point into this repo, then restores the newest
backup directory. It restores each file as it was at that deploy, so local edits
made since are lost. Older backups stay in `~/.claude/backups/`.

## Models this setup expects

Each agent pins a model in its frontmatter. Change that one line if your plan
does not include the model named, or if you want a lane to run cheaper.

| Agent | Model | Effort | Needs |
|---|---|---|---|
| `runner` | `claude-sonnet-5` | — | — |
| `researcher` | `claude-opus-5-5` | medium | — |
| `reviewer` | `claude-opus-5-5` | medium | — |
| `opus-implementer` | `claude-opus-5-5` | high | — |
| `ui-runner` | `claude-opus-5-5` | — | argent |
| `sol-implementer` | `sonnet` | low | Codex, `gpt-5.6-sol` |
| `astra-implementer` | `sonnet` | low | Codex, `gpt-6-astra` |
| `astra-reviewer` | `sonnet` | low | Codex, `gpt-6-astra` |

The last three are thin Claude wrappers. Their own model is cheap because the
real work happens in Codex; what matters there is the Codex model behind them.

The model rankings in `CLAUDE.md`, and the cost figures in it, come from one
operator's own eight-week corpus. Treat the ordering as a starting point and the
absolute numbers as that operator's, not yours.

## Environment

The setup also depends on three environment variables. They are not part of any
file this repo deploys, so add them to your shell profile yourself:

```sh
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30   # let a session fill further before compacting
export BASH_MAX_OUTPUT_LENGTH=10000         # cap a Bash result before it enters context
export MAX_MCP_OUTPUT_TOKENS=10000          # cap an MCP result before it enters context
```

The first one matters most on a model with a 1M-token window. It trades a longer
usable session for a higher context bill, so clearing between tasks becomes the
main brake. The other two stop one verbose command from being re-read on every
later turn of the session.

## What the repo owns, and what it does not

Owned outright, and symlinked into `~/.claude/`. Editing the repo deploys them:

| Path | Live location |
|---|---|
| `CLAUDE.md` | `~/.claude/CLAUDE.md` |
| `ledger.template.md` | `~/.claude/ledger.template.md` |
| `notes/model-routing-rationale.md` | `~/.claude/notes/` |
| `agents/*.md` | `~/.claude/agents/` |

Not owned. These two files hold state the apps write for themselves, so deploy
merges a few keys into them and leaves the rest alone:

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
Deploy prints what it applied and what it left alone, by path.

Re-running deploy is safe. It changes only keys that differ, and backs up any
file it rewrites into `~/.claude/backups/deploy-<timestamp>/`, under that file's
own path relative to your home directory.

## Tests

Both write only to a temporary directory. Neither touches your own config.

```sh
python3 tools/test-apply-policy.py   # the policy merge
python3 tools/test-deploy.py         # dry run, confirm, force, revert, agent selection
```

Run them after any change to `deploy.sh` or `tools/apply-policy.py`.

## Layout

```
CLAUDE.md                 orchestrator contract, loaded every turn
agents/                   the eight subagents
ledger.template.md        copied per task to .claude/ledger.md
notes/                    rationale, not rules
DECISIONS.md              why the setup is shaped this way
settings.policy.json      Claude Code keys this repo asserts
codex/policy.toml         Codex keys this repo asserts
tools/apply-policy.py     the merge, used by deploy.sh
tools/test-apply-policy.py
tools/test-deploy.py
deploy.sh
```

## Sharing it

See `CONTRIBUTING.md` for how to take this repo, what to keep local, what to send
back, and what must never be committed.

## Notes

Agents you add under `~/.claude/agents/` that are not in the table above are
left alone by deploy. Keep private or employer-specific agents there, not here.

No secrets belong in this repo. Nothing here reads a key or a token.
