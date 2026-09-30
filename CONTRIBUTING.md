# Working on this repo as a team

## Taking it

Two ways, and they suit different people.

**Fork it** if you expect to diverge: a different model plan, no Codex, your own
agents. You get your own history and you pull fixes when you want them.

**Clone it** if you expect to stay close and send changes back. Keep your local
differences on a branch, and rebase that branch when `main` moves.

Either way, run `./deploy.sh --dry-run` before your first deploy.

## What to change locally, and what to send back

Change locally, and do not send back:

- The `model:` line in any agent, if your plan differs.
- Rules that name a tool you do not have. Prefer a deploy flag: `--no-codex`,
  `--no-argent`, `--no-stacks`, `--models`.
- Anything specific to your employer, your repos, or your own habits.
- Agents that are yours alone. Put those in `~/.claude/agents/`, where deploy
  leaves them alone, not in `agents/` here.

Send back:

- Bugs in `deploy.sh` or `tools/apply-policy.py`, with a test that fails before
  the fix.
- Rules that are true for everyone, not just for your project.
- A missing gate: a rule that names a tool or model but carries no `needs:`.
- Corrections to the README or to anything under `docs/`.

## Never commit

This repo holds no secrets and no personal state, and must stay that way. None
of the following belongs here, in any file:

- API keys, tokens, or anything read from an environment variable.
- The contents of `~/.claude.json`: trusted project directories, your MCP
  servers, your plugins and marketplaces, your account identifiers.
- Your `permissions.allow` list.
- Absolute paths that contain your username.
- Repository names or ticket numbers from work that is not public.

Deploy is built so none of this ever needs to be stored. It merges a few keys
into the live files and prints everything it left alone.

## Before you open a pull request

```sh
python3 tools/test-apply-policy.py
python3 tools/test-deploy.py
bash -n deploy.sh
```

Both tests write only to a temporary directory.

A change to what deploy writes needs a test that proves the change, and proves
that an existing config survives it. The merge is the dangerous part: a teammate
may have hooks, permissions and a model choice that this repo knows nothing
about, and none of it may be lost.

## Writing

Every rule file is read by an agent on every turn, so every line costs tokens on
every turn. Add a rule only if it changes behaviour. Delete a rule that has
stopped being true. Say what to do, not why, and put the why in `DECISIONS.md`
or `notes/`.

Anything that names a model or a tool needs a gate, so a teammate without it does
not read about it. Whole file:

```markdown
---
needs: argent
---
```

A block inside a file:

```markdown
<!-- needs: gpt-6-astra -->
- Astra wrappers never run below high.
<!-- /needs -->
```

`python3 tools/build-rules.py --vocabulary` lists the names a gate may use.

Figures measured from one person's sessions should say so.
