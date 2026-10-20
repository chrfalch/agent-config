---
description: Start a separate task with its own git worktree, branch and ledger. `--here [<slug>]` adds a ledger to the current linked worktree instead.
argument-hint: "<what the task is> | --here [<slug>]"
---

The operator asks for a separate task: $ARGUMENTS

If that request starts with `--here`, the operator wants a ledger for the
linked worktree this session is in, not a new worktree:

1. Take the slug from the word after `--here`, if there is one. Without it,
   the script names the task after the branch, without its owner prefix.
2. Write a one-paragraph goal from this conversation. State the problem first,
   then what done looks like. If the conversation does not show the goal,
   leave out `--goal`.
3. Run the script as in step 4 below, with `--here [<slug>]` in place of
   `<slug>`. Never add `--stack`, `--base` or `--branch`: the script refuses
   them with `--here`. It also refuses the main checkout and a worktree that
   already has a ledger; then reply with its error and stop.
4. Reply with the `ledger` line the script printed. This session already works
   in that worktree, so do not offer `/ledger:go`.

Otherwise, if that request is empty, ask what the task is and stop.

1. Pick a short kebab-case slug for the task, such as `fix-login`.
2. Write a one-paragraph goal. State the problem first, then what done looks
   like.
3. Add `--stack` only if the work builds on the current branch.
4. Run the script from the agent-config repo. The repo is two directories
   above the real path of `~/.claude/rules/10-operating-model.md`. Put the goal
   in single quotes, and write each `'` inside it as `'\''`:

   ```bash
   f=~/.claude/rules/10-operating-model.md
   while [ -L "$f" ]; do
     l=$(readlink "$f")
     case "$l" in /*) f="$l" ;; *) f="$(dirname "$f")/$l" ;; esac
   done
   "$(cd -P "$(dirname "$f")/.." && pwd)/bin/cc-task-new" <slug> --goal '<goal>'
   ```
5. If this session has a current ledger, add one line under its Decisions that
   names the new task.
6. Reply with the `start:` line the script printed, and nothing else of
   substance.

Do not plan the task and do not start it in this session.
