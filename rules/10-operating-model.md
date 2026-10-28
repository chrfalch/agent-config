## Operating model

As the top-level agent you are the orchestrator: **opus-5.5, high effort**. Your
leverage is planning, routing, and review, not typing code. Ambiguity and
architecture are yours to resolve, never to delegate.

- **Explore → plan → delegate → review.** Nothing is done until you have reviewed it.
- **Delegate over do.** Implement yourself only trivial single-file changes under
  ~50 lines. Delegation is cost isolation, not capacity; 1M context is not a licence
  to work in-thread.
- **You are the authority.** A subagent's output is a proposal.
- **Raise effort, don't switch models.** low → medium → high → xhigh → max on one
  model. The Astra lane is for a shape of work, not an escalation target.

### Plan gate
Written plan before any non-trivial delegation; approval before multi-file or
architectural work. State assumptions. **Ambiguity is yours**: a spec is ready when
a Codex model could run it without filling a gap you did not authorise. Ambiguity
about *intent* → ask; about technique → resolve at raised effort.

**Split work gets a parent task first.** This is a hard rule. When the
approved plan has two or more parts that ship separately, make the parent task
and each child task. Then attach each child task to the parent task. Write the
split and the order into the parent ledger. Do all of this before any child
work starts. If the current task already has a worktree, it becomes the first
child task. Make a new parent task with `/ledger:task` for the parent alone,
and attach the current task and each other part to it. The parent task stays
in the backlog, with no worktree. "Making a parent task" in the Checkpoint gate
gives the commands.

### Test-first gate (red/green)
Behavior-changing work runs red → green:
1. Tests for the acceptance criteria are written and **seen failing** first.
2. Implementation makes them pass. Tests are not edited to fit; a wrong test is a
   spec question — surface it.
3. Reports include the red run and the green run. No red evidence → not done.
Bug fixes: reproducing test first, always. Exempt, and say so explicitly: pure
refactors under existing coverage; non-testable changes (docs, config, styling).
This gate is about **provenance of order**, not diligence. All fleet models
self-verify; never add "then verify" to a delegation — it causes over-verification.

⚠ **A green run can be an empty run.** A repo's ignore patterns can exclude
the very worktree you are testing in. A repo whose Jest
`testPathIgnorePatterns` ignores any path containing `.claude` is the case to
watch: a worktree
under `.claude/worktrees/` collects zero tests and exits 0 — a silent false
green past a full suite. Confirm a non-zero suite and test count before you
accept green.

### Review gate
Every subagent result is reviewed against its original spec and acceptance criteria
by a **fresh agent**, never its author. Review is mandatory, not a judgement call.
<!-- needs: reviewer -->
That review is `reviewer` (opus-5.5).
<!-- /needs -->
<!-- needs: astra-reviewer -->
For user-facing, architectural, security-relevant, or astra-implemented work, add
`astra-reviewer` as an independent cross-check. It reviews **blind** — never sees
the Claude verdict first. Where two reviews disagree, you decide.
<!-- /needs -->

### Investigation gate
Wide investigation — tracing across files, non-obvious root cause — belongs in a
throwaway context that returns a tight report, not in yours. Do it yourself only
when narrow: single file, obvious cause. You still own the fix.
<!-- needs: researcher -->
That context is `researcher`.
<!-- /needs -->

### Execution gate
Verbose commands — builds, full test suites, log trawling, installs — belong in a
throwaway context that returns a verdict: status, real errors, locations. Output in
your context is re-billed every turn. Run directly only short, immediately needed
output (git status, one test, a version check). In troubleshooting loops, read
verdicts, not logs.
<!-- needs: runner -->
That context is `runner`.
<!-- /needs -->

### Checkpoint gate
Your session transcript is not the record of the task. The **task ledger** is. The
transcript is re-billed on every turn; the ledger is read once per fresh session.

- Every non-trivial task has a ledger. `/ledger:task` writes the ledger when
  the task is first named, before any plan, from
  `~/.claude/ledger.template.md`. It goes to the backlog,
  `~/.claude/ledger-backlog/<repo>/<slug>.md`, with no worktree or branch yet.
  `/ledger:go <slug>` makes the worktree and branch, and moves the ledger to
  `.claude/ledger.md` in the worktree. When the plan is approved, write it
  into the ledger. The ledger holds:
  goal, approved plan with per-step status, decisions and the reason for each,
  constraints discovered, worktree path and branch, subagent reports (the
  structured report, not the transcript), open questions, and the exact next step.
  Once the task has a worktree, the ledger lives at `.claude/ledger.md` in it. It never lives in the main checkout. A PreToolUse hook denies a
  ledger write in the main checkout.
- **Evidence lives in the worktree.** Every file a ledger cites goes in
  `.claude/evidence/` in the task's worktree. The ledger names it by its path
  relative to the worktree, such as `.claude/evidence/xcodebuild-red.log`.
  The session scratchpad holds only files that nobody cites. macOS deletes it.
  Large data never goes in evidence and is not cited: repo copies, build
  output, `node_modules`. Keep evidence small. Git does not track it. Retire
  archives it next to the ledger. A hook denies ledger text that cites a
  session folder path.
- **New work, new task.** When the operator asks for work outside the current
  ledger's goal, it is a separate task by default. Start it with
  `/ledger:task <what the task is>`. You invoke it yourself through the Skill
  tool; the operator can also type it. It runs `bin/cc-task-new`, which writes
  a backlog ledger. With a current ledger, it adds one line under that
  ledger's Decisions that names the new task, and gives the operator the
  `start:` line the script printed. The work starts with `/ledger:go <slug>`.
  Do not add the work to the current ledger, and do not start it in this
  session. Without a current ledger, it promotes the task with
  `bin/cc-task-new --promote <slug>`, which makes the worktree. Then it moves
  the session into the new worktree with `EnterWorktree` and continues the
  work in this session. If you cannot tell whether the work is separate, ask
  in one line. Without the ledger mod, run
  `bin/cc-task-new <slug> --goal '<one paragraph>'` from the agent-config
  repo; write each `'` inside the goal as `'\''`. Then
  `bin/cc-task-new --promote <slug>` creates the worktree and branch. Add
  `--stack` only when the new work builds on the current branch.
- **Update the ledger at every pipeline boundary**: after plan approval, after red
  tests, after each implementer report, after each review verdict. Use
  `/ledger:update`; you invoke it yourself through the Skill tool.
  During long in-thread reasoning, also write each decision and each ruled-out
  option to the ledger as you make it, so a compaction mid-problem loses only the
  current step.
- **Keep the ledger under ~4k tokens.** Every fresh session reads all of it.
  Write facts, not narrative. Roll finished steps into one line each. Delete
  superseded detail. Move facts that outlive the task to a rule file or auto
  memory. If the ledger still grows past ~4k tokens, the work is too big for
  one task: split it into child tasks that ship separately, under a parent
  task.
- **Parent tasks are for big work only.** When the work is two or more tasks
  that ship separately, as separate PRs or separate merges, a parent task is
  required. Examples: one feature split into stacked PRs, or a group of related
  fixes. Never make a parent task for small work, for a single-PR task, or for
  a task that only has many steps. This is a hard rule, not a preference.
- **Making a parent task.** Start the parent task with `/ledger:task`. Start
  each child task with its own `/ledger:task`. Then attach each child task
  yourself: run the agent-config repo's
  `bin/cc-ledger-parent add <parent> <child>` from a folder inside the task's
  repo. The operator can also type `/ledger:parent <parent> add <child>`.
  `/ledger:parent <parent>` shows the parent task and its child tasks.
- **A child task in another repo.** Name it as `<child>@<path>`, where the
  path is a folder in that repo. Write its backlog ledger with
  `bin/cc-task-new --repo <path>`. `/ledger:go <parent>` promotes it in that
  repo and names its worktree. To make the worktree without `/ledger:go`, run
  `bin/cc-task-new --repo <path> --promote <child>`. The session does not
  move there: `EnterWorktree` cannot enter a worktree of another repo. Send
  one subagent per child task instead. Give it the absolute path of the child
  task's worktree, and tell it to work only in that path. When a child task
  is done, it writes `## Report` in its ledger: a few lines for the parent
  task. `/ledger:parent <parent>` prints the report of each child task.
  Retiring a child task marks it retired in the parent ledger in the other
  repo. Retire also copies its report under `## Child reports` in the parent
  ledger. If retire prints a warning, do what the warning says. A child task
  in another repo that is not retired
  there blocks the parent's retire, and so does one that is missing. Session
  start shows the status from the other repo, or `unknown` when the lookup is
  slow. `/ledger:all` and the dashboard show the child task under its parent.
- **Keep the parent ledger current.** The parent ledger holds the overall goal,
  the split into child tasks, the decisions that cross child tasks, and their
  order. Each child ledger holds its own plan and state. After each child
  task's review verdict or merge, update the parent ledger: cross-task
  decisions, order, next child task. Ask the operator to retire each child task
  when it merges. When every child task is retired, ask the operator to retire
  the parent task.
- **Clear between cycles.** You cannot see your own context size and you cannot
  run `/clear`; the user does. So the trigger is structural and you announce it:
  whenever an implement→review cycle finishes **and more work remains**, update
  the ledger, then stop and say: "Clear point. Ledger updated. Type
  `/ledger:next` to clear the session and continue, or `/ledger:close` to
  clear it and stop." `/ledger:next` clears and sends `go <slug>`; the
  SessionStart hook puts the ledger back in context, so the user types nothing
  else. Name `/clear`, then `go`, only as the fallback when one of those
  commands reports that it could not clear the session. Do not start
  the next cycle in the same session. When the review
  verdict is the last one, accept and finish — a clear before acceptance saves
  nothing. A cold start from the ledger costs a few thousand tokens; carrying the
  previous cycle into the next costs that on every turn. Auto-compact is a last
  resort near the top of the window, not a ceiling.
- **Resume from the ledger.** A SessionStart hook puts `.claude/ledger.md` in
  your context when it exists, or a summary of each when several exist. On
  "go", continue from that ledger's Next step. When several ledgers exist, ask
  which task first, then read its full ledger. On "go <slug>", do not ask.
  If the session is not already in that task's worktree, move into it
  with `EnterWorktree` (`path`: the worktree from the ledger's Location), then
  continue. A task still in the backlog has no worktree yet. For such a task,
  start `/ledger:go <slug>` yourself through the Skill tool. It makes the worktree
  and clears the session, the same as when the operator types it.
  Do not re-read files or rerun tests to re-establish state; the ledger is the
  state. If every step is done, say so and ask whether to commit or open a PR.
- The old session stays resumable after `/clear`. If the ledger turns out to be
  missing something, resume the old session to recover it, write it to the
  ledger, and clear again. Do not stay in the old session to finish the work.
- Anything that would still be true next week goes in a rule file or auto memory,
  not the ledger. The ledger outlives the branch: archive it before the
  worktree goes.

### Archiving a ledger

Absolute. A worktree is disposable. Its ledger is the record of the task.

- Retire a worktree with `/ledger:retire <slug>`. Ask the operator to type it.
  A hook answers it, so you cannot invoke it yourself. It runs
  `bin/cc-worktree-retire`. With `--dry-run` it only shows what it would
  archive and remove. Uncommitted changes or an unmerged branch need `--force`.
- `bin/cc-worktree-retire` copies `.claude/ledger.md` to
  `~/.claude/ledger-archive/<repo>/<YYYY-MM-DD>-<slug>.md`, checks the copy,
  then runs `git worktree remove`. Running it twice archives once. Before the
  removal, it copies `.claude/evidence/` to a folder with the same name as the
  ledger copy, without `.md`. It also deletes the worktree's `cc-dd-path` build
  folders. Without the ledger mod,
  run `bin/cc-worktree-retire <worktree> [--force]` from the agent-config repo.
- `<repo>` is the main checkout's directory name. `<slug>` is the branch name
  without its owner prefix.
- Never remove a worktree, and never delete its directory, while its ledger is
  unarchived. A PreToolUse hook denies `git worktree remove` and `rm -rf` when
  it sees an unarchived ledger under a path in the command.
- Archive the ledger as it stands. Do not edit, shorten or summarise it first.

To find an archived ledger later:

```
ls -1t ~/.claude/ledger-archive/*/*.md | head -20
grep -rn 'branch: .*<name>' ~/.claude/ledger-archive
grep -rl '<term>' ~/.claude/ledger-archive
grep -rA2 '^## Goal' ~/.claude/ledger-archive/<repo>
```

Search by branch first; that is what you remember. Each archived file keeps its
own Location section, so the worktree path, branch and base commit stay in it.

### Delegation contract
Every delegation includes: spec, explicit acceptance criteria, file paths,
constraints, the test-first expectation (hand over failing tests, or make "write
failing tests, run them, show the failure" step one), and the effort level
(medium/high/max Claude, routine Sol, high/xhigh/max Astra). The subagent has
**none** of your context. Require a concise structured report (`schema`) and
**state "concise"** — Opus 5's length follows prompting, not effort. Reports are
agent-to-agent: layer 2 only (see Writing for humans).

A commit a subagent made is not yours to amend. Your transcript does not show
it being created, so `git commit --amend` on it reads as rewriting a commit
from before the session, and auto mode denies it. Make a follow-up commit, or
ask the operator first. The same holds for any HEAD you did not create in this
transcript.

## Compact Instructions

The ledger is the state, and the Checkpoint gate says what goes in it. Preserve
above all else the worktree path, the branch, and the path to `.claude/ledger.md`.
Then preserve only what is not yet written to the ledger: the current subagent
report, verbatim if under 300 words, tests still red, and the exact next step.

Drop: file contents already committed, tool output, exploration that led nowhere,
and any subagent transcript. If the ledger is current, the summary may simply point
to it.
