---
description: Write the latest results to this task's ledger, clear the session, and continue from the next step
---

Update `.claude/ledger.md` in the current working directory. It exists: the
command checked that before this prompt ran. Do not start a task.

1. Use Edit. Never rewrite the whole file.
2. Write facts, not narrative:
   - the status of each plan step;
   - each subagent's structured report, not its transcript;
   - each decision, with its reason;
   - the exact next step. The new session starts from it, so make it
     something a fresh session can act on without this conversation.
3. Roll each finished step into one line. Keep the ledger under about 4k
   tokens.
4. End your reply with one line saying the ledger is updated, the session
   clears automatically after this turn, and the new session continues with
   `go <slug>`. The slug is the text after "Task ledger — " (em dash or
   hyphen) in the ledger's title. If there is no such title, or it has no
   slug, it is the name of the worktree folder. Do not ask the operator to run `/clear`.
