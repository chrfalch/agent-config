# agent-config

## The problem

Claude Code re-reads the whole conversation on every turn. So a long session
costs more with each turn. You can clear the session to stop that cost, but
then the agent forgets the task: the goal, the plan, and what is done.

## The idea

1. The task state lives in a ledger file, not in the conversation. A fresh
   session reads the file and continues.
2. Each task gets its own git worktree. Two tasks never share a checkout.
3. Subagents do different types of work when needed and return short reports.
   Build logs and wide code searches stay out of the main session.

## What it looks like

**You:** Start a new task: items in the offline queue disappear if the app is
killed during a sync.

**Agent:** (creates a worktree and a ledger, and moves the session into the worktree)

**Agent:** Plan: 1. Write a test that kills the app during a sync and fails.
2. Save each queue item to disk before the sync sends it. 3. Delete the saved
item only after the server confirms it. Do you approve?

**You:** yes

**Agent:** (writes failing tests, makes the fix, gets it reviewed)

**Agent:** Clear point. Ledger updated. Type `/ledger:next` to clear the session and continue, or `/ledger:close` to clear it and stop.

**You:** `/ledger:next`

**Agent:** (fresh session, reads the ledger, continues with step 3 in the plan)

Next morning:

**You:** What are we working on?

**Agent:** One task is open: `offline-queue-loss`. Steps 1 and 2 are done.
Step 3 is in review.

**You:** go

You do three things: you start the task, you approve the plan, and you type `/ledger:next` when the agent asks.

## What it ships

A Claude Code multi-agent setup. It gives the top-level session a contract: plan
the work, delegate it to subagents, review the result, and keep the state in a
file instead of in the conversation. It ships five things:

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
- **A ledger mod** — a Claude Code plugin that adds `/ledger` and thirteen
  `/ledger:` commands. [Commands](#commands) lists each one.

To set it up, see [Install](#install).

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

You need Claude Code, Node.js 20.12 or later, `bash`, `git`, and `jq`. Deploy
runs on Node. `bash` runs the git hook dispatcher that deploy installs. Every
hook script and the status line use `jq`. Python is no longer needed. The
GitHub CLI, `gh`, finds merged PRs for `/ledger:retire` and for the retire hint
of `/ledger:next` and `/ledger:go`. `/ledger:worktrees` uses it for its PR
column. Without `gh`, these parts do not show. The first run of `bin/deploy`
runs `npm ci`, which installs
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

Open Claude Code in your repo and describe the task. The orchestrator starts
the task with `/ledger:task`, which writes a ledger before any plan. When no
task is open, the task gets a worktree at once, and the session moves into it
and continues there. When another task is open, the ledger waits in a backlog,
with no worktree yet. The reply ends with a `start:` line, `/ledger:go <name>`,
and you type it. The orchestrator then explores,
writes a plan, and asks you to approve it. On approval it writes the plan into
the ledger, then runs the pipeline:

```
investigate -> resolve ambiguity -> plan -> ledger -> red tests -> implement -> verify -> review -> clear point -> accept
```

Three things you take part in: you start the task, you approve the plan, and
you type `/ledger:next` when the orchestrator says so.

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
| `Start a new task: items in the offline queue disappear if the app is killed during a sync.` | The orchestrator runs `/ledger:task`. When another task is open, it replies with a `start:` line for you to type. The orchestrator then investigates, writes a plan, and asks you to approve it. Only a small single-file change is made without a plan. |
| `yes` | Approves the plan. The orchestrator writes the plan into the task's ledger and starts on step 1. |
| `Change step 2: keep the old API and add the new one next to it.` | The orchestrator rewrites the plan and asks again. |
| `What are we working on?` | It answers from the ledger: the goal, what is done, and the next step. If several tasks are open, it lists each one. |
| `go` | It continues from the next step in the ledger. Use this after `/ledger:close`, after a manual `/clear`, or in a new session the next day. |
| `go offline-queue-loss` | The same as `go`, when several tasks are open and you want to name one. The session moves into that task's worktree first. |
| `Why did we drop the retry counter?` | It answers from the decisions recorded in the ledger, with the reason for each. |
| `Explain that in more detail.` | Answers start as a short summary. This asks for file paths, function names, and what was ruled out. |
| `Commit and open a PR.` | The orchestrator does not commit on its own. When the last review passes it asks you, and this is the answer. |

[docs/usage.md](docs/usage.md) walks through a full task, with the ledger at
each stage.

### Commands

The ledger mod adds these commands. Claude Code puts the plugin name in front
of every command that a plugin writes as a markdown file, so a plain `/task`
does not exist.

A hook answers `/ledger`, `/ledger:help`, `/ledger:worktrees`,
`/ledger:retire`, `/ledger:archive` and `/ledger:all` directly, without a model
turn. Most of them only print. The `--yes` forms of `/ledger:worktrees` and
`/ledger:retire` delete files. The other commands run a model turn, for example
to write a ledger, start a task, or switch to one.

| You type | What happens |
|---|---|
| `/ledger` | Prints each task ledger's goal, current step and next step. |
| `/ledger <name>` | Prints each ledger whose name contains `<name>`, in any case. More than one ledger can match. |
| `/ledger:help` | Prints one line for each `/ledger` command. |
| `/ledger:task <description>` | Starts a separate task. The agent picks a short name, writes the goal, and runs `bin/cc-task-new`. The script writes a ledger with the goal filled in to the backlog, `~/.claude/ledger-backlog/<repo>/<name>.md`, with no branch or worktree yet. When no task is open, the session moves into the new worktree and continues there. The agent makes that branch and worktree at once, the same way `/ledger:go` does. When another task is open, the ledger stays in the backlog, and the reply ends with a `start:` line, `/ledger:go <name>`. Type it to clear the session and continue in the new task. Either way, you do not open a new terminal. `--stack` makes the branch and worktree at once, on top of the current branch. |
| `/ledger:task --here [<slug>]` | Gives the linked worktree this session is in a ledger, instead of a new worktree. Without a slug, the task takes the branch name without its owner prefix. It refuses the main checkout and a worktree that already has a ledger. The reply is the path of the new ledger. |
| `/ledger:update` | Writes the step status, the subagent reports, the decisions and the next step to the task's ledger. After an implement-and-review cycle with work left, the reply is the clear point line. Otherwise it says only that the ledger is updated. With no ledger in the working directory, the agent creates nothing and tells you to use `/ledger:task`. |
| `/ledger:close` | Writes the ledger the same way, then clears the session. Type `go` later to continue. It never starts a task: with no ledger in the worktree, it prints why and does nothing. |
| `/ledger:next` | Writes the ledger the same way, clears the session, then sends `go <name>`, so the fresh session continues from the next step. When every step is done, it first says how to retire the task. Like `/ledger:close`, it never starts a task. |
| `/ledger:go <slug>` | Switches to the task named `<slug>`; `/ledger` shows each name. If the session has a task ledger, the agent writes it first. The session then clears and `go <slug>` is sent, so the fresh session moves into that task's worktree. If that task was parked, the mark is removed. A backlog task first gets its branch and worktree. The branch starts at the `--base` ref given when the task was written. Without one, it starts at the commit that `origin/HEAD` points to. Nothing fetches first, so that commit is from your last `git fetch`. Without `origin/HEAD`, the branch starts at the branch that the main checkout is on. A backlog task starts only from a session in its repo. From another repo, `/ledger:go` names the repo and changes nothing. When you leave a task whose steps are all done, it first says how to retire it. |
| `/ledger:park [<slug>] <reason>` | Marks a task parked, with the date and the reason. With the slug of another task, it only marks that task. Without a slug, it writes this task's ledger, parks it, then clears the session. |
| `/ledger:archive [<term>] [--all]` | Lists this repo's archived ledgers in `~/.claude/ledger-archive/`, newest first, one line each. A term keeps the ledgers that contain it, in any case, and shows the first matching line. `--all` lists every repo. |
| `/ledger:worktrees` | Prints a table of the repo's linked git worktrees, largest first, with size, last commit, changed files, ledger and PR. |
| `/ledger:worktrees prune <name>` | Lists the build folders of that worktree and their sizes. It deletes nothing. |
| `/ledger:worktrees prune <name> --yes` | Deletes those build folders. It keeps `node_modules`, `Pods`, `.claude` and the worktree itself. |
| `/ledger:worktrees derived-data` | Lists every folder in `~/Library/Developer/Xcode/DerivedData` with its size. It groups them by where the project is: the main checkout, a linked worktree, another location, or gone. Folders with no source project, and shared caches, have their own groups. |
| `/ledger:worktrees prune-orphans` | Lists the DerivedData folders whose project no longer exists. It deletes nothing. |
| `/ledger:worktrees prune-orphans --yes` | Deletes those folders. It never deletes shared caches or folders without a recorded project. |
| `/ledger:retire [<slug>]` | Lists what retiring the task would do: its worktree, branch, uncommitted changes and archive path. It deletes nothing. Without a slug it takes the task this session is in. |
| `/ledger:retire [<slug>] --yes [--force]` | Copies the task's ledger to `~/.claude/ledger-archive/<repo>/`, removes its worktree and deletes the worktree's build folders. It also deletes the local branch when every commit on it is in the default branch or in a merged PR. A branch with commits after its PR merged stays. It needs `--force` for uncommitted changes, for a branch that has commits not in the default branch and no merged PR, and for a parent task with active child tasks. Retiring a child task marks it retired in its parent ledger. |
| `/ledger:parent [<name>]` | Prints a parent task and, for each child task, its status and next step. Without a name it shows the task this session is in when it has child tasks, or else that task's parent task. |
| `/ledger:parent <name> add <child>` | Makes `<child>` a child task of `<name>`. It writes both ledgers. A parent task ties together tasks that ship separately, such as stacked PRs. See [Parent tasks](docs/usage.md#parent-tasks). |
| `/ledger:parent <name> remove <child>` | Removes that relation from both ledgers. |
| `/ledger:all` | Prints a table of every task ledger on the machine, from every repo, active and archived, with its next step. Backlog tasks follow in their own section, **Backlog**. A parked task shows as `parked`. The list lives in `~/.claude/ledgers.json`. A new task, a retire and each session start add to it. |
| `/ledger:all --scan` | Rebuilds `~/.claude/ledgers.json` from the ledgers under `~/repos` and `~/issues` and the archive in `~/.claude/ledger-archive/`, then prints the table. |
| `/ledger:dashboard` | Starts a web page on this machine with the `/ledger:all` list, filters by repo and status, and a search of every ledger's text. Click a task to read its ledger. Its buttons copy `go <slug>`, park and unpark the task, and retire it after a preview. It prints the page's address, which holds a new access key each start. It keeps running after the session ends. |
| `/ledger:dashboard stop` | Stops the dashboard. |

A build folder whose project is on a disk that is not connected goes in its own group, **Disk not connected**, and is never deleted.

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
.claude-plugin/           marketplace.json, which lists the plugins in mods/ for Claude Code
hooks/                    the six hook scripts that deploy installs
githooks/                 the git hook dispatcher that deploy installs
tools/                    the deploy code, its wizard and CLI, the settings merge and the rule filter
tests/                    the tests for tools/, bin/ and hooks/
bin/deploy                installs everything above
bin/cc-dd-path            prints the shared Xcode build folder for a worktree
bin/cc-task-new           writes a backlog ledger, or makes a task's branch and worktree
bin/cc-worktree-retire    archives a worktree's ledger, then removes the worktree
bin/cc-ledgers            keeps ~/.claude/ledgers.json, the list of every task ledger
CONTRIBUTING.md           forking, what to send back, what must never be committed
```

## Notes

Agents you add under `~/.claude/agents/` that are not in this repo are left
alone by deploy. Keep private or employer-specific agents there, not here.

No secrets belong in this repo. Nothing here reads a key or a token.
