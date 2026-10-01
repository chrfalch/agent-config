# Decisions

Why this setup is shaped the way it is. `rules/` holds the rules, `README.md`
holds the mechanics, this file holds the reasons. Add to it when you change
something and the reason is not obvious from the diff.

## 2026-09-17 — Source of truth

**A git repo, not Claude project knowledge.** Project files are static uploads.
They have no diff, no history and no rollback, and every change needs a manual
re-upload. A repo gives all four.

**Symlinks for what the repo owns.** The rule files, the agents, the ledger
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

## 2026-09-17 — the contract

*(This section predates the rules split. What it calls CLAUDE.md now lives as
the files under `rules/`.)*

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


## 2026-09-22 — Opus 5.5 across the Opus lanes

**All four Opus lanes move to `claude-opus-5-5`.** Model string verified against the
CLI before the change. Anthropic published Opus 5.5 the same day at $4/$20 with cache
reads at $0.20/M, against Opus 5's $5/$25 and $0.50/M.

**Cache read is why this matters, not the headline rate.** The eight-week measurement
put cache read at 61.5% of a $2,328 bill and generation at 13.6%. A 60% cut on the
dominant component is worth an estimated $900 over an equivalent window — roughly 15x
every applied token-reduction rule combined, and 3,600x the per-task routing question
that was closed on measurement.

*Basis of the $900.* The per-model read/write/output split is not in the data, so the
corpus-wide split (61.5 / 24.9 / 13.6) was applied to the Opus 5 lane total of
$2,026.71. Opus is 92.6% of turns, so the approximation is close — but this is an
estimate, not a measurement. Fable's mix runs the other way: its cache writes exceed
its cache reads. Treat the figure as an order of magnitude, not a forecast.

**Routing-table cost score raised 4→5.** Opus 5.5 now pays Sonnet 5's cache-read rate
exactly. It stays 2x Sonnet on input and output, but that covers 13.6% of spend. The
practical cost gap between the Opus and Sonnet lanes is now small.

**"Move main-thread turns to Sonnet" is withdrawn.** It was the one intervention that
traded quality for cost, estimated at ~$270. With cache-read parity its value largely
disappears. Do not re-raise it as a cost finding.

**Fast mode rejected.** $8/$40 for 2.5x output speed. This fleet is context-bound, not
latency-bound; doubling the rate to write faster buys nothing.

**Unverified, carried forward:** that Opus 5's API behaviour (thinking on by default,
400 on `thinking: disabled` at xhigh/max) is unchanged on 5.5, and that 5.5 holds Opus
5's prompt-injection robustness. Both are assumed by the `ui-runner` and untrusted-input
rules. Confirm before relying on either.

**Measurement warning.** The 14-day matched-window control in the token-reduction work
is priced at Opus 5 rates. Re-price both windows at 5.5 rates before the next
comparison, or the price cut will be credited to `ui-runner` and the context-discipline
rules.

## 2026-09-25 — The contract ships as rules

**The repo stopped owning `~/.claude/CLAUDE.md`.** It is a file people already
have and already edit. Replacing it, even with a backup, is hostile when the repo
is shared. The contract now deploys as topic files into `~/.claude/rules/`, which
Claude Code loads for every project on the machine. A `CLAUDE.md` left as a
symlink by an earlier version is retired on the next deploy, and reported.

**Gating is invisible to the model.** A whole file is gated by a `needs:` field
in YAML frontmatter; a block by an HTML comment. Claude Code reads only `paths`
from a rule's frontmatter and ignores other fields without an error, and it
strips block-level HTML comments before the content enters context. So the
markers cost nothing when nothing is filtered. `tools/build-rules.py` holds the
filter and the vocabulary.

**Symlink by default, generate only when narrowed.** With no selection flag the
rule files are symlinked, so an edit in the repo is live at once. `--models`,
`--agents`, `--no-codex`, `--no-argent` and `--no-stacks` make deploy write
filtered copies instead, and it says so. That trade is the price of selection,
not a default anyone pays.

**Gates name no lane.** Three gates pointed at an agent inside the rule itself,
so a narrowed deploy left an instruction aimed at nothing. Each gate now states
the rule, and a gated block names the lane after it. A test deploys one agent and
asserts no backticked lane name survives anywhere.

**Cowork: accepted, not fixed.** A Cowork session on the desktop skips a
symlinked `~/.claude/rules/` file whose target sits outside the session's working
directory, so the fleet rules do not load there. This was already true of the
`~/.claude/CLAUDE.md` symlink the earlier design created, so it is not a
regression. Copying instead of symlinking would fix it and would cost live
editing. Christian's call, 2026-09-25: live with it, and say so in the installer.

**Compaction: verified, 2026-09-25.** Rules were suspected of not surviving
`/compact`, since the docs promise re-injection only for a project-root
`CLAUDE.md`. Tested with a canary line in a rule file. After `/compact` the rule
files were still listed under Memory files and the canary still answered. They
reload. Do not re-raise. Still untested: automatic compaction, which with
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30` fires far later than a manual one.

## 2026-09-25 — Prices re-checked

**Anthropic rates are now in one dated table** at the top of
`notes/model-routing-rationale.md`, checked 2026-09-25. Opus 5.5 $4/$20 with
$0.20/M cache reads and $5/M cache writes; Opus 5 $5/$25 and $0.50/M; Sonnet 5
$2/$10, $0.20/M and $2.50/M; Fable 5.1 $10/$50 and $0.25/M; Haiku 4.5 $1/$5 and
$0.10/M. Nothing in the routing table had to change: every figure already in the
repo was current.

**The Sonnet 5 promotional trap did not happen.** Earlier work assumed Sonnet 5's
$2/$10 was introductory pricing that ended on 31 August 2026, and that the rise to
$3/$15 made it dearer on cache reads than it looked. Anthropic cancelled that
increase; $2/$10 is the standard rate and cache reads stay at $0.20/M. Any cost
comparison built on the increase is wrong. One price tracker still labels the
Sonnet 5 row as effective through 31 August, which is a stale row rather than a
second rate.

**The lesson survives its example.** Checking effective dates before routing on a
launch price is still right. This particular scare was unfounded, and the note now
says so, so nobody re-derives it from the old wording.

**Codex model prices are not verified.** `gpt-5.6-sol` and `gpt-6-astra` are
OpenAI models billed through the Codex plan. The figures in the rationale are
their release-note list prices and were not re-checked.

## 2026-09-25 — A filtered deploy could overwrite the repo

**Found while verifying the price update.** Deploying with a selection flag wrote
the filtered rules straight into `~/.claude/rules/`. Those paths were symlinks
into the repo from the previous unfiltered deploy, so the write followed the link
and overwrote the source file. Four rule files lost every gating marker. Caught by
`git status`, restored with `git checkout`, and nothing reached the remote.

**Three fixes, all of them narrow.** `build-rules.py` unlinks a destination before
writing it. `deploy.sh` builds filtered rules into a temp directory and copies them
in, so its own glob can no longer pick up files an earlier deploy left behind. A
file the last deploy generated is recognised from the manifest and replaced without
asking, but only under `~/.claude/rules/` — a real file at any other path is still
treated as the user's.

**Why it hid so long.** The original code deleted every rule up front, which
masked the symlink-following bug and made every deploy relink. Removing that
deletion to make the dry run honest is what exposed it.

**Two tests now cover it.** One asserts that a filtered deploy leaves the repo
sources byte-identical. The other walks full, filtered, full, repeat, revert and
checks the rule set at each step.

## 2026-09-30 — New models: Sonnet 5.5, GPT-6.1 Sol, GPT-6 Luna

**`runner` moves to `claude-sonnet-5-5`.** Released 28 Sep at Sonnet 5's rates
($2/$10, cache read $0.20/M). Model string taken from the Anthropic models page.

**`sol-implementer` moves to `gpt-6.1-sol`.** Released 29 Sep at $2/$10, cached
$0.10/M. GPT-6 Sol (22 Sep) was skipped: same list price, twice the cached rate.
Codex's model list no longer shows `gpt-5.6-sol`. Label prefix is now `gpt-6.1:`.

**`gpt-6-luna` enters the routing table without a lane.** $0.10/$0.50. One route:
trivial batch work on trusted text. It does not reopen the 2026-09-22 rejection of a
model that classifies verification output.

**Gate names changed.** `gpt-5.6-sol` → `gpt-6.1-sol`, `sonnet-5` → `sonnet-5.5`, new
`gpt-6-luna`. A teammate who passes `--models sonnet-5` or `--models gpt-5.6-sol` now
gets "unknown feature" and must use the new names.

**Kept, on purpose.** The ban on untrusted input for Sol stays: 6.1's injection
robustness is not published. Main-thread and judged lanes stay on Opus 5.5. Mythos
5.1 is not added: access is limited to vetted US organisations.

**Open: Astra implementer.** OpenAI claims 6.1 Sol matches Astra on DeepSWE v1.1 at a
fifth of the cost. Trial it on hard well-specified tasks before moving that lane.

**Prices verified this time**, for OpenAI too: launch posts and OpenRouter. Cached
rates for Sol and Luna come from OpenRouter only. Plan coverage in Codex is assumed
from the launch posts, not measured.

## 2026-09-30 — Docs split into README plus docs/

The README had grown into an install manual. Install detail was first, usage was
scattered, and the two things a new reader needs — what this is, and what a day
with it looks like — were not in it at all.

The README now carries the project, the reason it is shaped this way, the happy
path install, the daily loop, and a first explanation of the ledger and the
`/clear` then `go` cycle. Everything longer moved to `docs/`: `installation.md`
(flags, what deploy owns, hooks, revert, tests), `usage.md` (a worked task with
the ledger shown at each stage), `fleet.md` (agents, models, routing, Codex
mechanics), and `customizing.md` (models, gates, adding rules and agents).

`docs/` rather than flat files at the root, so the root stays readable. The rule
files remain the contract; `docs/` explains it to a person and is never loaded
into a session.

## 2026-10-01 — Deploy runs on Node, not bash and Python

**The problem.** Deploy needed two runtimes: bash for the deploy script and
Python for `tools/*.py`. Python had to be 3.11 or later, for `tomllib`. There
was no interactive mode, so a new user had to read the flag table first.

**TypeScript on Node 20.12 or later, run through `tsx`.** Not Node's native type
stripping and not Bun: `tsx` runs on Node 20, and native type stripping needs a
newer Node. The floor is 20.12 because `@clack/prompts` imports `styleText` from
`node:util`, which Node added in 20.12. `tsx` alone needs 20.6, for
`module.register`. One floor covers deploy and the wizard.
The wizard uses `@clack/prompts`, not Ink, because it is lighter.
`package-lock.json` is committed. Nothing is published to npm.

**`bin/deploy` is the entry point.** It is a plain JavaScript file. It checks
the Node version, runs `npm ci` when the install is missing, and loads
`tools/deploy.ts` through `tsx`. It replaced `deploy.sh`, a bash shim that did
the same. There are no existing users who need the old name, and the change
drops bash as a launcher. `bin/package.json` makes the file CommonJS. Node 18
before 18.19 and Node 20 before 20.10 refuse an extensionless ES module file
before they run it, so the version check could not print its error.

**The contract.** Flags, stdout and exit codes are byte-identical to the bash
version. A differential run against 17ad18f checked this. Stderr from a crash is
not part of the contract. Tool usage text now names the `.ts` files.

**Accepted differences.** A dry run no longer creates `~/.claude/rules`. Under a
`HOME` with a trailing slash, hook paths now use a single slash. Help text and
the wizard name `bin/deploy`.

**Cost.** The first run of `bin/deploy` runs `npm ci`, so it needs network
access.
