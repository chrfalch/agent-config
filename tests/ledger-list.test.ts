import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { REPO } from './helpers.js';

const LEDGER_LIST = path.join(REPO, 'hooks/ledger-list.sh');

function scratch(t: TestContext): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-ledger-list-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.gitconfig'), '');
  return root;
}

function environment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
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

function familyLedger(slug: string, location: string[], rest = '## Next step\nA step.\n'): string {
  return [`# Task ledger — ${slug}`, '', '## Goal', 'A goal.', '', '## Location', ...location, '', rest].join('\n');
}

function relationText(ledger: string, ...lines: string[]): string {
  const [first, ...contents] = fullLedgerText(ledger).split('\n');
  return [first, ...lines, ...contents].join('\n');
}

test('session-start in a child task names its parent and the parent status', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const child = worktree(root, main, path.join(root, 'child'));
  const ledger = ledgerIn(child, familyLedger('child', ['- parent: epic']));
  ledgerIn(worktree(root, main, path.join(root, 'epic')), familyLedger('epic', [], '## Children\n- child\n\n## Next step\nParked: 2026-10-01 — waiting.\nA step.\n'));

  assert.equal(sessionStart(root, child).additionalContext, relationText(ledger, 'Parent task: epic (parked).'));
});

test('session-start in a child task whose parent has no ledger names the parent as missing', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const child = worktree(root, main, path.join(root, 'child'));
  const ledger = ledgerIn(child, familyLedger('child', ['- parent: epic']).replace(/\n/g, '\r\n'));

  assert.equal(sessionStart(root, child).additionalContext, relationText(ledger, 'Parent task: epic (missing).'));
});

test('session-start in a parent task names each child and its status', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const epic = worktree(root, main, path.join(root, 'epic'));
  const children = '## Children\n- child-a\n- child-b\n- old (retired 2026-10-01)\n- lost\n\n## Next step\nA step.\n';
  const ledger = ledgerIn(epic, familyLedger('epic', [], children));
  ledgerIn(worktree(root, main, path.join(root, 'child-a')), familyLedger('child-a', ['- parent: epic']));
  ledgerIn(worktree(root, main, path.join(root, 'child-b')), familyLedger('child-b', ['- parent: epic'], '## Next step\n\nParked: 2026-10-02 - later.\n'));

  assert.equal(
    sessionStart(root, epic).additionalContext,
    relationText(
      ledger,
      'Child task: child-a (active).',
      'Child task: child-b (parked).',
      'Child task: old (retired 2026-10-01).',
      'Child task: lost (missing).',
    ),
  );
});

test('session-start in a parent task names a child marked started with its status', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const epic = worktree(root, main, path.join(root, 'epic'));
  const ledger = ledgerIn(epic, familyLedger('epic', [], '## Children\n- child-a (started 2026-10-20)\n- lost (started 2026-10-21)\n\n## Next step\nA step.\n'));
  ledgerIn(worktree(root, main, path.join(root, 'child-a')), familyLedger('child-a', ['- parent: epic']));

  assert.equal(
    sessionStart(root, epic).additionalContext,
    relationText(ledger, 'Child task: child-a (active).', 'Child task: lost (missing).'),
  );
});

test('session-start in a main checkout names the parent or children under each ledger summary', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const epic = ledgerIn(worktree(root, main, path.join(root, 'epic')), familyLedger('epic', [], '## Children\n- child-a\n- child-b\n\n## Next step\nA step.\n'));
  const childA = ledgerIn(worktree(root, main, path.join(root, 'child-a')), familyLedger('child-a', ['- parent: epic']));
  const childB = ledgerIn(
    worktree(root, main, path.join(root, 'child-b')),
    familyLedger('child-b', ['- parent: epic'], '## Next step\nParked: 2026-10-02 — later.\n'),
  );
  const ledgers = ledgerList(root, main, 'paths').split('\n').filter(Boolean);
  const relations: Record<string, string[]> = {
    [epic]: ['Child task: child-a (active).', 'Child task: child-b (parked).'],
    [childA]: ['Parent task: epic (active).'],
    [childB]: ['Parent task: epic (active).'],
  };

  const context = sessionStart(root, main).additionalContext;

  assert.equal(ledgers.length, 3);
  assert.deepEqual(
    context.split('\n=== ').slice(1),
    ledgers.map((ledger) => {
      const next = realpathSync(ledger) === childB ? 'Parked: 2026-10-02 — later.' : 'A step.';
      return [ledger, ...(relations[realpathSync(ledger)] ?? []), 'A goal.', '', next, ''].join('\n');
    }),
  );
});

function backlogLedger(root: string, folder: string, slug: string, owner: string, location: string[] = []): string {
  const ledger = path.join(root, '.claude/ledger-backlog', folder, `${slug}.md`);
  mkdirSync(path.dirname(ledger), { recursive: true });
  writeFileSync(ledger, familyLedger(slug, [`- main: ${owner}`, '- worktree: <path>', ...location]));
  return ledger;
}

test('session-start in a child task names a parent in another repository with that repository and its status there, not that of a local ledger of its slug', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const child = worktree(root, main, path.join(root, 'child'));
  const other = repository(root, 'app');
  const ledger = ledgerIn(child, familyLedger('child', [`- parent: epic @ ${other}`]));
  ledgerIn(worktree(root, main, path.join(root, 'epic')), familyLedger('epic', [], '## Children\n- child\n\n## Next step\nA step.\n'));
  ledgerIn(worktree(root, other, path.join(root, 'app-epic')), familyLedger('epic', [], '## Next step\nParked: 2026-10-02 — later.\n'));

  assert.equal(sessionStart(root, child).additionalContext, relationText(ledger, `Parent task: epic @ ${other} (parked).`));
});

test('session-start in a child task names a parent in a repository that is gone as missing', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const child = worktree(root, main, path.join(root, 'child'));
  const other = path.join(root, 'elsewhere/app');
  const ledger = ledgerIn(child, familyLedger('child', [`- parent: epic @ ${other}`]));

  assert.equal(sessionStart(root, child).additionalContext, relationText(ledger, `Parent task: epic @ ${other} (missing).`));
});

test('session-start names a task in another repository with an unknown status when cc-ledger-parent does not answer in time', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const child = worktree(root, main, path.join(root, 'child'));
  const other = repository(root, 'app');
  const ledger = ledgerIn(child, familyLedger('child', [`- parent: epic @ ${other}`], `## Children\n- part @ ${other}\n\n## Next step\nA step.\n`));
  const hooks = path.join(root, 'tools/hooks');
  mkdirSync(hooks, { recursive: true });
  mkdirSync(path.join(root, 'tools/bin'));
  writeFileSync(path.join(hooks, 'ledger-list.sh'), readFileSync(LEDGER_LIST));
  writeFileSync(path.join(root, 'tools/bin/cc-ledger-parent'), '#!/bin/bash\nexec sleep 60\n', { mode: 0o755 });

  const started = Date.now();
  const result = spawnSync('bash', [path.join(hooks, 'ledger-list.sh'), 'session-start'], { cwd: child, env: environment(root), encoding: 'utf8' });

  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    (JSON.parse(result.stdout) as SessionStartOutput).hookSpecificOutput.additionalContext,
    relationText(ledger, `Parent task: epic @ ${other} (unknown).`, `Child task: part @ ${other} (unknown).`),
  );
});

test('session-start in a parent task names each child in another repository with that repository and its status there', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const epic = worktree(root, main, path.join(root, 'epic'));
  const lib = repository(root, 'lib');
  const children = `## Children\n- child-a\n- child-a @ ${lib}\n- begun @ ${lib} (started 2026-10-20)\n- old @ ${lib} (retired 2026-10-01)\n- gone @ ${lib}\n\n## Next step\nA step.\n`;
  const ledger = ledgerIn(epic, familyLedger('epic', [], children).replace(/\n/g, '\r\n'));
  ledgerIn(worktree(root, main, path.join(root, 'child-a')), familyLedger('child-a', ['- parent: epic']));
  backlogLedger(root, 'main', 'begun', main);
  backlogLedger(root, 'lib', 'child-a', lib);
  ledgerIn(worktree(root, lib, path.join(root, 'lib-begun')), familyLedger('begun', [`- parent: epic @ ${main}`]));

  assert.equal(
    sessionStart(root, epic).additionalContext,
    relationText(
      ledger,
      'Child task: child-a (active).',
      `Child task: child-a @ ${lib} (backlog).`,
      `Child task: begun @ ${lib} (active).`,
      `Child task: old @ ${lib} (retired 2026-10-01).`,
      `Child task: gone @ ${lib} (missing).`,
    ),
  );
});

test('session-start in a child task names a parent in this repository\'s backlog as backlog', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const child = worktree(root, main, path.join(root, 'child'));
  const ledger = ledgerIn(child, familyLedger('child', ['- parent: epic']));
  backlogLedger(root, 'main', 'epic', main);

  assert.equal(sessionStart(root, child).additionalContext, relationText(ledger, 'Parent task: epic (backlog).'));
});

test('session-start in a parent task names a backlog child as backlog, but not one of another repository with the same folder name', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const epic = worktree(root, main, path.join(root, 'epic'));
  const ledger = ledgerIn(epic, familyLedger('epic', [], '## Children\n- idea\n- foreign\n\n## Next step\nA step.\n'));
  backlogLedger(root, 'main', 'idea', main, ['- parent: epic']);
  backlogLedger(root, 'main', 'foreign', path.join(root, 'elsewhere/main'), ['- parent: epic']);

  assert.equal(
    sessionStart(root, epic).additionalContext,
    relationText(ledger, 'Child task: idea (backlog).', 'Child task: foreign (missing).'),
  );
});

test('backlog prints this repository\'s backlog ledgers from the main checkout and from a linked worktree, and not another repository\'s', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const child = worktree(root, main, path.join(root, 'child'));
  ledgerIn(child, familyLedger('child', ['- parent: epic']));
  const epic = backlogLedger(root, 'main', 'epic', main);
  const idea = backlogLedger(root, 'main', 'idea', main);
  backlogLedger(root, 'main', 'foreign', path.join(root, 'elsewhere/main'));

  for (const cwd of [main, child]) assert.deepEqual(printedPaths(ledgerList(root, cwd, 'backlog')), [epic, idea]);
});

test('backlog prints nothing when the repository has no backlog, and outside a git repository', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const outside = path.join(root, 'outside');
  mkdirSync(outside);

  assert.equal(ledgerList(root, main, 'backlog'), '');
  assert.equal(ledgerList(root, outside, 'backlog'), '');
});

test('session-start reads only the Location parent bullet and the section headed exactly Children', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  const ledger = ledgerIn(sibling, familyLedger('sibling', ['- parent: <slug>'], '## Children (old)\n- child-a\n\n## Notes\n- parent: epic\n'));

  assert.equal(sessionStart(root, sibling).additionalContext, fullLedgerText(ledger));
});

test('session-start prints nothing when there is no ledger', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  worktree(root, main, path.join(root, 'sibling'));

  assert.equal(ledgerList(root, main, 'session-start'), '');
});

test('session-start leaves out backlog tasks, both their ledger files and their registry entries', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const backlog = path.join(root, '.claude/ledger-backlog/main/idea.md');
  mkdirSync(path.dirname(backlog), { recursive: true });
  writeFileSync(backlog, `# Task ledger — idea\n\n## Goal\nA backlog goal.\n\n## Location\n- main: ${main}\n`);
  const entry = { repo: 'main', slug: 'idea', path: backlog, branch: '', status: 'backlog', main, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-01T00:00:00.000Z' };
  writeFileSync(path.join(root, '.claude/ledgers.json'), JSON.stringify([entry]));

  assert.equal(ledgerList(root, main, 'session-start'), '');

  const sibling = ledgerIn(worktree(root, main, path.join(root, 'sibling')));
  const output = ledgerList(root, main, 'session-start');
  assert.ok(output.includes(sibling), `worktree ledger missing:\n${output}`);
  assert.ok(!output.includes(backlog) && !output.includes('A backlog goal.'), `backlog task shown:\n${output}`);
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

const registeredPaths = (root: string): string[] =>
  (JSON.parse(readFileSync(path.join(root, '.claude/ledgers.json'), 'utf8')) as { path: string }[]).map((entry) => entry.path).sort();

test('session-start registers its one ledger in ~/.claude/ledgers.json', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const ledger = ledgerIn(worktree(root, main, path.join(root, 'sibling')));

  sessionStart(root, main);

  assert.deepEqual(registeredPaths(root), [ledger]);
});

test('session-start registers each of several ledgers', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const first = ledgerIn(worktree(root, main, path.join(root, 'first')));
  const second = ledgerIn(worktree(root, main, path.join(root, 'second')));

  const shims = path.join(root, 'shims');
  const calls = path.join(root, 'node-calls');
  mkdirSync(shims);
  writeFileSync(path.join(shims, 'node'), `#!/bin/bash\necho >> '${calls}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });

  const result = spawnSync('bash', [LEDGER_LIST, 'session-start'], {
    cwd: main,
    env: { ...environment(root), PATH: `${shims}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(registeredPaths(root), [first, second].sort());
  assert.equal(readFileSync(calls, 'utf8'), '\n', 'node ran more than once');
});

test('session-start prints the same JSON and exits 0 when the registry cannot be written', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const sibling = worktree(root, main, path.join(root, 'sibling'));
  const ledger = ledgerIn(sibling);
  const expected = ledgerList(root, sibling, 'session-start');
  rmSync(path.join(root, '.claude'), { recursive: true, force: true });
  writeFileSync(path.join(root, '.claude'), 'a file, so ~/.claude/ledgers.json cannot exist');

  assert.equal(ledgerList(root, sibling, 'session-start'), expected);
  assert.equal(sessionStart(root, sibling).additionalContext, fullLedgerText(ledger));
});

test('paths and pre-compact leave the registry alone', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(worktree(root, main, path.join(root, 'sibling')));

  ledgerList(root, main, 'paths');
  ledgerList(root, main, 'pre-compact');

  assert.equal(existsSync(path.join(root, '.claude/ledgers.json')), false);
});

type PromptSubmitInput = { prompt: string; cwd?: string; session_title?: string };

function promptSubmitRaw(root: string, input: string) {
  return spawnSync('bash', [LEDGER_LIST, 'prompt-submit'], {
    cwd: root,
    env: { ...environment(root), HOME: root },
    input,
    encoding: 'utf8',
  });
}

function promptSubmit(root: string, input: PromptSubmitInput): string {
  const result = promptSubmitRaw(root, JSON.stringify(input));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function promptSubmitTitle(root: string, input: PromptSubmitInput): string {
  const output = JSON.parse(promptSubmit(root, input)) as {
    hookSpecificOutput: { hookEventName: string; sessionTitle: string };
  };
  assert.deepEqual(Object.keys(output.hookSpecificOutput).sort(), ['hookEventName', 'sessionTitle']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  return output.hookSpecificOutput.sessionTitle;
}

function archive(home: string, repo: string, slug: string): void {
  const folder = path.join(home, '.claude/ledger-archive', repo);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `2026-10-01-${slug}.md`), `# Task ledger — ${slug}\n`);
}

test('prompt-submit titles an untitled session in the main checkout with the slug from go', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(worktree(root, main, path.join(root, 'alpha')));

  assert.equal(promptSubmitTitle(root, { prompt: 'go alpha', cwd: main }), 'alpha');
});

test('prompt-submit replaces the title of another worktree\'s task', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const alpha = worktree(root, main, path.join(root, 'alpha'));
  ledgerIn(alpha);
  ledgerIn(worktree(root, main, path.join(main, '.claude/worktrees/beta')));

  assert.equal(promptSubmitTitle(root, { prompt: '  go beta\n', cwd: alpha, session_title: 'alpha' }), 'beta');
});

test('prompt-submit replaces a title that names an archived task', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(worktree(root, main, path.join(root, 'alpha')));
  archive(root, 'main', 'finished-task');

  assert.equal(promptSubmitTitle(root, { prompt: 'go alpha', cwd: main, session_title: 'finished-task' }), 'alpha');
});

test('prompt-submit ignores the archive of another repository', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(worktree(root, main, path.join(root, 'alpha')));
  archive(root, 'other', 'finished-task');

  assert.equal(promptSubmit(root, { prompt: 'go alpha', cwd: main, session_title: 'finished-task' }), '');
});

test('prompt-submit keeps a title the operator chose', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(worktree(root, main, path.join(root, 'alpha')));

  assert.equal(promptSubmit(root, { prompt: 'go alpha', cwd: main, session_title: 'my custom name' }), '');
});

test('prompt-submit prints nothing when the title already names the task', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const alpha = worktree(root, main, path.join(root, 'alpha'));
  ledgerIn(alpha);

  assert.equal(promptSubmit(root, { prompt: 'go alpha', cwd: alpha, session_title: 'alpha' }), '');
});

test('prompt-submit prints nothing for a slug with no active ledger', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(worktree(root, main, path.join(root, 'alpha')));
  archive(root, 'main', 'finished-task');

  assert.equal(promptSubmit(root, { prompt: 'go unknown', cwd: main }), '');
  assert.equal(promptSubmit(root, { prompt: 'go finished-task', cwd: main }), '');
});

test('prompt-submit prints nothing unless the prompt is exactly go and one slug', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(worktree(root, main, path.join(root, 'alpha')));

  for (const prompt of ['go', 'go ', 'go alpha beta', 'please go alpha', 'go alpha\nand more', 'Go alpha', 'goalpha', 'go\nalpha']) {
    assert.equal(promptSubmit(root, { prompt, cwd: main }), '', JSON.stringify(prompt));
  }
});

test('prompt-submit prints nothing outside a git repository', (t) => {
  const root = scratch(t);
  const plain = path.join(root, 'plain');
  ledgerIn(plain, '# Task ledger — alpha\n');
  ledgerIn(path.join(plain, '.claude/worktrees/alpha'), '# Task ledger — alpha\n');

  assert.equal(promptSubmit(root, { prompt: 'go alpha', cwd: plain }), '');
});

test('prompt-submit prints nothing for input that is not JSON', (t) => {
  const root = scratch(t);
  const result = promptSubmitRaw(root, 'go alpha');

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('prompt-submit emits a slug with quotes and backslashes as valid JSON', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  const slug = 'a"b\\c';
  ledgerIn(worktree(root, main, path.join(root, 'odd')), `# Task ledger — ${slug}\n`);

  assert.equal(promptSubmitTitle(root, { prompt: `go ${slug}`, cwd: main }), slug);
});

test('prompt-submit skips a worktree whose folder is gone', (t) => {
  const root = scratch(t);
  const main = repository(root, 'main');
  ledgerIn(worktree(root, main, path.join(root, 'alpha')));
  rmSync(worktree(root, main, path.join(root, 'gone')), { recursive: true, force: true });

  assert.equal(promptSubmitTitle(root, { prompt: 'go alpha', cwd: main }), 'alpha');
});
