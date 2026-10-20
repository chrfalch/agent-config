---
needs: gh-stack
---

## Stacked PRs

This section applies only where the `gh stack` extension is installed. Ignore it
otherwise.

Stacks are the orchestrator's. Implementers and reviewers never run `gh stack`.

- Open the first PR, then `gh stack link` to attach it to its parent.
- `gh stack sync` after a parent branch moves, before you touch a child.
- Rebase a child onto its parent. Never merge a parent into a child.
- Merge bottom-up: a child does not merge before its parent.
- One ledger per stack entry. Three stacked PRs are three worktrees, three
  ledgers, three clear-point cycles.
- One parent task per stack. Each stacked PR is a child task of it. The parent
  ledger tracks the stack order. A parent task is a ledger relation, not a
  parent branch; the Checkpoint gate says how to make one.
- Writing for humans applies to every PR in the stack. Each description states
  in plain words what it depends on.
