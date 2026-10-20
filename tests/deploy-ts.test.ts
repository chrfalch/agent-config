import assert from 'node:assert/strict';
import test from 'node:test';
import { freshHome, run } from './helpers.js';

const DEPLOY = [process.execPath, '--import', 'tsx', 'tools/deploy.ts'] as const;
const cases = [
  {
    "args": [
      "--help"
    ],
    "status": 0,
    "stdout": "Deploy agent-config.\n\n  bin/deploy                  link the owned files; apply policy; Codex if present\n  bin/deploy --dry-run        print every change and write nothing\n  bin/deploy --no-codex       skip Codex, and the three agents that drive it\n  bin/deploy --codex          require Codex; fail if ~/.codex/config.toml is missing\n  bin/deploy --no-argent      skip ui-runner and the UI automation rule\n  bin/deploy --no-stacks      skip the stacked-PR rule (needs the gh stack extension)\n  bin/deploy --no-githooks    skip the git hook guard; leave core.hooksPath alone\n  bin/deploy --no-mods        skip the Claude Code mods (/ledger)\n  bin/deploy --agents a,b,c   deploy only these agents\n  bin/deploy --models a,b     keep only these models in the routing rules\n  bin/deploy --force          replace a file of your own without asking\n  bin/deploy --revert         undo the last deploy\n\nRun --dry-run first against a config you care about.\n\nThe contract ships as rule files in ~/.claude/rules/, which Claude Code loads\nfor every project. Your own ~/.claude/CLAUDE.md is never touched.\n\nNOTE for Cowork users: a Cowork session on the desktop skips a symlinked\n~/.claude/rules/ file that points outside the session's working directory, so\nthese rules do not load there. Claude Code in the terminal is unaffected.\n\nDeploy also installs a chaining git hook dispatcher in ~/.config/git/hooks and\npoints core.hooksPath at it. Each hook strips AI attribution trailers from the\ncommit message, then hands over to the repository's own hook of the same name,\nso nothing a project keeps in .git/hooks stops working. If core.hooksPath is\nalready set to something else, deploy leaves it alone and says so. --revert\nremoves the files but does not unset core.hooksPath.\n\nDeploy does NOT own ~/.claude/settings.json or ~/.codex/config.toml. Those hold\nlocal state the apps write: project trust levels, plugins, marketplaces, MCP\nservers, your model choice. It merges a few policy keys and leaves the rest.\n",
    "stderr": ""
  },
  {
    "args": [
      "--dry-run"
    ],
    "status": 0,
    "stdout": "DRY RUN -- nothing below is written.\n\nlink     ~/.claude/rules/10-operating-model.md\nlink     ~/.claude/rules/20-writing.md\nlink     ~/.claude/rules/30-stacked-prs.md\nlink     ~/.claude/rules/40-model-routing.md\nlink     ~/.claude/rules/50-fleet-reference.md\nlink     ~/.claude/rules/60-subagent-mechanics.md\nlink     ~/.claude/rules/70-context.md\nlink     ~/.claude/rules/80-ui-automation.md\nlink     ~/.claude/rules/90-builds.md\nlink     ~/.claude/ledger.template.md\nlink     ~/.claude/hooks/denied-read-retry.sh\nlink     ~/.claude/hooks/deploy-drift.sh\nlink     ~/.claude/hooks/derived-data-gate.sh\nlink     ~/.claude/hooks/ledger-gate.sh\nlink     ~/.claude/hooks/ledger-list.sh\nlink     ~/.claude/hooks/worktree-gate.sh\nlink     ~/.claude/notes/model-routing-rationale.md\nlink     ~/.claude/agents/researcher.md\nlink     ~/.claude/agents/runner.md\nlink     ~/.claude/agents/ui-runner.md\nlink     ~/.claude/agents/opus-implementer.md\nlink     ~/.claude/agents/sol-implementer.md\nlink     ~/.claude/agents/astra-implementer.md\nlink     ~/.claude/agents/astra-reviewer.md\nlink     ~/.claude/agents/reviewer.md\nlink     ~/.config/git/hooks/_chain\nlink     ~/.config/git/hooks/commit-msg\nlink     ~/.config/git/hooks/prepare-commit-msg\nlink     ~/.config/git/hooks/pre-commit\nlink     ~/.config/git/hooks/pre-merge-commit\nlink     ~/.config/git/hooks/pre-push\nlink     ~/.config/git/hooks/pre-rebase\nlink     ~/.config/git/hooks/post-checkout\nlink     ~/.config/git/hooks/post-merge\nlink     ~/.config/git/hooks/post-commit\nlink     ~/.config/git/hooks/post-rewrite\nwould set      core.hooksPath -> ~/.config/git/hooks\nclaude   policy keys would apply: attribution, hooks, skipWorkflowUsageWarning, statusLine, tui\n         left alone: model\ncodex    skipped (no ~/.codex/config.toml; pass --codex to require it)\nmods     would add marketplace agent-config (this repo)\nmods     would install ledger@agent-config (/ledger)\n\nDRY RUN -- nothing was written.\n",
    "stderr": ""
  },
  {
    "args": [
      "--dry-run",
      "--no-argent",
      "--no-stacks",
      "--no-githooks"
    ],
    "status": 0,
    "stdout": "DRY RUN -- nothing below is written.\n\nrules    not written: 30-stacked-prs.md, 80-ui-automation.md\ngenerate ~/.claude/rules/10-operating-model.md\ngenerate ~/.claude/rules/20-writing.md\ngenerate ~/.claude/rules/40-model-routing.md\ngenerate ~/.claude/rules/50-fleet-reference.md\ngenerate ~/.claude/rules/60-subagent-mechanics.md\ngenerate ~/.claude/rules/70-context.md\ngenerate ~/.claude/rules/90-builds.md\nrules    generated, not linked: edits in the repo need another deploy\nlink     ~/.claude/ledger.template.md\nlink     ~/.claude/hooks/denied-read-retry.sh\nlink     ~/.claude/hooks/deploy-drift.sh\nlink     ~/.claude/hooks/derived-data-gate.sh\nlink     ~/.claude/hooks/ledger-gate.sh\nlink     ~/.claude/hooks/ledger-list.sh\nlink     ~/.claude/hooks/worktree-gate.sh\nlink     ~/.claude/notes/model-routing-rationale.md\nlink     ~/.claude/agents/researcher.md\nlink     ~/.claude/agents/runner.md\nlink     ~/.claude/agents/opus-implementer.md\nlink     ~/.claude/agents/sol-implementer.md\nlink     ~/.claude/agents/astra-implementer.md\nlink     ~/.claude/agents/astra-reviewer.md\nlink     ~/.claude/agents/reviewer.md\nagents   not deployed: ui-runner\nclaude   policy keys would apply: attribution, hooks, skipWorkflowUsageWarning, statusLine, tui\n         left alone: model\ncodex    skipped (no ~/.codex/config.toml; pass --codex to require it)\nmods     would add marketplace agent-config (this repo)\nmods     would install ledger@agent-config (/ledger)\n\nDRY RUN -- nothing was written.\n",
    "stderr": ""
  },
  {
    "args": [
      "--dry-run",
      "--agents",
      "researcher,runner"
    ],
    "status": 0,
    "stdout": "DRY RUN -- nothing below is written.\n\ngenerate ~/.claude/rules/10-operating-model.md\ngenerate ~/.claude/rules/20-writing.md\ngenerate ~/.claude/rules/30-stacked-prs.md\ngenerate ~/.claude/rules/40-model-routing.md\ngenerate ~/.claude/rules/50-fleet-reference.md\ngenerate ~/.claude/rules/60-subagent-mechanics.md\ngenerate ~/.claude/rules/70-context.md\ngenerate ~/.claude/rules/80-ui-automation.md\ngenerate ~/.claude/rules/90-builds.md\nrules    generated, not linked: edits in the repo need another deploy\nlink     ~/.claude/ledger.template.md\nlink     ~/.claude/hooks/denied-read-retry.sh\nlink     ~/.claude/hooks/deploy-drift.sh\nlink     ~/.claude/hooks/derived-data-gate.sh\nlink     ~/.claude/hooks/ledger-gate.sh\nlink     ~/.claude/hooks/ledger-list.sh\nlink     ~/.claude/hooks/worktree-gate.sh\nlink     ~/.claude/notes/model-routing-rationale.md\nlink     ~/.claude/agents/researcher.md\nlink     ~/.claude/agents/runner.md\nlink     ~/.config/git/hooks/_chain\nlink     ~/.config/git/hooks/commit-msg\nlink     ~/.config/git/hooks/prepare-commit-msg\nlink     ~/.config/git/hooks/pre-commit\nlink     ~/.config/git/hooks/pre-merge-commit\nlink     ~/.config/git/hooks/pre-push\nlink     ~/.config/git/hooks/pre-rebase\nlink     ~/.config/git/hooks/post-checkout\nlink     ~/.config/git/hooks/post-merge\nlink     ~/.config/git/hooks/post-commit\nlink     ~/.config/git/hooks/post-rewrite\nwould set      core.hooksPath -> ~/.config/git/hooks\nagents   not deployed: ui-runner opus-implementer sol-implementer astra-implementer astra-reviewer reviewer\nclaude   policy keys would apply: attribution, hooks, skipWorkflowUsageWarning, statusLine, tui\n         left alone: model\ncodex    skipped (no ~/.codex/config.toml; pass --codex to require it)\nmods     would add marketplace agent-config (this repo)\nmods     would install ledger@agent-config (/ledger)\n\nDRY RUN -- nothing was written.\n",
    "stderr": ""
  },
  {
    "args": [
      "--dry-run",
      "--models",
      "opus-5.5,sonnet-5.5"
    ],
    "status": 0,
    "stdout": "DRY RUN -- nothing below is written.\n\ngenerate ~/.claude/rules/10-operating-model.md\ngenerate ~/.claude/rules/20-writing.md\ngenerate ~/.claude/rules/30-stacked-prs.md\ngenerate ~/.claude/rules/40-model-routing.md\ngenerate ~/.claude/rules/50-fleet-reference.md\ngenerate ~/.claude/rules/60-subagent-mechanics.md\ngenerate ~/.claude/rules/70-context.md\ngenerate ~/.claude/rules/80-ui-automation.md\ngenerate ~/.claude/rules/90-builds.md\nrules    generated, not linked: edits in the repo need another deploy\nlink     ~/.claude/ledger.template.md\nlink     ~/.claude/hooks/denied-read-retry.sh\nlink     ~/.claude/hooks/deploy-drift.sh\nlink     ~/.claude/hooks/derived-data-gate.sh\nlink     ~/.claude/hooks/ledger-gate.sh\nlink     ~/.claude/hooks/ledger-list.sh\nlink     ~/.claude/hooks/worktree-gate.sh\nlink     ~/.claude/notes/model-routing-rationale.md\nlink     ~/.claude/agents/researcher.md\nlink     ~/.claude/agents/runner.md\nlink     ~/.claude/agents/ui-runner.md\nlink     ~/.claude/agents/opus-implementer.md\nlink     ~/.claude/agents/sol-implementer.md\nlink     ~/.claude/agents/astra-implementer.md\nlink     ~/.claude/agents/astra-reviewer.md\nlink     ~/.claude/agents/reviewer.md\nlink     ~/.config/git/hooks/_chain\nlink     ~/.config/git/hooks/commit-msg\nlink     ~/.config/git/hooks/prepare-commit-msg\nlink     ~/.config/git/hooks/pre-commit\nlink     ~/.config/git/hooks/pre-merge-commit\nlink     ~/.config/git/hooks/pre-push\nlink     ~/.config/git/hooks/pre-rebase\nlink     ~/.config/git/hooks/post-checkout\nlink     ~/.config/git/hooks/post-merge\nlink     ~/.config/git/hooks/post-commit\nlink     ~/.config/git/hooks/post-rewrite\nwould set      core.hooksPath -> ~/.config/git/hooks\nclaude   policy keys would apply: attribution, hooks, skipWorkflowUsageWarning, statusLine, tui\n         left alone: model\ncodex    skipped (no ~/.codex/config.toml; pass --codex to require it)\nmods     would add marketplace agent-config (this repo)\nmods     would install ledger@agent-config (/ledger)\n\nDRY RUN -- nothing was written.\n",
    "stderr": ""
  },
  {
    "args": [
      "--unknown"
    ],
    "status": 1,
    "stdout": "",
    "stderr": "unknown flag: --unknown   (try --help)\n"
  },
  {
    "args": [
      "--agents",
      "unknown"
    ],
    "status": 1,
    "stdout": "",
    "stderr": "unknown agent: unknown\nknown agents: researcher runner ui-runner opus-implementer sol-implementer astra-implementer astra-reviewer reviewer\n"
  },
  {
    "args": [
      "--revert",
      "--dry-run"
    ],
    "status": 0,
    "stdout": "DRY RUN -- nothing below is written.\n\nnothing from this repo is in place\nmods     revert leaves the mods installed (/ledger); they are Claude Code plugin state, not files\n         to remove them:\n           claude plugin uninstall ledger\n           claude plugin marketplace remove agent-config\nno backup to restore\n\nDRY RUN -- nothing was written.\n",
    "stderr": ""
  }
];

for (const expected of cases) {
  test(`deploy TypeScript: ${expected.args.join(' ')}`, (t) => {
    const home = freshHome(t);
    const result = run(home, DEPLOY, ...expected.args);
    assert.deepEqual({
      status: result.status,
      stdout: result.stdout.replaceAll(home, '<HOME>'),
      stderr: result.stderr.replaceAll(home, '<HOME>'),
    }, { status: expected.status, stdout: expected.stdout, stderr: expected.stderr });
  });
}
