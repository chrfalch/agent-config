import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { REPO } from './helpers.js';

const LEDGER_LIST = path.join(REPO, 'hooks/ledger-list.sh');

function scratch(t: TestContext): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-config-ledger-list-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.gitconfig'), '');
  return root;
}

function environment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(root),
  };
}

function git(root: string, cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    env: environment(root),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

function repository(root: string, name: string): string {
  const checkout = path.join(root, name);
  mkdirSync(checkout);
  git(root, checkout, 'init', '--quiet');
  git(root, checkout, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
  return checkout;
}

function worktree(root: string, checkout: string, location: string): string {
  git(root, checkout, 'worktree', 'add', '--quiet', '-b', path.basename(location), location);
  return location;
}

function ledgerIn(folder: string): string {
  mkdirSync(path.join(folder, '.claude'), { recursive: true });
  const ledger = path.join(folder, '.claude/ledger.md');
  writeFileSync(ledger, `# Task ledger — ${path.basename(folder)}\n\n## Goal\nA goal.\n\n## Next step\nA step.\n`);
  return ledger;
}

function ledgerList(root: string, cwd: string, mode: string) {
  const result = spawnSync('bash', [LEDGER_LIST, mode], { cwd, env: environment(root), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function printedPaths(stdout: string): string[] {
  const lines = stdout.split('\n');
  assert.equal(lines.pop(), '', 'output ends with a newline');
  for (const line of lines) assert.ok(path.isAbsolute(line), `not an absolute path: ${JSON.stringify(line)}`);
  return lines.map((line) => realpathSync(line)).sort();
}

test('paths from a main checkout prints its ledger and the ledger of a worktree outside it', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  const expected = [ledgerIn(main), ledgerIn(sibling)].sort();

  assert.deepEqual(printedPaths(ledgerList(root, main, 'paths')), expected);
});

test('paths from a linked worktree prints only that worktree\'s ledger', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  ledgerIn(main);
  const own = ledgerIn(sibling);

  assert.deepEqual(printedPaths(ledgerList(root, sibling, 'paths')), [own]);
});

test('paths prints nothing when there is no ledger', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  worktree(root, main, path.join(root, 'sibling'));

  assert.equal(ledgerList(root, main, 'paths'), '');
});

test('paths outside a git repository finds ledgers under .claude/worktrees', (t) => {
  const root = scratch(t);
  const plain = path.join(root, 'plain');
  const ledger = ledgerIn(path.join(plain, '.claude/worktrees/x'));

  assert.deepEqual(printedPaths(ledgerList(root, plain, 'paths')), [ledger]);
});

test('paths prints the same ledgers that session-start summarises', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(main);
  ledgerIn(worktree(root, main, path.join(main, '.claude/worktrees/inside')));
  ledgerIn(worktree(root, main, path.join(root, 'sibling')));

  const summarised = ledgerList(root, main, 'session-start')
    .split('\n')
    .filter((line) => line.startsWith('=== '))
    .map((line) => line.slice('=== '.length));
  const listed = ledgerList(root, main, 'paths').split('\n').filter(Boolean);

  assert.equal(summarised.length, 3);
  assert.deepEqual(listed.sort(), summarised.sort());
});
