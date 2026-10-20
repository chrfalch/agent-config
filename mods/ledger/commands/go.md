---
description: Write the latest results to this task's ledger, clear the session, and continue in the task named <slug>
argument-hint: <slug>
---

The ledger hook replaces the operator's argument with two lines:

```
$ARGUMENTS
```

- `task:` is the slug of the task the operator switches to. Do not start that
  task in this session: the next session does.
- `ledger:` is the absolute path of this session's task ledger, or `none`.

If `ledger:` is `none`, this session has no task ledger. Write nothing, do not
create one, and only do step 4. Otherwise, update the file at that exact path,
even when it is not in the current working directory:

1. Use Edit. Never rewrite the whole file.
2. Write facts, not narrative:
   - the status of each plan step;
   - each subagent's structured report, not its transcript;
   - each decision, with its reason;
   - the exact next step. A later session starts from it, so make it
     something a fresh session can act on without this conversation.
3. Roll each finished step into one line. Keep the ledger under about 4k
   tokens.
4. End your reply with one line saying whether the ledger is updated (or that there is none), that the
   session clears automatically after this turn, and that the new session
   continues with `go <task>`, where <task> is the `task:` value. Do not ask
   the operator to run `/clear`.
