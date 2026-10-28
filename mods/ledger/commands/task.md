---
description: Write a backlog ledger for a separate task, with no worktree or branch yet; `/ledger:go <slug>` starts it. With no current ledger, it starts the task at once and continues in this session. `--stack` makes its worktree and branch at once, on top of the current branch. `--here [<slug>]` adds a ledger to the current linked worktree instead.
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

If the request clearly holds two or more parts that ship separately, as
separate PRs or separate merges, it needs a parent task. Write the parent
task's backlog ledger first, then the ledger of each child task, each with
steps 1 to 4 and without `--stack`. Then attach each child task in the order
they ship: run `bin/cc-ledger-parent add <parent> <child>` from the
agent-config repo, as in step 4. Write the split and the order into the parent
ledger. Never promote the parent task. Steps 5 to 7 do not apply, except that
a current ledger gets one line under its Decisions that names the parent task.
Reply with `/ledger:go <parent>` as the start line: it starts the first child
task. If the split shows up while you plan the current ledger's task, the Plan
gate applies instead: the current task becomes the first child task of a new
parent task.

1. Pick a short kebab-case slug for the task, such as `fix-login`.
2. Write a one-paragraph goal. State the problem first, then what done looks
   like.
3. Add `--stack` only if the work builds on the current branch. Without it,
   the script writes only a backlog ledger, with no worktree or branch;
   step 7 or `/ledger:go <slug>` makes them later. With it, the script makes the
   worktree and branch at once.
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
5. Check for a current ledger: `.claude/ledger.md` in the working directory of
   this session. In the main checkout, treat it as none.
6. If there is a current ledger, add one line under its Decisions that names
   the new task. Reply with the `start:` line the script printed, and nothing
   else of substance. Do not plan the task and do not start it in this
   session.
7. If there is no current ledger, there is no old task to clear. Without
   `--stack`, start the task now: run the script as in step 4 with
   `--promote <slug>` and nothing else. It makes the worktree and branch, and
   moves the ledger into the worktree. If it fails, reply with its error and
   stop. Then move this session into the new worktree with the EnterWorktree
   tool. Set `path` to the path on the `worktree` line that `--promote`
   printed, or that the script printed for `--stack`. Read `.claude/ledger.md` in
   the new worktree: the SessionStart hook does not put it in context in this
   case. Then continue with the operator's request in this session, through
   the normal pipeline: get the plan approved, then write the approved plan
   into the ledger.
