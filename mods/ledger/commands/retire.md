---
description: Show what retiring a task would archive and remove, deleting nothing. `--yes` archives the task's ledger to ~/.claude/ledger-archive/, removes its worktree, and deletes the worktree's build folders. It also deletes the local branch when every commit on it is in the default branch or in a merged PR. A branch with commits after its PR merged stays. Uncommitted changes also need `--force`, and so does a branch that has commits not in the default branch and no merged PR. Without a slug it retires the task this session is in.
argument-hint: "[<slug>] [--yes] [--force]"
---

The ledger mod's hook answers this command, so this text reaches you only when
that hook did not answer. Say so in one line, suggest `/reload-plugins`, and do
nothing else.
