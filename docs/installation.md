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
| Codex CLI | `sol-implementer`, `astra-implementer`, `astra-reviewer`, `codex-runner`, and the second-opinion path in `reviewer` | `--no-codex` |
| argent MCP server | `ui-runner`, and the UI automation rule | `--no-argent` |
| `gh stack` extension | the stacked-PR rule | `--no-stacks` |

## Deploy

```sh
git clone <this repo>
cd ledger
bin/deploy --dry-run   # print every change, write nothing
bin/deploy
```

A clone made before the project was called ledger can still be in a folder
named `agent-config`. Deploy works from any folder name. To rename the folder,
run `bin/deploy` again from the new path. Then move
`~/.claude/ledger-backlog/<old name>/` and `~/.claude/ledger-archive/<old name>/`
to the new folder name, because ledgers are filed under the folder name of the
checkout.

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
| `--no-codex` | Skip Codex, and the four agents that drive it. |
| `--codex` | Require Codex; fail if its config is missing. |
| `--no-argent` | Skip `ui-runner` and the UI automation rule. |
| `--no-stacks` | Skip the stacked-PR rule. |
| `--no-mods` | Skip the ledger mod (`/ledger` and its `/ledger:` commands). |
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

The ledger mod is a Claude Code plugin in `mods/ledger`. It adds fourteen
commands:

- `/ledger` prints each task ledger's goal, current step and next step.
  The parent of a listed task, and the parent of that parent, is shown too
  when it is in the backlog, marked `(backlog)`, or active in another
  worktree.
- `/ledger:task` writes a backlog ledger for a separate task, with no git
  worktree or branch yet. `/ledger:go <slug>` makes them and starts the task.
  When no task is open, `/ledger:task` makes them at once and continues in
  the same session. `/ledger:task --stack` makes them at once, on top of the current branch.
  `/ledger:task --here [<slug>]` adds a ledger to the linked worktree
  the session is in, without a new branch or worktree.
- `/ledger:update` writes the latest results to the current task's ledger. When
  there is no ledger, it creates nothing and points you to `/ledger:task`.
- `/ledger:close` writes the latest results to the current task's ledger, then
  clears the session. When there is no ledger, it prints why and does nothing.
- `/ledger:next` does the same as `/ledger:close`, then sends `go <name>`, so
  the fresh session continues the task.
- `/ledger:go <name>` does the same as `/ledger:next`, but sends
  `go <name>` for the task you name. The name must be the name of a task
  ledger. Without a ledger in the session, it writes nothing and still
  switches. When that task is parked, it removes the parked mark. When that
  task is in the backlog, it first makes its branch and worktree. The branch
  starts at the `--base` ref given when the task was written. Without one, it
  starts at the commit that `origin/HEAD` points to, as of the last fetch.
  Without `origin/HEAD`, it starts at the branch the main checkout is on. It
  refuses a backlog task of another repo.
- `/ledger:park [<slug>] <reason>` marks a task parked, with the date and the
  reason, as the first line under `## Next step`. `/ledger` then shows it as
  parked. Without a slug it does the same as `/ledger:close` for the current
  task, and adds the mark. With the slug of another task it only adds the mark.
- `/ledger:worktrees` prints each linked git worktree's size, last commit,
  dirty files, ledger and PR.
- `/ledger:retire [<slug>]` runs `bin/cc-worktree-retire`: it archives the
  task's ledger, removes its worktree and deletes the worktree's build folders.
  It also deletes the local branch when every commit on it is in the default
  branch or in a merged PR. A branch with commits after its PR merged stays.
  Uncommitted changes need `--force`, and so does a branch that has commits
  not in the default branch and no merged PR. `--dry-run` only shows what
  retiring would archive and remove.
  A backlog task has no worktree or branch: retiring it archives its ledger
  and removes it from the backlog. A parent task with active child tasks
  needs `--force`.
- `/ledger:archive [<term>]` lists this repo's archived ledgers in
  `~/.claude/ledger-archive/`, newest first. A term keeps the ledgers that
  contain it. `--all` lists the archive of every repo.
- `/ledger:all` lists every task ledger on this machine, from every repo,
  active, parked, backlog and archived, with its next step. `--scan` rebuilds that
  list from disk.
- `/ledger:parent [<slug>]` shows a parent task and each child task's status
  and next step. `<slug> add <child>` and `<slug> remove <child>` change its
  child tasks.
- `/ledger:dashboard` starts a web page on this machine that lists every task
  ledger, like `/ledger:all`, with buttons to park, unpark and retire a task.
  `stop` stops it.
- `/ledger:help` prints one line for each of these commands.

`/ledger:worktrees prune <name>` deletes the build folders of one worktree.
These are ignored folders such as `build` and `.expo-prebuild`, and the
worktree's Xcode build folders from `bin/cc-dd-path`. Empty folders are left
out. Add `--dry-run` to only list them and their sizes. The command never
deletes the worktree itself or anything in `.claude`. It also keeps `node_modules` and
`Pods`, so the worktree still builds without a new install.

Deploy installs the mod through the `claude` CLI, at user scope:

- It adds this repo as a folder marketplace named `ledger`.
- It installs the plugin `ledger@ledger`. The part before `@` is the plugin
  name. The part after `@` is the name of the plugin source, the marketplace.
- An earlier deploy added this repo as a marketplace named `agent-config`, the
  old project name. When deploy finds that marketplace pointing at this repo,
  it first uninstalls `ledger@agent-config` and `worktrees@agent-config`, then
  removes the marketplace `agent-config`. So only one ledger plugin is
  installed. `worktrees@agent-config` is the plugin that held `/worktrees`
  before that command moved into the ledger mod as `/ledger:worktrees`.
- Deploy also uninstalls each `agent-config` plugin installed at local or
  project scope. It runs the uninstall in that project's folder. If the folder
  is unknown or missing, deploy prints the command to run instead. The
  user-scope `ledger@ledger` covers those projects, so deploy does not install
  it there again.
- An uninstall at project scope edits `.claude/settings.json` in that project,
  a file the project's repo may track. Review and commit that change there.

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

Deploy asserts five hook events in `~/.claude/settings.json`. They run six
scripts from `hooks/`:

- **SessionStart, `ledger-list.sh`** — reads the task ledger into the new
  session. It reads ledgers from linked worktrees, never from the main
  checkout. With several ledgers it prints a summary of each instead. This is
  what makes `/clear` then `go` work.
- **SessionStart, `deploy-drift.sh`** — warns when `~/.claude` is behind this
  repo.
- **UserPromptSubmit, `ledger-list.sh prompt-submit`** — names the session
  after the task when you type `go <slug>`. It replaces an empty title or the
  name of another task. A name you gave with `/rename` stays.
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

Revert does not remove the ledger mod. The mod lives in Claude Code's own
plugin state, not in a file deploy links. To remove it, run:

```sh
claude plugin uninstall ledger
claude plugin marketplace remove ledger
```

## Tests

The tests write only to a temporary directory. They never touch your own config.

```sh
npm test            # policy merge, dry run, confirm, force, revert, agent selection, wizard
npm run typecheck
```

Run them after any change to `bin/deploy`, `tools/deploy.ts` or
`tools/apply-policy.ts`.
