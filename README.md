# agent-config

A Claude Code multi-agent setup: an orchestrator contract, eight subagents, a
task ledger that survives context compaction, and hooks that restore it.

## Install

```sh
git clone <this repo>
cd agent-config
./deploy.sh
```

| Flag | Effect |
|---|---|
| *(none)* | Apply everything. Codex policy too, if `~/.codex/config.toml` exists. |
| `--no-codex` | Skip Codex entirely. |
| `--codex` | Require Codex; fail if its config is missing. |

The Codex CLI is optional. Four of the eight agents are thin wrappers around it
(`sol-implementer`, `astra-implementer`, `astra-reviewer`, and the second-opinion
path in `reviewer`). Without Codex, the rest of the setup still works.

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

Re-running deploy is safe. It changes only keys that differ, and backs up any
file it rewrites into `~/.claude/backups/deploy-<timestamp>/`.

## Layout

```
CLAUDE.md               orchestrator contract, loaded every turn
agents/                 the eight subagents
ledger.template.md      copied per task to .claude/ledger.md
notes/                  rationale, not rules
DECISIONS.md            why the setup is shaped this way
settings.policy.json    Claude Code keys this repo asserts
codex/policy.toml       Codex keys this repo asserts
tools/apply-policy.py   the merge, used by deploy.sh
deploy.sh
```

## Notes

Agents you add under `~/.claude/agents/` that are not in the table above are
left alone by deploy. Keep private or employer-specific agents there, not here.

No secrets belong in this repo. Nothing here reads a key or a token.
