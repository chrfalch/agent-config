---
description: Write the latest results to this task's ledger
---

If `.claude/ledger.md` exists in the current working directory, this session
is in a task worktree. Update that ledger:

1. Use Edit. Never rewrite the whole file.
2. Write facts, not narrative:
   - the status of each plan step;
   - each subagent's structured report, not its transcript;
   - each decision, with its reason;
   - the exact next step.
3. Roll each finished step into one line. Keep the ledger under about 4k
   tokens.
4. End your reply with one line. If an implement→review cycle just finished
   and more work remains, use exactly this line:

   Clear point. Ledger updated. Type `/ledger:next` to clear the session and continue, or `/ledger:close` to clear it and stop.

   Otherwise, say only that the ledger is updated. After the last review
   verdict there is no clear point: accept the work and finish.

If `.claude/ledger.md` does not exist, create nothing. Tell the operator to use
`/ledger:task <what the task is>`. A ledger lives only in a task worktree, and
this command only saves an open task.
