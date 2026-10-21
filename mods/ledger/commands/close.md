---
description: Write the latest results to this task's ledger, then clear the session
---

The ledger hook replaces the operator's argument with one line:

```
$ARGUMENTS
```

If the line is `ledger: none`, this session's folder no longer exists, so
there is no ledger to update. Write nothing and create nothing. Reply with one
line: there was no ledger to update, and the session clears automatically
after this turn. Stop there.

Otherwise the line is `ledger: <path>`. Update the ledger at that path. It
exists: the command checked that before this prompt ran. Do not start a task.

1. Use Edit. Never rewrite the whole file.
2. Write facts, not narrative:
   - the status of each plan step;
   - each subagent's structured report, not its transcript;
   - each decision, with its reason;
   - the exact next step.
3. Roll each finished step into one line. Keep the ledger under about 4k
   tokens.
4. End your reply with one line saying the ledger is updated and the session
   clears automatically after this turn. Do not ask the operator to run
   `/clear`.
