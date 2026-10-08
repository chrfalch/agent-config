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

- Every non-trivial task has a ledger at `.claude/ledger.md` inside its worktree,
  created from `~/.claude/ledger.template.md` when the plan is approved. It holds:
  goal, approved plan with per-step status, decisions and the reason for each,
  constraints discovered, worktree path and branch, subagent reports (the
  structured report, not the transcript), open questions, and the exact next step.
  If the worktree does not exist yet at plan approval, create it first, then the
  ledger. The ledger lives at `.claude/ledger.md` relative to the session's
  working directory: the main checkout when you run one session for the task,
  the worktree when you run one session per worktree. The SessionStart hook
  reads both.
- **Update the ledger at every pipeline boundary**: after plan approval, after red
  tests, after each implementer report, after each review verdict. Write facts,
  not narrative. Keep it under ~4k tokens; roll finished steps into one line each.
  During long in-thread reasoning, also write each decision and each ruled-out
  option to the ledger as you make it, so a compaction mid-problem loses only the
  current step.
- **Clear between cycles.** You cannot see your own context size and you cannot
  run `/clear`; the user does. So the trigger is structural and you announce it:
  whenever an implement→review cycle finishes **and more work remains**, update
  the ledger, then stop and say: "Clear point. Ledger updated. Run `/clear`,
  then say: go." The SessionStart hook puts the ledger back in context, so the
  user types nothing else. Do not start
  the next cycle in the same session. When the review
  verdict is the last one, accept and finish — a clear before acceptance saves
  nothing. A cold start from the ledger costs a few thousand tokens; carrying the
  previous cycle into the next costs that on every turn. Auto-compact is a last
  resort near the top of the window, not a ceiling.
- **Resume from the ledger.** A SessionStart hook puts `.claude/ledger.md` in
  your context when it exists, or a summary of each when several exist. On
  "go", continue from that ledger's Next step. When several ledgers exist, ask
  which task first, then read its full ledger.
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

- Retire a worktree with `bin/cc-worktree-retire <worktree> [--force]` from the
  agent-config repo. It copies `.claude/ledger.md` to
  `~/.claude/ledger-archive/<repo>/<YYYY-MM-DD>-<slug>.md`, checks the copy,
  then runs `git worktree remove`. Running it twice archives once.
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

## Compact Instructions

The ledger is the state, and the Checkpoint gate says what goes in it. Preserve
above all else the worktree path, the branch, and the path to `.claude/ledger.md`.
Then preserve only what is not yet written to the ledger: the current subagent
report, verbatim if under 300 words, tests still red, and the exact next step.

Drop: file contents already committed, tool output, exploration that led nowhere,
and any subagent transcript. If the ledger is current, the summary may simply point
to it.
