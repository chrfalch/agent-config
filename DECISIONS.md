# Decisions

Why this setup is shaped the way it is. `CLAUDE.md` holds the rules, `README.md`
holds the mechanics, this file holds the reasons. Add to it when you change
something and the reason is not obvious from the diff.

## 2026-09-17 — Source of truth

**A git repo, not Claude project knowledge.** Project files are static uploads.
They have no diff, no history and no rollback, and every change needs a manual
re-upload. A repo gives all four.

**Symlinks for what the repo owns.** `CLAUDE.md`, the agents, the ledger
template and the notes are symlinked into `~/.claude/`. Editing the repo is
deploying them, so there is no second step to forget.

**A policy merge for what it does not own.** `~/.claude/settings.json` and
`~/.codex/config.toml` hold state the apps write for themselves: plugins,
marketplaces, first-run flags, project trust levels, MCP servers. An earlier
`deploy.sh` copied those files whole, which would have reverted anything the app
wrote between deploys. Deploy now sets six named keys and leaves the rest alone.

**Codex is optional.** Four of the seven agents wrap the Codex CLI. The other
three and the whole orchestrator contract work without it, so deploy applies
Codex policy only when its config exists.

## 2026-09-17 — Security posture

**`approval_policy = "on-request"` and `sandbox_mode = "workspace-write"`.**
Neither key was set, so the setup relied on an undocumented CLI default.
CLAUDE.md demanded `untrusted`, which Codex CLI 0.153.4 does not accept; the
only values are `on-request` and `never`. `workspace-write` is the strictest
sandbox that still lets implementers write, and reviews pass `-s read-only` per
call anyway.

**The blanket trust entry was removed.** A `[projects."<home>/repos"]` entry
granted `trust_level = "trusted"` to every repository under the tree. It made
the other 33 specific entries meaningless and silently covered repos that take
outside contributions. Removing it leaves those 33 as the real list.

**Two permission prompts restored, one usage notice kept.**
`skipDangerousModePermissionPrompt` and `skipAutoPermissionPrompt` suppressed
the prompts the gates depend on. `skipWorkflowUsageWarning` is a usage notice
rather than a safety gate, so it stayed.

**Always pass `-m` to codex.** The config default model is not the one the
routing table names. Relying on it routes work to the wrong model with no error.

## 2026-09-17 — The ledger

**The ledger lives at `.claude/ledger.md` relative to the session's working
directory.** The rule used to forbid a ledger in the main checkout, but both
hooks read the current directory, and that is where the loop actually runs.

**Resume is `/clear` then `go`.** The SessionStart hook prints the ledger, so no
task name is needed. The old wording asked the user for `continue <task name>`.

**The hooks glob two worktree layouts.** Repos here use both
`.claude/worktrees/` and `.worktrees/`. The hooks covered only the first, so
some ledgers were invisible at session start.

## 2026-09-17 — CLAUDE.md

**One source per rule.** Compact Instructions restated the ledger's own
contents, and the routing bullets restated the Fleet reference table. The
duplicates went. The point was not size — the saving was one line — but that a
future edit cannot make two copies disagree.

**A green run can be an empty run.** A repo whose Jest `testPathIgnorePatterns`
ignores `.claude` collects zero tests inside a `.claude` worktree and exits 0.
That is a silent false green straight past the Test-first gate, so it is
recorded there.

**References to skills that do not exist were removed.** CLAUDE.md and three
agents pointed at `codex-implementation`, `codex-review` and
`codex-computer-use`. None of them are installed.

## 2026-09-17 — History

**Squashed to a single commit.** The first commits carried one machine's entire
Codex config: absolute paths, 33 project trust entries and a private MCP server.
Deleting the file at the tip does not remove it from history, and this repo is
meant to be shareable.

## 2026-09-22 — Context discipline

**Measured: 86.4% of the bill is context, not generation.** Eight weeks of main-thread
transcripts (131 sessions, 13,247 turns) came to $2,328 at list prices: $1,432 cache
reads, $580 cache writes, $317 output. The fleet reads 257 tokens for every one it
writes. Every earlier attempt to cut spend targeted what the model writes, which is
13.6% of the total.

**UI automation dominates per call.** `mcp__argent__*` results average ~14,000 tokens
and cost $0.64 a call, against Bash's $0.0096 — 70x. One twelve-minute run in August
cost roughly $59 because 35k-token view hierarchies were re-read 130-155 times by the
turns that followed. Hence the rule to run argent work in a subagent, where the results
die on return.

**Whole-file reads are real but small** ($18 across 169 `Read` calls), and briefs are
fine as they are — every lane returns more output than its brief costs (researcher
0.27x, reviewer 0.44x, runner 0.68x, opus-implementer 0.92x). The rules added to
CLAUDE.md are aimed at what stays in context, not at what gets written.

**Concentration, not average, is the problem.** Ten sessions out of 131 are 57% of all
cache reads; three are 40%. The worst ran 1,389 turns at 469,345 tokens per turn.
Splitting long sessions is the largest available lever, and the ledger plus `/clear`
is already the mechanism for it.

**Rejected on measurement:** per-task model routing (worth $0.25 over eight weeks), a
model to perform verification (the checks are deterministic), and a model to classify
verification output (there are almost no verification clusters). The rule that replaces
them: exit code, then parse a known format, then a model — and only when the first two
are impossible.
