# Customizing

What to change, where to change it, and how to keep a change from breaking a
teammate who has a different set of tools.

## Change a model

Each agent pins its model in frontmatter:

```yaml
model: claude-opus-5-5
effort: high
```

Edit that line if your plan does not include the model, or if you want the lane
to run cheaper. Do not send that change back upstream; it is yours.

To drop models you do not have from the routing and fleet tables instead:

```sh
bin/deploy --models opus-5.5,sonnet-5.5
```

That writes filtered copies of the rule files rather than symlinks, so later
repo edits need another deploy.

## Add or remove an agent

Agents in `agents/` are deployed to `~/.claude/agents/`. Agents you create
directly in `~/.claude/agents/` are left alone by deploy. Keep private or
employer-specific agents there, not in this repo.

To deploy only some of this repo's agents:

```sh
bin/deploy --agents runner,reviewer,opus-implementer
```

## Write a rule

Rules live in `rules/`, one file per topic, numbered by load order. Every rule
file is read by an agent on every turn, so every line costs tokens on every
turn.

- Add a rule only if it changes behaviour.
- Delete a rule that has stopped being true.
- Say what to do, not why. The why goes in `DECISIONS.md` or `notes/`.
- Figures measured from one person's sessions must say so.

## Gate a rule

Anything that names a model or a tool needs a gate, so a teammate without it
never reads about it.

A whole file, with YAML frontmatter:

```markdown
---
needs: argent
---
```

A block inside a file, with HTML comments:

```markdown
<!-- needs: gpt-6-astra -->
- Astra wrappers never run below high.
<!-- /needs -->
```

Both are free at runtime. Claude Code reads only `paths` from a rule's
frontmatter and strips the rest, and it strips block-level HTML comments before
the content reaches the model.

To see which names a gate may use:

```sh
npx tsx tools/build-rules.ts --vocabulary
```

## Change what deploy writes

`tools/deploy.ts` and `tools/apply-policy.ts` are the dangerous part. A teammate may
have hooks, permissions and a model choice that this repo knows nothing about,
and none of it may be lost.

A change to what deploy writes needs a test that proves the change, and proves
that an existing config survives it.

```sh
npm test
npm run typecheck
node --check bin/deploy
```

Both tests write only to a temporary directory.

## Change the ledger template

`ledger.template.md` is copied to `.claude/ledger.md` when a task starts:
`/ledger:task` runs `bin/cc-task-new`, which creates the worktree and the
ledger before any plan. The approved plan is written into it later. Keep it
short: the ledger has a budget of about 4k tokens, and every section you add is
read at the start of every session for the life of the task.

## Change the hooks or the status line

They live in `settings.policy.json`, and deploy merges them into
`~/.claude/settings.json`. Deploy replaces the `PreCompact` and `SessionStart`
hook events whole. For every other hook event, it replaces the repo's own
entries and keeps yours as they are. An entry you edited counts as yours.

If you change or remove a hook entry in any other event, add its old form to
`RETIRED_HOOK_ENTRIES` in `tools/apply-policy.ts`. Otherwise upgraded settings
keep the old entry beside the new one. The list is read only for events the
policy still writes. If you remove a whole event from the policy, the old
entries stay in upgraded settings; remove them by hand.

The `SessionStart` hook is what makes the `/clear` then `go` loop work. If you
change it, test that a session started in a worktree still finds
`.claude/ledger.md`, and that a directory with several ledgers still produces a
summary rather than a full dump.

## Sending a change back

See [CONTRIBUTING.md](../CONTRIBUTING.md) for what belongs upstream, what stays
local, and what must never be committed.
