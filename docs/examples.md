# Examples

Two longer walk-throughs of the ledger in use. The README has two short ones,
in [Short examples](../README.md#short-examples).

The repository is `expo/expo`, with its main checkout at `~/repos/expo/expo`.
The tasks, commits, files and results are made up.

## Start a new task, then continue with `/ledger:next`

No task is open. You are in the main checkout.

**You:** `/ledger:task Fix: expo-image clearDiskCache() does not delete cached files on Android`

No task is open, so the task starts at once. The agent runs `bin/cc-task-new`,
which prints:

```
worktree ~/repos/expo/expo/.claude/worktrees/image-clear-disk-cache
branch   image-clear-disk-cache
base     main @ 4f2a9c1
ledger   ~/repos/expo/expo/.claude/worktrees/image-clear-disk-cache/.claude/ledger.md
```

The session moves into the new worktree and continues there.

**Agent:** The researcher found the cause. On Android, `clearDiskCache()`
clears the Glide memory cache only. The disk cache is never touched. Plan:
1. Write a test for Android that fails now. 2. Fix Android. 3. Check whether
iOS has the same problem. Do you approve?

**You:** yes

**Agent:** (writes the plan into the ledger, writes the test and sees it fail,
makes the fix, gets it reviewed, updates the ledger)

**Agent:** Clear point. Ledger updated. Type `/ledger:next` to clear the
session and continue, or `/ledger:close` to clear it and stop.

At this point the ledger holds:

```markdown
## Plan (approved 2026-10-26)
| # | step                      | status   | owner            | note                    |
|---|---------------------------|----------|------------------|-------------------------|
| 1 | reproducing test, Android | done     | opus-implementer | failed first, 1 of 1    |
| 2 | fix, Android              | reviewed | opus-implementer | 38 of 38 passed; ACCEPT |
| 3 | check iOS                 | todo     | researcher       |                         |

## Decisions
- Clear the disk cache on a background thread — because Glide forbids it on the main thread

## Next step
Step 3: researcher, medium effort. Does SDWebImage clear the disk cache on iOS?
```

**You:** `/ledger:next`

The session clears. A hook reads the ledger into the fresh session, and
`go image-clear-disk-cache` is sent for you.

**Agent:** Continuing `image-clear-disk-cache` from step 3: check iOS.

You typed three things: the task, `yes`, and `/ledger:next`.

## Put a second task in the backlog, start it later

You are working on `image-clear-disk-cache` and see an unrelated problem.

**You:** Also, the expo-router modal e2e test fails on CI about one run in
five. Can you look at that?

**Agent:** That is a separate task. It runs `/ledger:task`, which prints:

```
ledger:  ~/.claude/ledger-backlog/expo/router-modal-e2e-flake.md
status:  backlog
start:   /ledger:go router-modal-e2e-flake
```

**Agent:** I wrote it to the backlog and added one line about it to this
task's Decisions. I am continuing with `image-clear-disk-cache`.

The new task has a ledger with its goal, but no branch or worktree yet. The
current task is not changed. `/ledger:all` lists it in its **Backlog** section.

When you are ready for it:

**You:** `/ledger:go router-modal-e2e-flake`

This does four things:

1. It writes the latest results to the ledger of `image-clear-disk-cache`.
2. It creates the branch `router-modal-e2e-flake` and its worktree at
   `.claude/worktrees/router-modal-e2e-flake`.
3. It moves the backlog ledger into that worktree, at `.claude/ledger.md`.
4. It clears the session, and the fresh session continues in the new task.

Both tasks now have a worktree. Each has its own branch and its own ledger, so
work on one does not touch the other.
