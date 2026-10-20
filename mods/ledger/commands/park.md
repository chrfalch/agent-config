---
description: Mark a task parked, with the date and a reason. With the slug of another task it only marks that task. Without a slug it writes the latest results to this task's ledger, parks it, then clears the session.
argument-hint: "[<slug>] <reason>"
---

The operator parks this session's task. The ledger hook replaces the
operator's argument with three lines:

```
$ARGUMENTS
```

- `task:` is the slug of this session's task.
- `ledger:` is the absolute path of its task ledger. It exists: the hook
  checked that before this prompt ran.
- `reason:` is why the operator parks the task.

Update the file at that exact path, even when it is not in the current working
directory. Do not start a task.

1. Use Edit. Never rewrite the whole file.
2. Write facts, not narrative:
   - the status of each plan step;
   - each subagent's structured report, not its transcript;
   - each decision, with its reason;
   - the exact next step. A later session resumes from it, so make it
     something a fresh session can act on without this conversation.
3. Roll each finished step into one line. Keep the ledger under about 4k
   tokens.
4. Do not write a `Parked:` line. The ledger mod adds it under `## Next step`
   after this turn.
5. End your reply with one line saying the ledger is updated, the task is
   parked, and the session clears automatically after this turn. Do not ask
   the operator to run `/clear`.
