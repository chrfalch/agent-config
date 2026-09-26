# Review brief: preparing this repo for team sharing

Dated 2026-09-25. Kept because the review it describes has not been run yet, and
because the acceptance criteria below are the ones any later change to deploy
should still meet.

## How to run it

The fleet only runs from a real Claude Code session. Headless mode stalls: a
prompt needing no tools returns fine, but the moment the reviewer reaches for
Read, Grep or Bash it has no way to ask for permission and it hangs. Run it
interactively, and approve the trust prompt when it appears.

```sh
cd ~/repos/chrfalch/agent-config
claude --model claude-opus-5-5
```

Then ask for the review, pointing at this file, and run `astra-reviewer`
afterwards without showing it the first verdict.


## Goal
`~/repos/chrfalch/agent-config` is being prepared to share with a team. Deployment
must not damage an existing Claude Code config, and the setup must be usable by
people with different tools, models and plans.

## Scope
Commits `18e58af..e33969e` on `main`. Review the current state of the working
tree, not each commit in isolation. Everything is already pushed.

## What changed
1. `tools/apply-policy.py` merges policy keys one level deep instead of replacing
   a whole top-level key, so a foreign hook event survives.
2. `deploy.sh` gained `--dry-run`, `--force` with a confirm-before-replace guard,
   `--revert` driven by a manifest, `--agents`, `--models`, `--no-argent`,
   `--no-stacks`, `--help`.
3. The contract moved out of `CLAUDE.md` into `rules/*.md`, deployed into
   `~/.claude/rules/`. The repo no longer owns `~/.claude/CLAUDE.md`.
4. Gating: `needs:` in YAML frontmatter for a whole file, HTML comment blocks for
   a block. `tools/build-rules.py` filters.
5. The operating-model gates no longer name a subagent inside the rule itself.
6. `README.md`, `CONTRIBUTING.md`, `DECISIONS.md` updated.
7. Tests: `tools/test-apply-policy.py` (5 checks), `tools/test-deploy.py` (20).

## Acceptance criteria
A. A deploy never destroys data the user did not agree to lose.
B. What `--dry-run` reports equals what the real run does.
C. A deploy never modifies the repo's own source files.
D. Any selection of flags yields a coherent contract with no dangling reference
   to a tool, model or agent that was not deployed.
E. `--revert` restores the previous state.
F. No secrets and no machine-specific data in the repo.
G. The tests fail if any of A to E regress.

## Specific things to probe
- A filtered deploy previously wrote through symlinks and overwrote the repo's
  own rule files. Fixed in `e33969e`. Is the fix complete? Is there any other
  place that writes to a path that could be a symlink?
- Files under `~/.claude/rules/` listed in the manifest are replaced without
  asking. Is that exemption too broad, or reachable in a way that loses user data?
- `set -euo pipefail` with arrays, `in_list`, and `${ARR[@]+"${ARR[@]}"}`: any
  path where a failure is swallowed or the script exits unexpectedly?
- The manifest is newline-separated plain paths. What happens with a path
  containing a space or a newline?
- Backup path construction: `cp -p "$dst" "$BACKUP/${dst#"$HOME"/}"`. What if
  `$dst` is not under `$HOME`?
- `build-rules.py render()`: unclosed markers, nested markers, and the blank-line
  collapsing regex. Can it damage a fenced code block or a table?
- `used_features()` exists in `build-rules.py`. Is it called anywhere? If not, a
  `needs:` naming a model that was later removed would never be caught.
- Does anything still assume `~/.claude/CLAUDE.md` exists?

## Deliverable
Findings only. Do not fix anything. Give each finding a severity and a file and
line. State explicitly, per criterion A to G, whether it is met, not met, or not
determinable from the code. If you disagree with a claim in `DECISIONS.md`, say so.
