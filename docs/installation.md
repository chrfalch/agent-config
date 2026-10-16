# Installation

## Prerequisites

Required: Claude Code, Node.js 20.12 or later, and `bash`. Deploy runs on Node.
`bash` runs the git hook dispatcher that deploy installs. Python is no longer
needed.

The first run of `bin/deploy` runs `npm ci`. It installs dependencies into
`node_modules` and writes the npm cache in `~/.npm`. That first run needs
network access.

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
bin/deploy --dry-run   # print every change, write nothing
bin/deploy
```

Run the dry run first. It tells you which files would be linked, which policy
keys would change, and whether any file of your own would be replaced.

Run `bin/deploy` with no flags in a terminal to start an interactive wizard.
You choose deploy or revert, then the components, agents and models. The wizard
shows a dry-run preview and asks you to confirm before it writes anything. Flags
work as before and skip the wizard.

| Flag | Effect |
|---|---|
| *(none)* | Apply everything. Codex policy too, if `~/.codex/config.toml` exists. |
| `--dry-run` | Print every change and write nothing. Run this first. |
| `--no-codex` | Skip Codex, and the three agents that drive it. |
| `--codex` | Require Codex; fail if its config is missing. |
| `--no-argent` | Skip `ui-runner` and the UI automation rule. |
| `--no-stacks` | Skip the stacked-PR rule. |
| `--no-mods` | Skip the ledger and worktrees mods (`/ledger`, `/worktrees`). |
| `--agents a,b,c` | Deploy only the agents named. |
| `--models a,b` | Keep only these models in the routing rules. |
| `--force` | Replace a file of your own without asking. |
| `--revert` | Remove this repo's symlinks and restore the newest backup. |
| `--help` | Print the flag list. |

Examples:

```sh
bin/deploy --no-codex                    # Claude-only fleet
bin/deploy --models opus-5.5,sonnet-5.5  # drop models your plan lacks
bin/deploy --agents runner,reviewer      # a minimal two-agent setup
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

### The ledger mod

The ledger mod is a Claude Code plugin in `mods/ledger`. It adds three
commands:

- `/ledger` prints each task ledger's goal, current step and next step.
- `/ledger:task` starts a separate task with its own git worktree, branch and
  ledger.
- `/ledger:update` writes the latest results to the current task's ledger. When
  there is no ledger, it starts a task.

The worktrees mod, in `mods/worktrees`, adds the `/worktrees` command. It
prints each linked git worktree's size, last commit, dirty files, ledger and PR.
`/worktrees prune <name>` lists the build folders of one worktree and their
sizes. These are ignored folders such as `build` and `.expo-prebuild`, and the
worktree's Xcode build folders from `bin/cc-dd-path`. Empty folders are left
out. Add `--yes` to delete them. The command never deletes the worktree itself
or anything in `.claude`. It also keeps `node_modules` and `Pods`, so the
worktree still builds without a new install.

Deploy installs both through the `claude` CLI, at user scope:

- It adds this repo as a folder marketplace named `agent-config`.
- It installs the plugins `ledger@agent-config` and `worktrees@agent-config`.

Deploy skips each step that is already done. The plugin loads from this repo,
so an edit to the repo reaches a running session after `/reload-plugins`. It
does not need a reinstall.

Deploy skips the mod with `--no-mods`. It also skips the mod when `claude` is
not on `PATH`, and says so.

## What deploy does not own

These two files hold state the apps write for themselves. Deploy merges a few
keys into them and leaves the rest alone:

| Policy file | Merged into | Keys asserted |
|---|---|---|
| `settings.policy.json` | `~/.claude/settings.json` | `statusLine`, `hooks`, `tui`, `skipWorkflowUsageWarning` |
| `codex/policy.toml` | `~/.codex/config.toml` | `approval_policy`, `sandbox_mode` |

Everything else in those files stays yours and stays local: Codex project trust
levels, plugins, marketplaces, MCP servers, `permissions`, your model choice.
None of it is stored here. Running `bin/deploy` never removes it, and deploy
prints what it left alone so you can check.

Policy keys are merged one level down, and hooks follow their own rule. Deploy
replaces the `PreCompact` and `SessionStart` hook events whole. For every other
event, it replaces the repo's own entries and keeps yours as they are. An entry
you edited counts as yours.

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

Deploy asserts four hook events in `~/.claude/settings.json`. They run six
scripts from `hooks/`:

- **SessionStart, `ledger-list.sh`** — reads the task ledger into the new
  session. It reads ledgers from linked worktrees, never from the main
  checkout. With several ledgers it prints a summary of each instead. This is
  what makes `/clear` then `go` work.
- **SessionStart, `deploy-drift.sh`** — warns when `~/.claude` is behind this
  repo.
- **PreCompact, `ledger-list.sh pre-compact`** — tells the compaction pass that
  the ledger is authoritative, and that its path and Next step must survive
  verbatim.
- **PreToolUse, `derived-data-gate.sh`** — keeps one Xcode build folder per
  worktree and configuration.
- **PreToolUse, `worktree-gate.sh`** — denies removing a worktree whose ledger
  is not archived.
- **PreToolUse, `ledger-gate.sh`** — denies writing a ledger in a main
  checkout.
- **PermissionDenied, `denied-read-retry.sh`** — lets the model retry a denied
  call that only reads.

## Undoing a deploy

```sh
bin/deploy --revert --dry-run
bin/deploy --revert
```

Revert removes only symlinks that point into this repo, then restores the newest
backup directory. It restores each file as it was at that deploy, so local edits
made since are lost. Older backups stay in `~/.claude/backups/`.

Revert does not remove the ledger and worktrees mods. The mods live in Claude
Code's own plugin state, not in a file deploy links. To remove them, run:

```sh
claude plugin uninstall ledger
claude plugin uninstall worktrees
claude plugin marketplace remove agent-config
```

## Tests

The tests write only to a temporary directory. They never touch your own config.

```sh
npm test            # policy merge, dry run, confirm, force, revert, agent selection, wizard
npm run typecheck
```

Run them after any change to `bin/deploy`, `tools/deploy.ts` or
`tools/apply-policy.ts`.
