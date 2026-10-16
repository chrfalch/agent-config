---
description: Write the latest results to this task's ledger, or start a task when there is none
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
4. End your reply with exactly this line:

   Clear point. Ledger updated. Run `/clear`, then say: go.

If `.claude/ledger.md` does not exist, do not create one here. A ledger lives
only in a task worktree. Start a task instead:

1. Take a short kebab-case slug and a one-paragraph goal from this
   conversation. The goal states the problem first, then what done looks like.
   If either is unclear, ask the operator in one line and stop.
2. Run the script from the agent-config repo. The repo is two directories
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
3. Reply with the `start:` line the script printed, and nothing else of
   substance.
