import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

function ledgerIn(
  folder: string,
  text = `# Task ledger — ${path.basename(folder)}\n\n## Goal\nA goal.\n\n## Next step\nA step.\n`,
): string {
  mkdirSync(path.join(folder, '.claude'), { recursive: true });
  const ledger = path.join(folder, '.claude/ledger.md');
  writeFileSync(ledger, text);
  return ledger;
}

function ledgerList(root: string, cwd: string, mode: string) {
  const result = spawnSync('bash', [LEDGER_LIST, mode], { cwd, env: environment(root), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

type SessionStartOutput = {
  hookSpecificOutput: { hookEventName: string; additionalContext: string; sessionTitle?: string };
};

function sessionStart(root: string, cwd: string): SessionStartOutput['hookSpecificOutput'] {
  const output = JSON.parse(ledgerList(root, cwd, 'session-start')) as SessionStartOutput;
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  return output.hookSpecificOutput;
}

function fullLedgerText(ledger: string): string {
  return `A task ledger exists at ${ledger}. Contents follow. If it has open steps, continue from Next step without re-verifying finished steps.\n\n${readFileSync(ledger, 'utf8')}`;
}

function printedPaths(stdout: string): string[] {
  const lines = stdout.split('\n');
  assert.equal(lines.pop(), '', 'output ends with a newline');
  for (const line of lines) assert.ok(path.isAbsolute(line), `not an absolute path: ${JSON.stringify(line)}`);
  return lines.map((line) => realpathSync(line)).sort();
}

test('paths from a main checkout prints the ledger of a worktree outside it, not its own', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  ledgerIn(main);
  const expected = [ledgerIn(sibling)];

  assert.deepEqual(printedPaths(ledgerList(root, main, 'paths')), expected);
});

test('a main checkout\'s own ledger is never read back or named on compaction', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  worktree(root, main, path.join(root, 'sibling'));
  ledgerIn(main);

  assert.equal(ledgerList(root, main, 'session-start'), '');
  assert.equal(ledgerList(root, main, 'pre-compact'), '');
});

test('session-start from a main checkout summarises worktree ledgers but not its own', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const own = ledgerIn(main);
  const inside = ledgerIn(worktree(root, main, path.join(main, '.claude/worktrees/inside')));
  const sibling = ledgerIn(worktree(root, main, path.join(root, 'sibling')));

  const output = ledgerList(root, main, 'session-start');

  assert.ok(!output.includes(own), `main checkout ledger printed:\n${output}`);
  assert.ok(output.includes(inside), `worktree ledger missing:\n${output}`);
  assert.ok(output.includes(sibling), `sibling ledger missing:\n${output}`);
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

test('paths outside a git repository finds the ledger in the working directory', (t) => {
  const root = scratch(t);
  const plain = path.join(root, 'plain');
  const ledger = ledgerIn(plain);

  assert.deepEqual(printedPaths(ledgerList(root, plain, 'paths')), [ledger]);
});

test('paths from a subdirectory of a main checkout ignores a ledger in that subdirectory', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sub = path.join(main, 'sub');
  ledgerIn(sub);
  const sibling = ledgerIn(worktree(root, main, path.join(root, 'sibling')));

  assert.deepEqual(printedPaths(ledgerList(root, sub, 'paths')), [sibling]);
});

test('paths prints the same ledgers that session-start summarises', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(main);
  ledgerIn(worktree(root, main, path.join(main, '.claude/worktrees/inside')));
  ledgerIn(worktree(root, main, path.join(root, 'sibling')));

  const summarised = sessionStart(root, main)
    .additionalContext.split('\n')
    .filter((line) => line.startsWith('=== '))
    .map((line) => line.slice('=== '.length));
  const listed = ledgerList(root, main, 'paths').split('\n').filter(Boolean);

  assert.equal(summarised.length, 2);
  assert.deepEqual(listed.sort(), summarised.sort());
});

test('session-start in a worktree with its own ledger titles the session with the slug', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  const ledger = ledgerIn(sibling, '# Task ledger — window-title  \n\n## Goal\nA goal.\n');

  const output = sessionStart(root, sibling);

  assert.equal(output.sessionTitle, 'window-title');
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});

test('session-start accepts a hyphen instead of an em dash in the ledger heading', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  ledgerIn(sibling, '# Task ledger - hyphenated\n');

  assert.equal(sessionStart(root, sibling).sessionTitle, 'hyphenated');
});

test('session-start omits the title when the ledger has no heading', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  const ledger = ledgerIn(sibling, '## Goal\nA goal.\n');

  const output = sessionStart(root, sibling);

  assert.equal('sessionTitle' in output, false);
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});

test('session-start omits the title when the heading has an empty slug', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  ledgerIn(sibling, '# Task ledger —   \n');

  assert.equal('sessionTitle' in sessionStart(root, sibling), false);
});

test('session-start in a main checkout summarises several worktree ledgers without a title', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(worktree(root, main, path.join(root, 'first')));
  ledgerIn(worktree(root, main, path.join(root, 'second')));
  const ledgers = ledgerList(root, main, 'paths').split('\n').filter(Boolean);

  const output = sessionStart(root, main);

  assert.equal('sessionTitle' in output, false);
  assert.equal(
    output.additionalContext,
    '2 task ledgers exist. Summary of each follows. If asked what we are working on, answer from this. Before continuing one, ask which, then read its full ledger.\n' +
      ledgers.map((ledger) => `\n=== ${ledger}\nA goal.\n\nA step.\n`).join(''),
  );
});

test('session-start in a main checkout with one worktree ledger shows it without a title', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const ledger = ledgerIn(worktree(root, main, path.join(root, 'sibling')));

  const output = sessionStart(root, main);

  assert.equal('sessionTitle' in output, false);
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});

test('session-start prints nothing when there is no ledger', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  worktree(root, main, path.join(root, 'sibling'));

  assert.equal(ledgerList(root, main, 'session-start'), '');
});

test('session-start keeps quotes, backslashes and non-ASCII text intact', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  const ledger = ledgerIn(sibling, '# Task ledger — "quoted" \\ slug æøå\n\n## Goal\nSay "hi" \\n then \\ and \ttab — ✓\n');

  const output = sessionStart(root, sibling);

  assert.equal(output.sessionTitle, '"quoted" \\ slug æøå');
  assert.equal(output.additionalContext, fullLedgerText(ledger));
});
