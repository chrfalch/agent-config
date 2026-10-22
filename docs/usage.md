# Using the setup

This page describes the daily loop: what you do, what the orchestrator does, and
how the ledger and `/clear` keep a long task cheap.

## The parts

The **orchestrator** is your top-level Claude Code session. It plans, routes,
and reviews. It does not usually write code.

The **subagents** do the expensive work in their own contexts and return short
reports. See [fleet.md](fleet.md).

The **ledger** is a file at `.claude/ledger.md` in the task's worktree. It is
the state of the task.

The **hooks** read the ledger into a session at start, and protect it when a
session compacts.

## The pipeline

```
investigate -> resolve ambiguity -> plan -> ledger -> red tests -> implement
            -> verify -> review -> clear point (if more remains) -> you accept
```

Three things need you: plan approval, typing the `start:` line that a new task prints when another task is open, and typing `/ledger:next` at a clear point.

## A worked example

The task: an offline write queue drops items when the app restarts mid-sync.

### 1. You describe the task

```
There's a bug: items in the offline queue disappear if the app is killed
during a sync. Repo is ~/repos/acme/mobile.
```

This is a new task, so the orchestrator invokes
`/ledger:task` before it plans anything. The command writes a ledger from
`~/.claude/ledger.template.md`, with the goal filled in. The ledger goes to the
backlog, `~/.claude/ledger-backlog/mobile/offline-queue-loss.md`. There is no
branch or worktree yet.

No task is open, so the session has nothing to clear. The command starts the
task at once. It makes a branch and a worktree, and moves the ledger into the
worktree. The branch starts at the `--base` ref given when the task was
written. Without one, it starts at the commit that `origin/HEAD` points to.
Nothing fetches first, so that commit is from your last `git fetch`. Without
`origin/HEAD`, the branch starts at the branch that the main checkout is on.
The command then moves the session into the new worktree with the
EnterWorktree tool. The orchestrator continues there without `/ledger:go`.

When another task is open, the command does not start the new task in this
session. The ledger stays in the backlog, and the command replies with one
line:

```
start:   /ledger:go offline-queue-loss
```

You type that line. `/ledger:go` makes the branch and the worktree the same
way, and moves the ledger into the worktree. The session then clears and
continues in the task's worktree.

### 2. The orchestrator investigates

The cause is not obvious from the error, so it delegates to `researcher`. The
search happens in the researcher's context. What comes back is a short report,
not a file dump.

> `researcher` report: `flushQueue()` in `src/sync/queue.ts:88` removes items
> from storage before the network call resolves. A kill between the two loses
> them. Persistence is in `src/sync/storage.ts`; two callers, both in
> `src/sync/index.ts`.

### 3. It writes a plan and asks you

> Plan:
> 1. Failing test: queue survives a kill between removal and acknowledgement.
> 2. Move removal after acknowledgement; add an in-flight marker.
> 3. Failing test for a duplicate send after a crash, then de-duplicate on id.
>
> Assumption: at-least-once delivery is acceptable, duplicates are not.
> Approve?

You answer `yes`.

### 4. It writes the plan into the ledger

After approval the orchestrator writes the plan into the ledger from step 1.
It looks like this:

```markdown
# Task ledger — offline-queue-loss

## Goal
Items in the offline write queue survive an app kill during sync, with no
duplicate sends after restart.

## Location
- worktree: ~/repos/acme/mobile/.claude/worktrees/offline-queue-loss
- branch: fix/offline-queue-loss
- base: main

## Plan (approved 2026-09-30)
| # | step | status | owner | note |
|---|------|--------|-------|------|
| 1 | failing test for kill during flush | todo | opus-implementer | |
| 2 | remove after ack, in-flight marker | todo | opus-implementer | |
| 3 | de-duplicate on id | todo | sol-implementer | |

## Decisions
- At-least-once delivery, de-duplicate on id — approved by operator.

## Next step
Step 1: delegate to opus-implementer at medium effort, write the failing test.
```

### 5. Red, then green

The implementer writes the test and runs it. The failing run is evidence, and it
goes in the report. Then the implementation makes it pass. Tests are never
edited to fit the code; if a test looks wrong, that is a question for you.

### 6. Verify and review

`runner` runs the full suite and returns a verdict, not the log. `reviewer` —
a fresh agent, never the one that wrote the code — checks the diff against the
spec and the acceptance criteria. On user-facing, architectural, or
security-relevant work, `astra-reviewer` adds a second, independent verdict.

The ledger now reads:

```markdown
| 1 | failing test for kill during flush | done | opus-implementer | red run 1 fail, green after step 2 |
| 2 | remove after ack, in-flight marker | reviewed | opus-implementer | reviewer: pass |
| 3 | de-duplicate on id | todo | sol-implementer | |

## Next step
Step 3: delegate to sol-implementer, de-duplicate on id in flushQueue().
```

### 7. Clear point

Steps 1 and 2 are done and step 3 remains, so the orchestrator stops:

> Clear point. Ledger updated. Type `/ledger:next` to clear the session and continue, or `/ledger:close` to clear it and stop.

You type:

```
/ledger:next
```

It clears the session and sends `go <name>`, so the fresh session continues
from the ledger. `/ledger:close` clears without continuing. If either command
cannot clear the session, it says so; then type `/clear`, then `go`.

When every plan step of the task is done, `/ledger:next` first shows one line
in the fresh session on how to retire the task:

- The branch is merged: ``Task <name> is finished and merged. Retire it with `/ledger:retire <name>`.``
- The branch has an open PR: ``Task <name> is finished. After PR #<n> merges, run `/ledger:retire <name>`.``
- Anything else, or git or gh could not tell: ``Task <name> is finished. Run `/ledger:retire <name> --dry-run` to see what blocks retiring it.``

A branch is merged when it has no commits ahead of the default branch on
origin, or when a PR from it was merged. This is the rule `/ledger:retire` uses.

A session sees only the ledgers of its own repo. `/ledger:all` lists every task
ledger on the machine, from every repo, with its next step. `/ledger:all --scan`
rebuilds that list from the ledgers on disk. Backlog tasks have their own
section, and the title line counts the tasks, the active ones and the backlog
ones.

A backlog task is one that `/ledger:task` wrote and that has no worktree yet.
The SessionStart hook does not show backlog tasks. `/ledger:go <name>` starts
one only from a session in its own repo. From another repo, it names that repo
and changes nothing. `/ledger:task --stack` and `/ledger:task --here` skip the
backlog: the task has its worktree at once.

The SessionStart hook reads the ledger into the fresh session. The session knows
the goal, the worktree, what is done, and the next step. It continues with step
3. You type nothing else.

### 8. Accept

When the last review passes, there is no clear point — a clear before acceptance
saves nothing. The orchestrator reports the result and asks whether to commit or
open a PR.

## The ledger in detail

### Why it exists

Your session transcript is re-read, and re-billed, on every turn. The ledger is
read once per session. So the record of the task lives in the file, not in the
conversation.

### What goes in it

Facts, not narrative: the goal, the worktree path and branch, the approved plan
with a status per step, each decision with its reason, constraints found along
the way, the structured report from each subagent, open questions, and exactly
one next step.

Keep it under about 4k tokens. Every fresh session reads it whole. Finished
steps roll up into one line each. Superseded detail is deleted, and facts that
outlive the task move to a rule file or memory. A ledger that keeps growing
past the limit anyway is a sign that the work is too big for one task. Split
it into a parent task with child tasks; see [Parent tasks](#parent-tasks).

### What does not go in it

Anything that will still be true next week. That belongs in a rule file or in
memory. The ledger dies with the branch.

### When it is written

At every pipeline boundary: after plan approval, after the red tests, after each
implementer report, after each review verdict. During long reasoning, decisions
and ruled-out options are written as they are made, so a compaction mid-step
loses only that step.

### Reading it

Do not `cat` the ledger. The SessionStart hook has already put it in context.

### Several tasks at once

One ledger per task, and one per stacked PR. If more than one ledger exists, the
hook shows a summary of each and the session asks which task you mean before
reading the full file. Type `go <name>` to answer in advance. The session then
moves into that task's worktree and continues from its ledger.

To give a linked worktree that has no ledger one, type `/ledger:task --here` in
its session. It adds the ledger without a new branch or worktree.

To set a task aside, type `/ledger:park <reason>` in its session. To set
another task aside, type `/ledger:park <name> <reason>`. `/ledger` shows a
parked task with the date and the reason. `/ledger:go <name>` resumes it and
removes the mark.

`/ledger:go <name>` and `/ledger:park <name> <reason>` work from any worktree
of the repository: the main checkout or a task worktree.

When the task you leave with `/ledger:go <name>` has every plan step done,
the fresh session first shows the same retire line as `/ledger:next`.

When a task is done, `/ledger:retire <name>` archives its ledger and removes
its worktree. Add `--dry-run` to see what it would do first. It also deletes
the local branch when every commit on it is in the default branch or in a
merged PR. A branch with commits after its PR merged stays.
`/ledger:archive <term>` finds the ledger of a task that was retired. Add
`--all` to search the archive of every repo.

A backlog task of this repo can be retired the same way, for example a parent
task whose work all shipped in its child tasks. It has no worktree and no
branch, so `/ledger:retire <name>` archives its ledger, then deletes the
backlog file. A backlog task of another repo is not found.

### Parent tasks

A parent task ties together two or more tasks that ship separately: one
feature split into stacked PRs, or a group of related fixes. Each of those
tasks is a child task. Do not make a parent task for a single PR, or for a task
that only has many steps.

A parent task is a normal task. Start it with `/ledger:task`, and start each
child task with its own `/ledger:task`. Then attach each child task:

```
/ledger:parent <parent> add <child>
```

The orchestrator attaches child tasks itself. It runs
`bin/cc-ledger-parent add <parent> <child>` from the agent-config repo, in a
folder inside the task's repo. Retiring a task stays with you.

A task becomes a parent task when its first child task is attached. There is
no flag that starts a task as a child task.

The parent ledger holds the overall goal, the split into child tasks, the
decisions that cross tasks, and the order. Each child ledger holds its own plan
and state. After a child task's review verdict or merge, update the parent
ledger.

`add` writes two ledgers and the task list:

- The child ledger gets `- parent: <parent>` under `## Location`. This line is
  the source of truth.
- The parent ledger gets `- <child>` under `## Children`.
- The child's entry in `~/.claude/ledgers.json` gets a `parent` field.
  `/ledger:all --scan` rebuilds it from the ledger text.

`/ledger:parent <parent> remove <child>` undoes all three. The command refuses
a relation that breaks one of these rules:

- The parent task and the child task are in the same repo.
- A task cannot be its own parent task, and the relation cannot make a cycle.
  When a task is already the parent task of `<parent>`, or of one of its
  parent tasks, the command refuses to make it a child task of `<parent>`.
- A child task has at most one parent task. A child task can have child tasks
  of its own, so a tree can be deeper than one level.
- A retired child task's name cannot be attached to the same parent task
  again.

`/ledger:go <child>` marks the child task started: its line in the parent
ledger becomes `- <child> (started YYYY-MM-DD)`. A line that already has a mark
keeps it. When the mark cannot be written, the command says so and still
continues in the child task.

`/ledger:go <parent>` starts a child task instead of the parent task. It picks
the first line under `## Children` that has no mark and whose task is in the
backlog, in the order of the lines. When that child task has child tasks of its
own, it picks one of those the same way. A child task with none left to start
is passed over. The reply names the picked child task and the parent task.

When no child task is left to start, the command continues in the parent task
if the parent task has a worktree. A parent task in the backlog stays there:
the command lists its child tasks with their status, and changes nothing.

Both steps run `bin/cc-ledger-parent`: `start <parent> <child>` writes the
mark, and `next <parent>` prints the child task to start.

`/ledger:parent <parent>` prints the parent task, then one line per direct
child task: its name, its status (`active`, `parked`, `retired` or `missing`)
and its next step. Without a name, it shows the current task when it has child tasks, or
else the current task's parent task.

The other commands show the relation too:

| Where | A parent task | A child task |
|---|---|---|
| `/ledger` | `- **Children:**`, then each child task with its goal, step and next step. A parent task in the backlog of this repo is listed too, as `<parent> (backlog)`, and so is a parent task active in another worktree of this repo; the same holds for the parent of that parent, and so on | Under its parent task, one indent deeper for each level; shows `- **Parent:** <parent>` when the parent is not listed |
| `/ledger:all` | Its child tasks follow it as `↳ <child>`, one indent deeper for each level | `<child> (parent: <parent>)` when the parent is not listed |
| `/ledger:go` with an unknown name | `<parent> (children: <a>, <b> (children: <c>))` | `<child> (parent: <parent>)` when the parent is not listed |
| `/ledger:go <name>` | Starts its first child task not yet started, and names it. With none left, a line that lists its child tasks with their status | A line that names its parent task; marks the child task started |
| `/ledger:worktrees`, ledger column | `parent of <n>`, where n counts the child tasks not retired | `child of <parent>` |
| Session start | `Child task: <child> (<status>).` or `Child task: <child> (retired YYYY-MM-DD).`, one line per child task | `Parent task: <parent> (<status>).` |

When a child task merges, retire it with `/ledger:retire <child>`. Its
line in the parent ledger, with or without a started mark, becomes
`- <child> (retired YYYY-MM-DD)`. A started child task still counts as
active. When no
active child task remains, the command prints:

```
Parent <parent> has no active children left. Retire it with /ledger:retire <parent>.
```

It does not retire the parent task itself. To retire a parent task that still
has active child tasks, add `--force`; without it the command refuses.
`--dry-run` names those child tasks. Only direct child tasks count, here and
in the `parent of <n>` count.

The parent task can be in a worktree or in the backlog of this repo. Either
way, its line for the child task is marked retired.

### The dashboard

`/ledger:dashboard` starts a web page on this machine that shows every task
ledger, the same list as `/ledger:all`. The page starts with a list of the
repositories. Each one shows its number of tasks and how many have each status.
Click a repository to see its tasks. You can filter them by status, and search
the text of their ledgers. You can select more than one status; the list then
shows the tasks with any of them. With no status selected, it shows every task.
A child task comes right after its parent task, with a `↳` before its name,
as in `/ledger:all`. A child that is not right under its parent stays in the
list as a normal row and shows `parent: <name>`. This happens when a filter
hides the parent, and for a child of a child. Click that name to read the
parent's ledger. When the parent's ledger is not found, the name is plain text.
**All repositories** goes back to the list, and so does the browser's Back
button. The address names the open repository and the selected statuses, so a
reload, Back and Forward show them again. The status filter stays when you open
another repository. A selected status that this repository has no tasks with
does not filter here; it filters again in a repository that has it.
Click a task to read its ledger, its worktree, its branch and its PRs. Its
buttons copy `go <name>`, park a task with a reason, remove the parked mark,
and retire a task. Retire first shows what it would do and waits for a second
click. When the task has uncommitted changes or an unmerged branch, that click
is **Retire anyway (--force)**. These are the same rules as `/ledger:retire`.
The dashboard refuses to retire a task in the backlog, because it has no
worktree yet.

The command prints an address like `http://127.0.0.1:<port>/#key=<key>`. Open
it in a browser. The key in the address is the password for the page: each
start makes a new one, and the server refuses every request without it. The
server answers only on this machine.

The dashboard keeps running after the Claude Code session ends. Type
`/ledger:dashboard` again to see its address. Type `/ledger:dashboard stop` to
stop it. Its log is `~/.claude/ledger-dashboard.log`.

## The clear loop, in short

```
implement -> review -> ledger updated -> "Clear point" -> /ledger:next -> next step
```

Why it is worth the keystrokes: a cold start from the ledger costs a few
thousand tokens, once. Keeping a finished cycle in context costs those tokens on
every remaining turn of the task.

Two limits are worth knowing. The orchestrator cannot see its own context size
and cannot run `/clear` itself, so the trigger is structural — a cycle finished,
more work remains — and it always announces it. And auto-compaction is a last
resort near the top of the window, not a ceiling to aim for.

If the ledger turns out to be missing something after a clear, the old session
is still resumable. Go back, recover the fact, write it to the ledger, and clear
again. Do not finish the work in the old session.

## Delegating well

The subagent has none of your context. A delegation carries the spec, explicit
acceptance criteria, file paths, constraints, the test-first expectation, and
the effort level. It also asks for a concise structured report.

Two habits matter:

- **Never add "then verify your work."** Every model in the fleet self-verifies.
  The instruction causes over-verification and costs tokens.
- **Never delegate an ambiguous spec.** A spec is ready when a Codex model could
  run it without filling a gap you did not authorize. Ambiguity about intent is
  a question for you; ambiguity about technique is resolved at higher effort.

## A trap worth knowing

A green test run can be an empty test run. A repo whose Jest
`testPathIgnorePatterns` excludes any path containing `.claude` will collect
zero tests inside a worktree under `.claude/worktrees/`, and exit 0. That reads
as a full pass. Confirm a non-zero suite and test count before accepting green.
