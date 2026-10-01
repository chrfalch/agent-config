# agent-config

A Claude Code multi-agent setup. It gives the top-level session a contract: plan
the work, delegate it to subagents, review the result, and keep the state in a
file instead of in the conversation.

It ships four things:

- **An orchestrator contract** — rule files that load in every session and tell
  the top-level agent how to work.
- **Eight subagents** — investigation, execution, implementation, and review
  lanes, each pinned to a model.
- **A task ledger** — a small file that holds the task state, so a session can
  be cleared and restarted without losing anything.
- **Two hooks** — they put the ledger back into context when a session starts,
  and protect it when a session compacts.

## Why it is shaped this way

One number drives the design. In eight weeks of one operator's sessions, 86% of
the spend was re-reading context, not generating output — 257 tokens read for
every one written. Everything you read stays in the session and is paid for
again on every later turn.

So the setup pushes verbose work out of the main session. A build log goes to
`runner`, which returns a verdict. A wide code search goes to `researcher`,
which returns a short report. Implementation goes to an implementer, which
returns a diff and a report. The main session stays small, and it stays the
place where planning, routing, and review happen.

## Install

```sh
git clone https://github.com/chrfalch/agent-config.git
cd agent-config
./deploy.sh --dry-run   # print every change, write nothing
./deploy.sh
```

You need Claude Code, `python3` 3.11 or later, and `bash`. Codex CLI, the
argent MCP server, and the `gh stack` extension are optional; deploy has a flag
to skip each one.

Then add three variables to your shell profile:

```sh
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30
export BASH_MAX_OUTPUT_LENGTH=10000
export MAX_MCP_OUTPUT_TOKENS=10000
```

That is the happy path. [docs/installation.md](docs/installation.md) has the
flags, what deploy owns, what it never touches, and how to undo it.

## First five minutes

Check that the install worked before you start real work. Open a new terminal
so the shell variables load, then start Claude Code in any repo.

1. Type `/agents`. The list should include `researcher`, `runner`, `reviewer`,
   and `opus-implementer`. The Codex and argent agents appear only if you did
   not skip them at deploy.
2. Ask `What are we working on?`. It should say that no task is open, because
   this repo has no ledger yet.
3. Pick a small real task that touches more than one file, and type
   `Start a new task: …` with a sentence describing it. You should get a plan
   and a question asking you to approve it. Answer `yes` and follow along.

If step 1 shows none of these agents, run `./deploy.sh --dry-run` again and
read what it would change.

## Using it

Open Claude Code in your repo and describe the task. The orchestrator explores,
writes a plan, and asks you to approve it. On approval it creates a worktree and
a ledger, then runs the pipeline:

```
investigate -> plan -> ledger -> red tests -> implement -> verify -> review -> clear point -> accept
```

Two things you take part in: you approve the plan, and you run `/clear` when the
orchestrator says so.

### The ledger

Every non-trivial task gets a file at `.claude/ledger.md` in its worktree. It
holds the goal, the approved plan with a status per step, decisions and their
reasons, and one line naming the exact next action. The orchestrator writes to
it at every step boundary.

The ledger exists because the conversation is expensive and the file is cheap.
A session transcript is re-read on every turn. The ledger is read once, when a
session starts.

```markdown
## Next step
Delegate step 3 to opus-implementer at high effort: make the failing
tests in src/sync/__tests__/queue.test.ts pass.
```

### `/clear` and `go`

When one implement-and-review cycle finishes and more work remains, the
orchestrator stops and says:

> Clear point. Ledger updated. Run `/clear`, then say: go.

You type `/clear`, then `go`. A hook reads the ledger into the fresh session, so
the new session knows the goal, what is done, and what is next. It continues
from there. You type nothing else.

This is the core loop. A cold start from the ledger costs a few thousand tokens
once. Carrying the finished cycle into the next one costs that on every turn for
the rest of the task.

### Things you can say

There are no commands to learn. You write plain sentences, and the wording does
not have to match these examples.

| You type | What happens |
|---|---|
| `Start a new task: items in the offline queue disappear if the app is killed during a sync.` | The orchestrator investigates, writes a plan, and asks you to approve it. Only a small single-file change is made without a plan. |
| `yes` | Approves the plan. The orchestrator creates the worktree and the ledger and starts on step 1. |
| `Change step 2: keep the old API and add the new one next to it.` | The orchestrator rewrites the plan and asks again. |
| `What are we working on?` | It answers from the ledger: the goal, what is done, and the next step. If several tasks are open, it lists each one. |
| `go` | It continues from the next step in the ledger. Use this after `/clear`, or in a new session the next day. |
| `Continue the offline queue task.` | The same as `go`, when several tasks are open and you want to name one. |
| `Why did we drop the retry counter?` | It answers from the decisions recorded in the ledger, with the reason for each. |
| `Explain that in more detail.` | Answers start as a short summary. This asks for file paths, function names, and what was ruled out. |
| `Commit and open a PR.` | The orchestrator does not commit on its own. When the last review passes it asks you, and this is the answer. |

[docs/usage.md](docs/usage.md) walks through a full task, with the ledger at
each stage.

## Documentation

| Document | What it covers |
|---|---|
| [docs/usage.md](docs/usage.md) | The daily loop, a worked example, the ledger, clear points |
| [docs/installation.md](docs/installation.md) | Prerequisites, every flag, what deploy owns, revert |
| [docs/fleet.md](docs/fleet.md) | The eight agents, their models, and the routing rules |
| [docs/customizing.md](docs/customizing.md) | Changing models, gating rules, adding an agent, tests |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Forking, what to send back, what must never be committed |
| [DECISIONS.md](DECISIONS.md) | Why the setup is shaped this way |

## Layout

```
rules/                    the orchestrator contract, one file per topic
agents/                   the eight subagents
docs/                     this documentation
ledger.template.md        copied per task to .claude/ledger.md
notes/                    rationale, not rules
DECISIONS.md              why the setup is shaped this way
settings.policy.json      Claude Code keys this repo asserts
codex/policy.toml         Codex keys this repo asserts
tools/                    the settings merge and rule filter, plus their tests
deploy.sh
```

## Notes

Agents you add under `~/.claude/agents/` that are not in this repo are left
alone by deploy. Keep private or employer-specific agents there, not here.

No secrets belong in this repo. Nothing here reads a key or a token.
