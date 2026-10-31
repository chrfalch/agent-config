import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { freshHome, REPO, run, snapshot } from './helpers.js';

const DEPLOY = [path.join(REPO, 'bin/deploy')] as const;

function markdownNames(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function rulesIn(home: string): string[] {
  return markdownNames(path.join(home, '.claude', 'rules'));
}

function agentsIn(home: string): string[] {
  return markdownNames(path.join(home, '.claude', 'agents')).map((name) =>
    path.parse(name).name,
  );
}

function ruleHashes(): Record<string, string> {
  return Object.fromEntries(
    markdownNames(path.join(REPO, 'rules')).map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(path.join(REPO, 'rules', name)))
        .digest('hex'),
    ]),
  );
}

test('--dry-run leaves the temporary home unchanged', (t) => {
  const home = freshHome(t);
  const before = snapshot(home);

  run(home, DEPLOY, '--dry-run');

  assert.deepEqual(snapshot(home), before, '--dry-run changed nothing on disk');
});

test('a filtered --dry-run leaves the temporary home unchanged', (t) => {
  for (const flags of [['--no-codex'], ['--no-argent'], ['--no-stacks'], ['--agents', 'runner'], ['--models', 'opus-5.5']]) {
    const home = freshHome(t);
    const before = snapshot(home);

    const result = run(home, DEPLOY, '--dry-run', ...flags);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(home), before, `--dry-run ${flags.join(' ')} changed nothing on disk`);
  }
});

test('a filtered --dry-run that fails removes its temporary rules directory', (t) => {
  const home = freshHome(t);
  const temp = mkdtempSync(path.join(tmpdir(), 'ledger-tmpdir-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const result = spawnSync(DEPLOY[0], ['--dry-run', '--models', 'unknown'], {
    cwd: REPO,
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), TMPDIR: temp },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, result.stdout);
  // tsx keeps its own tsx-<uid> directory in TMPDIR, so only deploy's entries are checked.
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith('ledger-')), []);
});

test('plain deploy links every rule without creating CLAUDE.md', (t) => {
  const home = freshHome(t);
  const allRules = markdownNames(path.join(REPO, 'rules'));

  const result = run(home, DEPLOY);
  const deployedRules = rulesIn(home);

  assert.deepEqual(
    { status: result.status, rules: deployedRules },
    { status: 0, rules: allRules },
    `deploy links every rule file: ${JSON.stringify(deployedRules)} ${result.stderr}`,
  );
  assert.ok(
    deployedRules.every((name) =>
      lstatSync(path.join(home, '.claude', 'rules', name)).isSymbolicLink(),
    ),
    'rules are symlinks when nothing is filtered',
  );
  assert.ok(
    !existsSync(path.join(home, '.claude', 'CLAUDE.md')),
    'the repo does not create a CLAUDE.md',
  );
});

test('filtered deploy generates only the requested rules and models', (t) => {
  const home = freshHome(t);

  run(home, DEPLOY);
  run(home, DEPLOY, '--no-argent', '--models', 'opus-5.5,sonnet-5.5');
  const deployedRules = rulesIn(home);

  assert.ok(
    !deployedRules.includes('80-ui-automation.md'),
    `--no-argent drops the UI automation rule: ${JSON.stringify(deployedRules)}`,
  );
  assert.ok(
    deployedRules.length > 0 &&
      !deployedRules.some((name) =>
        lstatSync(path.join(home, '.claude', 'rules', name)).isSymbolicLink(),
      ),
    'a filtered deploy writes real files, not links',
  );
  const routing = readFileSync(
    path.join(home, '.claude', 'rules', '40-model-routing.md'),
    'utf8',
  );
  assert.ok(
    !routing.includes('fable-5') &&
      !routing.includes('gpt-6-astra') &&
      routing.includes('opus-5.5'),
    '--models drops the rows not asked for',
  );
  assert.ok(!routing.includes('<!--'), 'no marker survives into a generated rule');
});

test('full deploy after a filtered deploy restores dropped rules', (t) => {
  const home = freshHome(t);
  const allRules = markdownNames(path.join(REPO, 'rules'));

  run(home, DEPLOY);
  run(home, DEPLOY, '--no-argent', '--models', 'opus-5.5,sonnet-5.5');
  run(home, DEPLOY);
  assert.deepEqual(
    rulesIn(home),
    allRules,
    'a later full deploy restores the dropped rule',
  );
});

test('--revert removes deployed rules, agents, and manifest', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY);
  run(home, DEPLOY, '--no-argent', '--models', 'opus-5.5,sonnet-5.5');
  run(home, DEPLOY);

  const result = run(home, DEPLOY, '--revert');

  assert.deepEqual(
    {
      status: result.status,
      rules: rulesIn(home),
      agents: agentsIn(home),
      manifestExists: existsSync(path.join(home, '.claude', '.ledger-manifest')),
    },
    { status: 0, rules: [], agents: [], manifestExists: false },
    `--revert removes the rules and the manifest: ${result.stderr}`,
  );
});

test("deploy preserves a teammate's own CLAUDE.md", (t) => {
  const home = freshHome(t, true);
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');

  run(home, DEPLOY);
  assert.ok(
    readFileSync(claudeMd, 'utf8') === 'MY OWN CONTRACT\n' &&
      !lstatSync(claudeMd).isSymbolicLink(),
    'a CLAUDE.md of your own survives a deploy untouched',
  );
});

test('deploy retires an old CLAUDE.md symlink into the repository', (t) => {
  const home = freshHome(t, true);
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');

  run(home, DEPLOY);
  unlinkSync(claudeMd);
  symlinkSync(path.join(REPO, 'CLAUDE.md'), claudeMd);
  const result = run(home, DEPLOY);
  assert.ok(
    !existsSync(claudeMd) && result.stdout.includes('retire'),
    `an old CLAUDE.md symlink into this repo is retired: ${result.stdout.slice(-200)}`,
  );
});

test('--agents deploys only the named agents', (t) => {
  const home = freshHome(t);

  const selected = run(home, DEPLOY, '--agents', 'runner,reviewer');
  assert.deepEqual(
    { status: selected.status, agents: agentsIn(home) },
    { status: 0, agents: ['reviewer', 'runner'] },
    `--agents deploys only the agents named: ${selected.stderr}`,
  );
});

test('--agents rejects an unknown agent name', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY, '--agents', 'runner,reviewer');

  const unknownAgent = run(home, DEPLOY, '--agents', 'no-such-agent');
  assert.ok(
    unknownAgent.status !== 0 && unknownAgent.stderr.includes('unknown agent'),
    '--agents rejects an unknown name',
  );
});

test('--models rejects an unknown model name', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY, '--agents', 'runner,reviewer');
  run(home, DEPLOY, '--agents', 'no-such-agent');

  const unknownModel = run(home, DEPLOY, '--models', 'no-such-model');
  assert.ok(
    unknownModel.status !== 0 && unknownModel.stderr.includes('unknown feature'),
    '--models rejects an unknown name',
  );
});

test('nonterminal deploy refuses to replace an owned file', (t) => {
  const home = freshHome(t);
  const owned = path.join(home, '.claude', 'ledger.template.md');
  run(home, DEPLOY, '--agents', 'runner,reviewer');
  unlinkSync(owned);
  writeFileSync(owned, 'MINE\n');

  const refused = run(home, DEPLOY);
  assert.ok(
    refused.status !== 0 &&
      refused.stderr.includes('--force') &&
      readFileSync(owned, 'utf8') === 'MINE\n',
    'refuses to replace a file of your own without a terminal',
  );
});

test('--force replaces an owned file and backs it up after refusal', (t) => {
  const home = freshHome(t);
  const owned = path.join(home, '.claude', 'ledger.template.md');
  run(home, DEPLOY, '--agents', 'runner,reviewer');
  unlinkSync(owned);
  writeFileSync(owned, 'MINE\n');
  run(home, DEPLOY);

  const forced = run(home, DEPLOY, '--force');
  const backups = path.join(home, '.claude', 'backups');
  const preserved = readdirSync(backups).some((deployment) => {
    if (!deployment.startsWith('deploy-')) return false;
    const backup = path.join(backups, deployment, '.claude', 'ledger.template.md');
    return existsSync(backup) && readFileSync(backup, 'utf8') === 'MINE\n';
  });
  assert.ok(
    forced.status === 0 && lstatSync(owned).isSymbolicLink() && preserved,
    '--force replaces it and backs it up',
  );
});

test('--no-codex omits Codex agents and prose', (t) => {
  const home = freshHome(t);

  run(home, DEPLOY, '--no-codex');
  const mechanics = readFileSync(
    path.join(home, '.claude', 'rules', '60-subagent-mechanics.md'),
    'utf8',
  );
  const deployedAgents = agentsIn(home);

  assert.deepEqual(
    {
      agents: deployedAgents,
      hasCodexRunner: deployedAgents.includes('codex-runner'),
      hasCodexExec: mechanics.includes('codex exec'),
      hasCodexCli: mechanics.includes('Codex CLI'),
    },
    {
      agents: ['opus-implementer', 'researcher', 'reviewer', 'runner', 'ui-runner'],
      hasCodexRunner: false,
      hasCodexExec: false,
      hasCodexCli: false,
    },
    `--no-codex drops its agents and its prose: ${JSON.stringify(deployedAgents)}`,
  );
});

test('plain deploy links every agent, the Codex agents included', (t) => {
  const home = freshHome(t);

  const result = run(home, DEPLOY);
  const deployedAgents = agentsIn(home);

  assert.deepEqual(
    { status: result.status, agents: deployedAgents },
    {
      status: 0,
      agents: [
        'astra-implementer',
        'astra-reviewer',
        'codex-runner',
        'opus-implementer',
        'researcher',
        'reviewer',
        'runner',
        'sol-implementer',
        'ui-runner',
      ],
    },
    `deploy links every agent: ${JSON.stringify(deployedAgents)} ${result.stderr}`,
  );
  assert.ok(
    lstatSync(path.join(home, '.claude', 'agents', 'codex-runner.md')).isSymbolicLink(),
    'codex-runner is linked, not generated',
  );
});

test('filtered deploy over linked rules does not modify repository sources', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY);
  const before = ruleHashes();

  run(home, DEPLOY, '--models', 'opus-5.5');
  const after = ruleHashes();
  const changed = Object.keys(before).filter((name) => before[name] !== after[name]);

  assert.deepEqual(
    after,
    before,
    `a filtered deploy does not write through the symlinks into the repo: ${JSON.stringify(changed)}`,
  );
});

test('narrow deployment leaves no rule references to undeployed agent lanes', (t) => {
  const home = freshHome(t);
  run(
    home,
    DEPLOY,
    '--agents',
    'opus-implementer',
    '--models',
    'opus-5.5',
    '--no-codex',
    '--no-argent',
    '--no-stacks',
  );
  const blob = rulesIn(home)
    .map((name) => readFileSync(path.join(home, '.claude', 'rules', name), 'utf8'))
    .join('');
  const allAgents = [
    'researcher',
    'runner',
    'ui-runner',
    'opus-implementer',
    'sol-implementer',
    'astra-implementer',
    'astra-reviewer',
    'codex-runner',
    'reviewer',
  ];
  const dangling = allAgents.filter(
    (agent) => agent !== 'opus-implementer' && blob.includes(`\`${agent}\``),
  );

  assert.deepEqual(
    dangling,
    [],
    `no rule names a lane that was not deployed: ${JSON.stringify(dangling)}`,
  );
});
