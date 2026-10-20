# agent-config

A Claude Code multi-agent setup. It gives the top-level session a contract: plan
the work, delegate it to subagents, review the result, and keep the state in a
file instead of in the conversation.

It ships five things:

- **An orchestrator contract** — rule files that load in every session and tell
  the top-level agent how to work.
- **Eight subagents** — investigation, execution, implementation, and review
  lanes, each pinned to a model.
- **A task ledger** — a small file that holds the task state, so a session can
  be cleared and restarted without losing anything.
- **Six hooks** — they put the ledger back into context when a session starts,
  and protect it when a session compacts. They block writes that would put a
  ledger in the wrong place or lose it, and Xcode builds into a wrong folder.
  They warn when the deployed config is old, and allow a retry of a denied
  read-only call. See
  [The hooks](docs/installation.md#the-hooks).
- **A ledger mod** — a Claude Code plugin that adds `/ledger` and eight
  `/ledger:` commands. `/ledger:help` prints one line for each.
  `/ledger` prints each task ledger's goal, current step and next step.
  `/ledger:task` starts a separate task with its own worktree and ledger.
  `/ledger:update` writes the latest results to the current task's ledger.
  `/ledger:close` writes the ledger, then clears the session.
  `/ledger:next` writes the ledger, clears the session, then continues the task.
  `/ledger:go <name>` writes the ledger, clears the session, then continues
  the task named `<name>`.
  `/ledger:worktrees` prints a table of the repo's linked git worktrees,
  largest first. `/ledger:worktrees prune <name>` lists that worktree's build
  folders, and `--yes` deletes them. It keeps `node_modules` and `Pods`, so the
  worktree still builds. `/ledger:worktrees derived-data` groups Xcode's build
  folders by the project they were built from.
  `/ledger:worktrees prune-orphans --yes` deletes the ones whose project no
  longer exists.
  `/ledger:retire [<slug>]` shows what retiring a task would archive and remove.
  `--yes` archives the task's ledger, then removes its worktree.

## Why it is shaped this way

One number drives the design. In eight weeks of one operator's sessions, 86% of
the spend was re-reading context, not generating output — 257 tokens read for
every one written. Everything you read stays in the session and is paid for
again on every later turn.

So the setup pushes verbose work out of the main session. A build log goes to
`runner`, which returns a verdict. A wide code search goes to `researcher`,
which returns a short report. Implementation goes to an implementer, which
returns a diff and a report. The main session stays small, and it stays the
place where planning, routing, and review happen.

## Install

```sh
git clone https://github.com/chrfalch/agent-config.git
cd agent-config
bin/deploy --dry-run   # print every change, write nothing
bin/deploy
```

You need Claude Code, Node.js 20.12 or later, and `bash`. Deploy runs on Node.
`bash` runs the git hook dispatcher that deploy installs. Python is no longer
needed. The first run of `bin/deploy` runs `npm ci`, which installs
dependencies into `node_modules` and writes the npm cache in `~/.npm`. Codex
CLI, the argent MCP server, and the `gh stack` extension are optional; deploy
has a flag to skip each one.

Run `bin/deploy` with no flags in a terminal to start an interactive wizard.
Flags work as before and skip the wizard.

Claude Code reads the plugins in `mods/` directly from this checkout, not from
a copy. After a plugin change is merged, run `git pull` here, then restart
Claude Code or run `/reload-plugins`. You do not need to run `bin/deploy` again.

Then add three variables to your shell profile:

```sh
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30
export BASH_MAX_OUTPUT_LENGTH=10000
export MAX_MCP_OUTPUT_TOKENS=10000
```

That is the happy path. [docs/installation.md](docs/installation.md) has the
flags, what deploy owns, what it never touches, and how to undo it.

## First five minutes

Check that the install worked before you start real work. Open a new terminal
so the shell variables load, then start Claude Code in any repo.

1. In the terminal, run `ls ~/.claude/agents/`. The list should include
   `researcher.md`, `runner.md`, `reviewer.md`, and `opus-implementer.md`. The
   Codex and argent agents appear only if you did not skip them at deploy.
2. In Claude Code, type `/ledger` and then `/ledger:help`. Both commands should
   run. If Claude Code does not know them, the ledger mod did not install.
3. Ask `What are we working on?`. It should say that no task is open, because
   this repo has no ledger yet.
4. Pick a small real task that touches more than one file, and type
   `Start a new task: …` with a sentence describing it. You should get a plan
   and a question asking you to approve it. Answer `yes` and follow along.

If step 1 or step 2 fails, run `bin/deploy --dry-run` again and read what it
would change.

## Using it

Open Claude Code in your repo and describe the task. The orchestrator explores,
writes a plan, and asks you to approve it. On approval it creates a worktree and
a ledger, then runs the pipeline:

```
investigate -> plan -> ledger -> red tests -> implement -> verify -> review -> clear point -> accept
```

Two things you take part in: you approve the plan, and you run `/clear` when the
orchestrator says so.

### The ledger

Every non-trivial task gets a file at `.claude/ledger.md` in its worktree. It
holds the goal, the approved plan with a status per step, decisions and their
reasons, and one line naming the exact next action. The orchestrator writes to
it at every step boundary.

The ledger exists because the conversation is expensive and the file is cheap.
A session transcript is re-read on every turn. The ledger is read once, when a
session starts.

```markdown
## Next step
Delegate step 3 to opus-implementer at high effort: make the failing
tests in src/sync/__tests__/queue.test.ts pass.
```

### `/ledger:next` and `/ledger:close`

When one implement-and-review cycle finishes and more work remains, the
orchestrator stops and says:

> Clear point. Ledger updated. Type `/ledger:next` to clear the session and continue, or `/ledger:close` to clear it and stop.

You type `/ledger:next`. It clears the session and sends `go <name>`. A hook
reads the ledger into the fresh session, so the new session knows the goal,
what is done, and what is next. It continues from there. You type nothing
else. Type `/ledger:close` to stop for now, and `go` later. If either command
cannot clear the session, it says so; then type `/clear`, then `go`.

This is the core loop. A cold start from the ledger costs a few thousand tokens
once. Carrying the finished cycle into the next one costs that on every turn for
the rest of the task.

### Things you can say

You write plain sentences, and the wording does not have to match these
examples.

| You type | What happens |
|---|---|
| `Start a new task: items in the offline queue disappear if the app is killed during a sync.` | The orchestrator investigates, writes a plan, and asks you to approve it. Only a small single-file change is made without a plan. |
| `yes` | Approves the plan. The orchestrator creates the worktree and the ledger and starts on step 1. |
| `Change step 2: keep the old API and add the new one next to it.` | The orchestrator rewrites the plan and asks again. |
| `What are we working on?` | It answers from the ledger: the goal, what is done, and the next step. If several tasks are open, it lists each one. |
| `go` | It continues from the next step in the ledger. Use this after `/clear`, or in a new session the next day. |
| `go offline-queue-loss` | The same as `go`, when several tasks are open and you want to name one. The session moves into that task's worktree first. |
| `Why did we drop the retry counter?` | It answers from the decisions recorded in the ledger, with the reason for each. |
| `Explain that in more detail.` | Answers start as a short summary. This asks for file paths, function names, and what was ruled out. |
| `Commit and open a PR.` | The orchestrator does not commit on its own. When the last review passes it asks you, and this is the answer. |

[docs/usage.md](docs/usage.md) walks through a full task, with the ledger at
each stage.

### Commands

These commands print state directly, without a model turn. Use them when you
want a quick look instead of a full answer.

| You type | What happens |
|---|---|
| `/ledger` | Prints each task ledger's goal, current step and next step. |
| `/ledger <name>` | Prints only the ledger with that name. |
| `/ledger:help` | Prints one line for each `/ledger` command. |
| `/ledger:worktrees` | Prints a table of the repo's linked git worktrees, largest first, with size, last commit, changed files, ledger and PR. |
| `/ledger:worktrees prune <name>` | Lists the build folders of that worktree and their sizes. It deletes nothing. |
| `/ledger:worktrees prune <name> --yes` | Deletes those build folders. It keeps `node_modules`, `Pods`, `.claude` and the worktree itself. |
| `/ledger:worktrees derived-data` | Lists every folder in `~/Library/Developer/Xcode/DerivedData` with its size. It groups them by where the project is: the main checkout, a linked worktree, another location, or gone. |
| `/ledger:worktrees prune-orphans` | Lists the DerivedData folders whose project no longer exists. It deletes nothing. |
| `/ledger:worktrees prune-orphans --yes` | Deletes those folders. It never deletes shared caches or folders without a recorded project. |
| `/ledger:retire [<slug>]` | Lists what retiring the task would do: its worktree, branch, uncommitted changes and archive path. It deletes nothing. Without a slug it takes the task this session is in. |
| `/ledger:retire [<slug>] --yes` | Copies the task's ledger to `~/.claude/ledger-archive/<repo>/`, removes its worktree and deletes the worktree's build folders. It refuses uncommitted changes or an unmerged branch unless you add `--force`. |

A build folder whose project is on a disk that is not connected goes in its own group, **Disk not connected**, and is never deleted.

To start a separate task, type `/ledger:task <what the task is>`. Claude Code
puts the plugin name in front of every command that a plugin writes as a
markdown file, so a plain `/task` does not exist. The agent picks a
short name and writes the goal. It then runs `bin/cc-task-new`, which creates
a branch, a worktree and a ledger with the goal filled in. The reply tells you
to type `/clear`, then `go <name>`. The fresh session moves into the new
worktree and starts from its ledger. You do not open a new terminal.

To save the latest results before a `/clear`, type `/ledger:update`. In a task
worktree, the agent writes the step status, the subagent reports, the
decisions and the next step to the ledger. The reply tells you to type
`/clear`, then `go`. With no ledger in the working directory, the agent does
not create one there. It starts a task with `bin/cc-task-new` instead, the same
way `/ledger:task` does.

To skip the manual `/clear`, type `/ledger:close` or `/ledger:next` instead.
Both write the ledger the same way, but never start a task. With no ledger in
the worktree, they print why and do nothing. When the reply ends,
`/ledger:close` clears the session. `/ledger:next` also clears it, then sends
`go <name>`, so the fresh session continues the task.

To switch to another task, type `/ledger:go <name>`. The name must be the name
of a task ledger; `/ledger` shows each one. If the session has a task ledger,
the agent writes it first, the same way `/ledger:close` does. When the reply
ends, the session clears and `go <name>` is sent, so the fresh session moves
into that task's worktree. Without a task ledger, the agent writes nothing,
and the switch happens the same way.

To remove a finished worktree, use `bin/cc-worktree-retire <worktree>`. It
archives the ledger first, then removes the worktree and its Xcode build
folders.

## Documentation

| Document | What it covers |
|---|---|
| [docs/usage.md](docs/usage.md) | The daily loop, a worked example, the ledger, clear points |
| [docs/installation.md](docs/installation.md) | Prerequisites, every flag, what deploy owns, revert |
| [docs/fleet.md](docs/fleet.md) | The eight agents, their models, and the routing rules |
| [docs/customizing.md](docs/customizing.md) | Changing models, gating rules, adding an agent, tests |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Forking, what to send back, what must never be committed |
| [DECISIONS.md](DECISIONS.md) | Why the setup is shaped this way |

## Layout

```
rules/                    the orchestrator contract, one file per topic
agents/                   the eight subagents
docs/                     this documentation
ledger.template.md        copied per task to .claude/ledger.md
notes/                    rationale, not rules
DECISIONS.md              why the setup is shaped this way
settings.policy.json      Claude Code keys this repo asserts
codex/policy.toml         Codex keys this repo asserts
mods/ledger/              the /ledger command and its /ledger: commands, /ledger:worktrees included (a Claude Code plugin)
tools/                    the settings merge and rule filter, plus their tests
bin/deploy                installs everything above
bin/cc-dd-path            prints the shared Xcode build folder for a worktree
bin/cc-task-new           starts a task: a new branch, its worktree and its ledger
bin/cc-worktree-retire    archives a worktree's ledger, then removes the worktree
```

## Notes

Agents you add under `~/.claude/agents/` that are not in this repo are left
alone by deploy. Keep private or employer-specific agents there, not here.

No secrets belong in this repo. Nothing here reads a key or a token.
