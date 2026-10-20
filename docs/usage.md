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

Three things need you: plan approval, typing the `start:` line that a new task prints, and typing `/ledger:next` at a clear point.

## A worked example

The task: an offline write queue drops items when the app restarts mid-sync.

### 1. You describe the task

```
There's a bug: items in the offline queue disappear if the app is killed
during a sync. Repo is ~/repos/acme/mobile.
```

This is a new task, so the orchestrator invokes
`/ledger:task` before it plans anything. The command creates a worktree and a
ledger from `~/.claude/ledger.template.md`, with the goal filled in. It replies
with one line:

```
start:   /ledger:go offline-queue-loss
```

You type that line. The session clears and continues in the task's worktree.

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

A session sees only the ledgers of its own repo. `/ledger:all` lists every task
ledger on the machine, from every repo, with its next step. `/ledger:all --scan`
rebuilds that list from the ledgers on disk.

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

Keep it under about 4k tokens. Finished steps roll up into one line each.

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

To set a task aside, type `/ledger:park <reason>` in its session, or
`/ledger:park <name> <reason>` in a session in the main checkout. `/ledger`
shows a parked task with the date and the reason. `/ledger:go <name>` resumes
it and removes the mark.

When a task is done, `/ledger:retire <name> --yes` archives its ledger and
removes its worktree. It also deletes the local branch when every commit on it
is in the default branch or in a merged PR. A branch with commits after its PR
merged stays. `/ledger:archive <term>` finds the ledger of a task that was
retired. Add `--all` to search the archive of every repo.

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
