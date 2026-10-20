import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseDeployArguments } from '../tools/deploy.js';
import { claudeCalls, claudeLists, failClaude, freshHome, REPO, run, runWithoutClaude } from './helpers.js';

const DEPLOY = [path.join(REPO, 'bin/deploy')] as const;
const REPO_ARGUMENT = REPO.replace(/\/+$/, '');
const LIST_MARKETPLACES = 'plugin marketplace list --json';
const LIST_PLUGINS = 'plugin list --json';
const ADD = `plugin marketplace add ${REPO_ARGUMENT} --scope user`;
const INSTALL_LEDGER = 'plugin install ledger@agent-config --scope user';
const UNINSTALL_WORKTREES = 'plugin uninstall worktrees@agent-config --scope user';

const changesState = (call: string): boolean => / (add|install|uninstall) /.test(call);

test('the repo ships a marketplace that lists only the ledger mod', () => {
  const marketplace = JSON.parse(readFileSync(path.join(REPO, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'agent-config');
  assert.deepEqual(
    marketplace.plugins.map(({ name, source }: { name: string; source: string }) => ({ name, source })),
    [{ name: 'ledger', source: './mods/ledger' }],
  );
});

test('parseDeployArguments maps --no-mods to noMods', () => {
  assert.deepEqual(parseDeployArguments(['--no-mods']), { options: { noMods: true }, help: false });
});

test('deploy adds this repo as a marketplace, then installs the ledger mod and nothing else', (t) => {
  const home = freshHome(t);

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), [LIST_MARKETPLACES, ADD, LIST_PLUGINS, INSTALL_LEDGER]);
  assert.match(result.stdout, /^mods {5}installed ledger@agent-config \(\/ledger\)$/m);
  assert.doesNotMatch(result.stdout, /worktrees/);
});

test('a second deploy finds the marketplace and the mod and changes neither', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY);
  const before = claudeCalls(home).length;

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).slice(before), [LIST_MARKETPLACES, LIST_PLUGINS]);
});

test('--dry-run names the ledger mod and neither adds nor installs', (t) => {
  const home = freshHome(t);

  const result = run(home, DEPLOY, '--dry-run');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).filter(changesState), []);
  assert.match(result.stdout, /^(would )?mods\b.*\bledger\b/m);
});

test('--no-mods runs no claude command and says the step was skipped', (t) => {
  const home = freshHome(t);

  const result = run(home, DEPLOY, '--no-mods');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), []);
  assert.match(result.stdout, /^mods {5}skipped \(--no-mods\)$/m);
});

test('without claude on PATH deploy skips the mods step and succeeds', (t) => {
  const home = freshHome(t);

  const result = runWithoutClaude(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^mods {5}skipped/m);
});

for (const step of ['add', 'install'] as const) {
  test(`a failing ${step} fails deploy with a message on stderr`, (t) => {
    const home = freshHome(t);
    failClaude(home, step);

    const result = run(home, DEPLOY);

    assert.equal(result.status, 1, result.stdout);
    assert.notEqual(result.stderr.trim(), '');
  });
}

test('--revert runs no claude command and prints how to remove the mods', (t) => {
  const home = freshHome(t);
  run(home, DEPLOY);
  const before = claudeCalls(home).length;

  const result = run(home, DEPLOY, '--revert');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).slice(before), []);
  assert.ok(result.stdout.includes('claude plugin uninstall ledger'), result.stdout);
  assert.ok(!result.stdout.includes('worktrees'), result.stdout);
  assert.ok(result.stdout.includes('claude plugin marketplace remove agent-config'), result.stdout);
});

const registeredAt = (location: string): string =>
  JSON.stringify([{ name: 'agent-config', source: 'directory', path: location, installLocation: location }]);

const installed = (...plugins: { id: string; scope: string }[]): string => JSON.stringify(plugins);
const LEDGER_AT_USER = { id: 'ledger@agent-config', scope: 'user' };
const WORKTREES_AT_USER = { id: 'worktrees@agent-config', scope: 'user' };

test('deploy reports the ledger mod as already installed and uninstalls the old worktrees mod', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), plugins: installed(LEDGER_AT_USER, WORKTREES_AT_USER) });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), [LIST_MARKETPLACES, LIST_PLUGINS, UNINSTALL_WORKTREES]);
  assert.match(result.stdout, /^mods {5}ledger@agent-config already installed$/m);
  assert.match(result.stdout, /^mods {5}uninstalled worktrees@agent-config \(now \/ledger:worktrees\)$/m);
});

test('deploy installs the ledger mod before it uninstalls the old worktrees mod', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), plugins: installed(WORKTREES_AT_USER) });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), [LIST_MARKETPLACES, LIST_PLUGINS, INSTALL_LEDGER, UNINSTALL_WORKTREES]);
});

test('a second deploy finds the old worktrees mod gone and uninstalls nothing', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), plugins: installed(LEDGER_AT_USER, WORKTREES_AT_USER) });
  run(home, DEPLOY);
  const before = claudeCalls(home).length;

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).slice(before), [LIST_MARKETPLACES, LIST_PLUGINS]);
  assert.doesNotMatch(result.stdout, /worktrees/);
});

test('--dry-run names the old worktrees mod it would uninstall and uninstalls nothing', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), plugins: installed(LEDGER_AT_USER, WORKTREES_AT_USER) });

  const result = run(home, DEPLOY, '--dry-run');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home).filter(changesState), []);
  assert.match(result.stdout, /^mods {5}would uninstall worktrees@agent-config \(now \/ledger:worktrees\)$/m);
});

test('deploy leaves a worktrees mod installed at another scope alone', (t) => {
  const home = freshHome(t);
  claudeLists(home, {
    marketplaces: registeredAt(REPO_ARGUMENT),
    plugins: installed(LEDGER_AT_USER, { id: 'worktrees@agent-config', scope: 'local' }),
  });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claudeCalls(home), [LIST_MARKETPLACES, LIST_PLUGINS]);
});

test('a failing uninstall fails deploy with a message on stderr', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), plugins: installed(LEDGER_AT_USER, WORKTREES_AT_USER) });
  failClaude(home, 'uninstall');

  const result = run(home, DEPLOY);

  assert.equal(result.status, 1, result.stdout);
  assert.notEqual(result.stderr.trim(), '');
});

test('a marketplace already added from this repo is reported and not added again', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT) });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^mods {5}marketplace agent-config already added$/m);
  assert.deepEqual(claudeCalls(home).filter((call) => call.startsWith('plugin marketplace ') && call !== LIST_MARKETPLACES), []);
});

test('a marketplace named agent-config at another path is reported with the fix and left alone', (t) => {
  const home = freshHome(t);
  claudeLists(home, { marketplaces: registeredAt('/elsewhere/agent-config') });

  const result = run(home, DEPLOY);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes(
      'mods     marketplace agent-config points at /elsewhere/agent-config, not this repo; to fix: claude plugin marketplace remove agent-config, then run deploy again\n' +
        'mods     skipped install of ledger@agent-config until the marketplace points at this repo\n',
    ),
    result.stdout,
  );
  assert.deepEqual(claudeCalls(home).filter((call) => call.startsWith('plugin marketplace ') && call !== LIST_MARKETPLACES), []);
  assert.deepEqual(claudeCalls(home).filter((call) => call.startsWith('plugin ') && !call.startsWith('plugin marketplace ')), []);
});

for (const [list, command] of [['marketplaces', LIST_MARKETPLACES], ['plugins', LIST_PLUGINS]] as const) {
  test(`output from claude ${command} that is not JSON fails deploy with a message naming the command`, (t) => {
    const home = freshHome(t);
    claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), [list]: 'Loading plugins...' });

    const result = run(home, DEPLOY);

    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(`claude ${command}`), result.stderr);
    assert.ok(!result.stderr.includes('SyntaxError'), result.stderr);
  });
}

test('a marketplace added from the real path of a repo deploy reaches through a symlink counts as this repo', (t) => {
  const home = freshHome(t);
  const links = mkdtempSync(path.join(tmpdir(), 'agent-config-link-'));
  t.after(() => rmSync(links, { recursive: true, force: true }));
  const linked = path.join(links, 'agent-config');
  symlinkSync(realpathSync(REPO), linked);
  claudeLists(home, { marketplaces: registeredAt(realpathSync(REPO)) });

  const result = run(home, [path.join(linked, 'bin/deploy')]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^mods {5}marketplace agent-config already added$/m);
  assert.doesNotMatch(result.stdout, /points at/);
});

for (const [list, command] of [['marketplaces', LIST_MARKETPLACES], ['plugins', LIST_PLUGINS]] as const) {
  test(`JSON from claude ${command} that is not a list fails deploy with a message naming the command`, (t) => {
    const home = freshHome(t);
    claudeLists(home, { marketplaces: registeredAt(REPO_ARGUMENT), [list]: '{"error":"not signed in"}' });

    const result = run(home, DEPLOY);

    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(`claude ${command}`), result.stderr);
    assert.ok(!result.stderr.includes('TypeError'), result.stderr);
  });
}
