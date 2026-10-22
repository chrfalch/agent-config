import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { freshHome, REPO, run } from './helpers.js';

const retire = [path.join(REPO, 'bin/cc-worktree-retire')] as const;
const ddPath = path.join(REPO, 'bin/cc-dd-path');

function git(home: string, directory: string, ...args: string[]): string {
  const result = run(home, ['git', '-C', directory, '-c', 'user.name=test', '-c', 'user.email=test@example.com'], ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function worktreeWithBuildFolders(t: TestContext, configurations: string[]) {
  const home = freshHome(t);
  const main = path.join(home, 'main');
  mkdirSync(main);
  git(home, main, 'init', '--quiet');
  writeFileSync(path.join(main, 'file.txt'), 'one\n');
  git(home, main, 'add', 'file.txt');
  git(home, main, 'commit', '--quiet', '-m', 'initial');
  const worktree = path.join(home, 'wt-a');
  git(home, main, 'worktree', 'add', '--quiet', '-b', 'test/wt-a', worktree);

  // The folders come from cc-dd-path itself, so a change to its naming formula fails these tests.
  const own = configurations.map((configuration) => {
    const result = run(home, ['bash', '-c', 'cd "$1" && "$2" "$3"', '_'], worktree, ddPath, configuration);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  });
  const derivedData = path.join(home, 'Library/Developer/Xcode/DerivedData');
  // 'zzzzzz' is not hex, so it can never equal the worktree's real hash.
  const unrelated = ['cc-wt-a-zzzzzz-Debug-sim', 'BareExpo-xyz'].map((name) => path.join(derivedData, name));
  for (const folder of unrelated) mkdirSync(folder, { recursive: true });
  for (const folder of own) assert.ok(existsSync(folder), folder);
  return { home, worktree, own, unrelated };
}

test('retire deletes the worktree build folders and keeps the others', (t) => {
  const { home, worktree, own, unrelated } = worktreeWithBuildFolders(t, ['Debug-sim', 'Debug-device']);
  const result = run(home, retire, worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(worktree), false);
  for (const folder of own) {
    assert.equal(existsSync(folder), false, folder);
    assert.ok(result.stdout.includes(`deleted  ${folder}\n`), result.stdout);
  }
  for (const folder of unrelated) assert.ok(existsSync(folder), folder);
  assert.equal(result.stdout.match(/^deleted {2}/gm)?.length, own.length, result.stdout);
});

test('retire without build folders prints no deleted line', (t) => {
  const { home, worktree } = worktreeWithBuildFolders(t, []);
  const result = run(home, retire, worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(worktree), false);
  assert.ok(result.stdout.includes(`removed  ${worktree}\n`), result.stdout);
  assert.doesNotMatch(result.stdout, /deleted/);
});

test('retire keeps the build folders when git refuses to remove the worktree', (t) => {
  const { home, worktree, own, unrelated } = worktreeWithBuildFolders(t, ['Debug-sim', 'Debug-device']);
  writeFileSync(path.join(worktree, 'file.txt'), 'changed\n');
  const result = run(home, retire, worktree);
  assert.notEqual(result.status, 0);
  assert.ok(existsSync(worktree));
  for (const folder of [...own, ...unrelated]) assert.ok(existsSync(folder), folder);
  assert.doesNotMatch(result.stdout, /deleted/);
});

type Entry = { repo: string; slug: string; path: string; branch: string; status: string; archivePath?: string };

function worktreeWithLedger(t: TestContext) {
  const { home, worktree } = worktreeWithBuildFolders(t, []);
  // info/exclude is shared by every worktree, so the untracked ledger does not block the removal.
  writeFileSync(path.join(home, 'main/.git/info/exclude'), '.claude/\n');
  const ledger = path.join(worktree, '.claude/ledger.md');
  mkdirSync(path.dirname(ledger));
  writeFileSync(ledger, `# Task ledger — wt-title\n\n## Location\n- worktree: ${worktree}\n- branch: test/wt-a\n`);
  return { home, worktree, ledger };
}

const registered = (home: string) =>
  (JSON.parse(readFileSync(path.join(home, '.claude/ledgers.json'), 'utf8')) as Entry[]).map(
    ({ repo, slug, path, branch, status, archivePath }) => ({ repo, slug, path, branch, status, archivePath }),
  );
const archivedPath = (stdout: string) => stdout.match(/^(?:already )?archived (.+)$/m)?.[1];

test('retire marks the registered ledger archived at the printed archive path', (t) => {
  const { home, worktree, ledger } = worktreeWithLedger(t);
  const upsert = run(home, [path.join(REPO, 'bin/cc-ledgers')], 'upsert', ledger, '--repo', 'main', '--slug', 'wt-title', '--branch', 'test/wt-a');
  assert.equal(upsert.status, 0, upsert.stderr);

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  const archive = archivedPath(result.stdout);
  assert.ok(archive, result.stdout);
  assert.deepEqual(registered(home), [
    { repo: 'main', slug: 'wt-title', path: ledger, branch: 'test/wt-a', status: 'archived', archivePath: archive },
  ]);
});

test('retire registers an archived entry when the ledger was never registered', (t) => {
  const { home, worktree, ledger } = worktreeWithLedger(t);

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  const archive = archivedPath(result.stdout);
  assert.ok(archive, result.stdout);
  assert.deepEqual(registered(home), [
    { repo: 'main', slug: 'wt-title', path: ledger, branch: 'test/wt-a', status: 'archived', archivePath: archive },
  ]);
});

test('retire registers nothing as archived when the worktree removal fails', (t) => {
  const { home, worktree } = worktreeWithLedger(t);
  writeFileSync(path.join(worktree, 'file.txt'), 'changed\n');

  const result = run(home, retire, worktree);

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(worktree), true);
  assert.equal(existsSync(path.join(home, '.claude/ledgers.json')), false);
});

test('retire still archives and removes the worktree when the registry cannot be written', (t) => {
  const { home, worktree } = worktreeWithLedger(t);
  mkdirSync(path.join(home, '.claude/ledgers.json'));

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: registry not updated/);
  assert.match(result.stdout, /^archived /m);
  assert.equal(existsSync(worktree), false);
});

test('retire of an already archived ledger registers the existing copy', (t) => {
  const { home, worktree, ledger } = worktreeWithLedger(t);
  const existing = path.join(home, '.claude/ledger-archive/main/2026-01-01-wt-a.md');
  mkdirSync(path.dirname(existing), { recursive: true });
  writeFileSync(existing, readFileSync(ledger));

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`already archived ${existing}\n`), result.stdout);
  assert.deepEqual(
    registered(home).map(({ status, archivePath }) => ({ status, archivePath })),
    [{ status: 'archived', archivePath: existing }],
  );
});

function hasBranch(home: string, directory: string, branch: string): boolean {
  return run(home, ['git', '-C', directory, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

const mainOf = (home: string) => path.join(home, 'main');
const headOf = (home: string, directory: string) => git(home, directory, 'rev-parse', 'HEAD');

test('retire keeps the branch without --delete-branch', (t) => {
  const { home, worktree } = worktreeWithBuildFolders(t, []);
  const result = run(home, retire, worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(hasBranch(home, mainOf(home), 'test/wt-a'));
  assert.doesNotMatch(result.stdout, /branch/);
});

for (const order of ['before', 'after'] as const) {
  test(`retire --delete-branch <sha> ${order} --force deletes the branch after removing the worktree`, (t) => {
    const { home, worktree } = worktreeWithBuildFolders(t, ['Debug-sim']);
    const deleteBranch = ['--delete-branch', headOf(home, worktree)];
    const result = run(home, retire, worktree, ...(order === 'before' ? [...deleteBranch, '--force'] : ['--force', ...deleteBranch]));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(worktree), false);
    assert.equal(hasBranch(home, mainOf(home), 'test/wt-a'), false);
    assert.match(result.stdout, /\ndeleted  branch test\/wt-a\n$/);
  });
}

test('retire --delete-branch <sha> deletes a branch git does not count as merged', (t) => {
  const { home, worktree } = worktreeWithBuildFolders(t, []);
  writeFileSync(path.join(worktree, 'file.txt'), 'squashed elsewhere\n');
  git(home, worktree, 'commit', '--quiet', '-am', 'unmerged in git terms');
  const result = run(home, retire, worktree, '--delete-branch', headOf(home, worktree));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hasBranch(home, mainOf(home), 'test/wt-a'), false);
});

test('retire --delete-branch <sha> removes the branch config, as git branch -D does', (t) => {
  const { home, worktree } = worktreeWithBuildFolders(t, []);
  git(home, worktree, 'config', 'branch.test/wt-a.merge', 'refs/heads/test/wt-a');
  const result = run(home, retire, worktree, '--delete-branch', headOf(home, worktree));
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(run(home, ['git', '-C', mainOf(home), 'config', '--get-regexp', '^branch\\.test/wt-a\\.']).status, 0);
});

test('retire --delete-branch <sha> keeps a branch that moved past that commit, and still succeeds', (t) => {
  const { home, worktree } = worktreeWithBuildFolders(t, []);
  const checked = headOf(home, worktree);
  writeFileSync(path.join(worktree, 'file.txt'), 'landed after the check\n');
  git(home, worktree, 'commit', '--quiet', '-am', 'landed after the check');
  const moved = headOf(home, worktree);
  const result = run(home, retire, worktree, '--delete-branch', checked);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(home, mainOf(home), 'rev-parse', 'refs/heads/test/wt-a'), moved);
  assert.match(result.stdout, /\nkept {5}branch test\/wt-a, because it moved after retire checked it\n$/);
  assert.doesNotMatch(result.stdout, /deleted {2}branch/);
});

for (const [name, args] of [
  ['without a sha', ['--delete-branch']],
  ['with a flag in place of the sha', ['--delete-branch', '--force']],
  ['with an abbreviated sha', ['--delete-branch', 'c0ffee1']],
  ['with a sha that is not hex', ['--delete-branch', 'z'.repeat(40)]],
] as const) {
  test(`retire --delete-branch ${name} is a usage error and changes nothing`, (t) => {
    const { home, worktree } = worktreeWithBuildFolders(t, []);
    const result = run(home, retire, worktree, ...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^usage: cc-worktree-retire <worktree-path> \[--delete-branch <sha>\] \[--force\]$/m);
    assert.equal(result.stdout, '');
    assert.ok(existsSync(worktree));
    assert.ok(hasBranch(home, mainOf(home), 'test/wt-a'));
  });
}

test('retire --delete-branch <sha> keeps the branch when git refuses to remove the worktree', (t) => {
  const { home, worktree } = worktreeWithBuildFolders(t, []);
  writeFileSync(path.join(worktree, 'file.txt'), 'changed\n');
  const result = run(home, retire, worktree, '--delete-branch', headOf(home, worktree));
  assert.notEqual(result.status, 0);
  assert.ok(existsSync(worktree));
  assert.ok(hasBranch(home, mainOf(home), 'test/wt-a'));
});

test('retire --delete-branch <sha> marks the ledger archived and deletes the branch', (t) => {
  const { home, worktree, ledger } = worktreeWithLedger(t);

  const result = run(home, retire, worktree, '--delete-branch', headOf(home, worktree));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(hasBranch(home, mainOf(home), 'test/wt-a'), false);
  assert.deepEqual(
    registered(home).map(({ path, status, archivePath }) => ({ path, status, archivePath })),
    [{ path: ledger, status: 'archived', archivePath: archivedPath(result.stdout) }],
  );
});

function taskIn(home: string, folder: string, slug: string, rest: string) {
  const worktree = path.join(home, folder);
  git(home, mainOf(home), 'worktree', 'add', '--quiet', '-b', `test/${folder}`, worktree);
  const ledger = path.join(worktree, '.claude/ledger.md');
  mkdirSync(path.dirname(ledger));
  writeFileSync(ledger, `# Task ledger — ${slug}\n\n## Location\n- worktree: ${worktree}\n- branch: test/${folder}\n${rest}`);
  return { worktree, ledger };
}

// The retiring child is wt-title in wt-a; the parent is epic in wt-epic.
function family(t: TestContext, children: string) {
  const { home, worktree, ledger } = worktreeWithLedger(t);
  writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}- parent: epic\n`);
  const parent = taskIn(home, 'wt-epic', 'epic', `\n## Children\n${children}\n## Next step\nWait.\n`);
  return { home, worktree, parent };
}

const today = () => {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
};
const HINT = 'Parent epic has no active children left. Retire it with /ledger:retire epic.';

test('retire of a child marks it retired in the parent Children section', (t) => {
  const { home, worktree, parent } = family(t, '- wt-title\n- sibling\n');
  const before = readFileSync(parent.ledger, 'utf8');

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(parent.ledger, 'utf8'), before.replace('- wt-title\n', `- wt-title (retired ${today()})\n`));
  assert.doesNotMatch(result.stdout, /^Parent /m);
});

test('retire of the last active child prints one line that names the parent to retire', (t) => {
  const { home, worktree, parent } = family(t, '- sibling (retired 2026-10-01)\n- wt-title\n');

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(parent.ledger, 'utf8'), new RegExp(`^- wt-title \\(retired ${today()}\\)$`, 'm'));
  assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('Parent ')), [HINT]);
});

test('retire leaves the parent Children section as it is when the worktree removal fails', (t) => {
  const { home, worktree, parent } = family(t, '- wt-title\n');
  const before = readFileSync(parent.ledger, 'utf8');
  writeFileSync(path.join(worktree, 'file.txt'), 'changed\n');

  const result = run(home, retire, worktree);

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(parent.ledger, 'utf8'), before);
  assert.doesNotMatch(result.stdout, /^Parent /m);
});

test('retire refuses a parent with active children, names them, and changes nothing', (t) => {
  const { home, parent } = family(t, '- wt-title\n- sibling (retired 2026-10-01)\n- other\n');

  const result = run(home, retire, parent.worktree);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]*wt-title, other[^\n]*--force[^\n]*\n$/);
  assert.doesNotMatch(result.stderr, /sibling/);
  assert.equal(result.stdout, '');
  assert.ok(existsSync(parent.worktree));
  assert.equal(existsSync(path.join(home, '.claude/ledger-archive')), false);
});

test('retire --force retires a parent with active children', (t) => {
  const { home, parent } = family(t, '- wt-title\n');

  const result = run(home, retire, parent.worktree, '--force');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(parent.worktree), false);
  assert.match(result.stdout, /^archived /m);
});

test('retire of a parent whose children are all retired needs no --force', (t) => {
  const { home, parent } = family(t, '- wt-title (retired 2026-10-01)\n');

  const result = run(home, retire, parent.worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(parent.worktree), false);
});

test('retire -f retires a parent with active children, as --force does', (t) => {
  const { home, parent } = family(t, '- wt-title\n');

  const result = run(home, retire, parent.worktree, '-f');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(parent.worktree), false);
});

test('retire of a child marks it retired in a CRLF parent ledger and keeps CRLF', (t) => {
  const { home, worktree, parent } = family(t, '- wt-title\n');
  const childLedger = path.join(worktree, '.claude/ledger.md');
  for (const ledger of [childLedger, parent.ledger]) writeFileSync(ledger, readFileSync(ledger, 'utf8').replace(/\n/g, '\r\n'));
  const before = readFileSync(parent.ledger, 'utf8');

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(parent.ledger, 'utf8'), before.replace('- wt-title\r\n', `- wt-title (retired ${today()})\r\n`));
  assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('Parent ')), [HINT]);
});

test('retire reads only the section headed exactly Children', (t) => {
  const { home, worktree, parent } = family(t, '- wt-title\n');
  const stale = '## Children (old)\n- other\n- wt-title\n\n';
  writeFileSync(parent.ledger, readFileSync(parent.ledger, 'utf8').replace('## Children\n', `${stale}## Children \t\n`));
  const before = readFileSync(parent.ledger, 'utf8');

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(parent.ledger, 'utf8'),
    before.replace('## Children \t\n- wt-title\n', `## Children \t\n- wt-title (retired ${today()})\n`),
  );
  assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('Parent ')), [HINT]);
});

test('retire does not count the lines of a section that only starts with Children', (t) => {
  const { home } = worktreeWithLedger(t);
  const old = taskIn(home, 'wt-old', 'old', '\n## Children (old)\n- other\n');

  const result = run(home, retire, old.worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(old.worktree), false);
});

test('retire of a child keeps the file mode of the parent ledger', (t) => {
  const { home, worktree, parent } = family(t, '- wt-title\n');
  chmodSync(parent.ledger, 0o600);

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(parent.ledger, 'utf8'), /^- wt-title \(retired \d{4}-\d\d-\d\d\)$/m);
  assert.equal(statSync(parent.ledger).mode & 0o777, 0o600);
});

/** A PATH whose `name` always fails, ahead of the real one. */
function failing(home: string, name: string): string {
  const stubs = path.join(home, 'stubs');
  mkdirSync(stubs, { recursive: true });
  writeFileSync(path.join(stubs, name), '#!/bin/sh\necho "stub $0 failed" >&2\nexit 1\n', { mode: 0o755 });
  return `${stubs}:${process.env.PATH ?? ''}`;
}

test('retire only warns when date fails while it marks the parent', (t) => {
  const { home, worktree, parent } = family(t, '- wt-title\n');
  // Archived already, so the marker is the only step that asks date for today.
  const archive = path.join(home, '.claude/ledger-archive/main');
  mkdirSync(archive, { recursive: true });
  writeFileSync(path.join(archive, '2026-10-01-wt-a.md'), readFileSync(path.join(worktree, '.claude/ledger.md')));
  const before = readFileSync(parent.ledger, 'utf8');

  const result = run(home, ['env', `PATH=${failing(home, 'date')}`, ...retire], worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(worktree), false);
  assert.equal(readFileSync(parent.ledger, 'utf8'), before);
  const lines = result.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, result.stderr);
  assert.ok(lines[0]?.startsWith('warning: ') && lines[0].includes(parent.ledger) && lines[0].includes("'- wt-title'"), result.stderr);
});

test('retire only warns when rm fails to clean up after a failed parent write', (t) => {
  const { home, worktree, parent } = family(t, '- wt-title\n');
  const folder = path.dirname(parent.ledger);

  chmodSync(folder, 0o555);
  let result;
  try {
    result = run(home, ['env', `PATH=${failing(home, 'rm')}`, ...retire], worktree);
  } finally {
    chmodSync(folder, 0o755);
  }

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(worktree), false);
  const lines = result.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, result.stderr);
  assert.ok(lines[0]?.includes(parent.ledger), result.stderr);
});

test('retire finishes when the parent ledger cannot be written, and names the line to change by hand', (t) => {
  const { home, worktree, parent } = family(t, '- wt-title\n');
  const before = readFileSync(parent.ledger, 'utf8');
  const folder = path.dirname(parent.ledger);

  chmodSync(folder, 0o555);
  let result;
  try {
    result = run(home, retire, worktree, '--delete-branch', headOf(home, worktree));
  } finally {
    chmodSync(folder, 0o755);
  }

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(parent.ledger, 'utf8'), before);
  assert.equal(existsSync(worktree), false);
  assert.equal(hasBranch(home, mainOf(home), 'test/wt-a'), false);
  assert.equal(registered(home)[0]?.status, 'archived');
  const lines = result.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, result.stderr);
  assert.ok(lines[0]?.includes(parent.ledger), result.stderr);
  assert.ok(lines[0]?.includes(`- wt-title (retired ${today()})`), result.stderr);
  assert.doesNotMatch(result.stdout, /^Parent /m);
});

// A backlog task has no worktree: its ledger is ~/.claude/ledger-backlog/<main checkout folder>/<slug>.md, and names its
// main checkout as git reports it, so through realpath.
function backlogTask(home: string, slug: string, rest = '') {
  const main = realpathSync(mainOf(home));
  const ledger = path.join(home, '.claude/ledger-backlog', path.basename(main), `${slug}.md`);
  mkdirSync(path.dirname(ledger), { recursive: true });
  writeFileSync(ledger, `# Task ledger — ${slug}\n\n## Location\n- main: ${main}\n${rest}`);
  return ledger;
}

const parentLines = (stdout: string) => stdout.split('\n').filter((line) => line.startsWith('Parent '));

test('retire of a backlog ledger archives it, deletes it and marks its registry entry archived', (t) => {
  const { home, worktree } = worktreeWithLedger(t);
  const ledger = backlogTask(home, 'idea');
  const text = readFileSync(ledger, 'utf8');
  const upsert = run(home, [path.join(REPO, 'bin/cc-ledgers')], 'upsert', ledger);
  assert.equal(upsert.status, 0, upsert.stderr);

  const result = run(home, retire, ledger);

  assert.equal(result.status, 0, result.stderr);
  const archive = path.join(home, `.claude/ledger-archive/main/${today()}-idea.md`);
  assert.equal(result.stdout, `archived ${archive}\nremoved  ${ledger}\n`);
  assert.equal(readFileSync(archive, 'utf8'), text);
  assert.equal(existsSync(ledger), false);
  assert.ok(existsSync(worktree));
  assert.deepEqual(registered(home), [{ repo: 'main', slug: 'idea', path: ledger, branch: '', status: 'archived', archivePath: archive }]);
});

test('retire refuses a backlog parent with active children and changes nothing, and --force retires it', (t) => {
  const { home } = worktreeWithLedger(t);
  const ledger = backlogTask(home, 'epic', '\n## Children\n- wt-title\n- old (retired 2026-10-01)\n');

  const refused = run(home, retire, ledger);

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^epic has active children: wt-title\. [^\n]*--force[^\n]*\n$/);
  assert.equal(refused.stdout, '');
  assert.ok(existsSync(ledger));
  assert.equal(existsSync(path.join(home, '.claude/ledger-archive')), false);

  const forced = run(home, retire, ledger, '--force');

  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(existsSync(ledger), false);
});

test('retire of a worktree child marks it retired in a backlog parent and names the parent to retire', (t) => {
  const { home, worktree, ledger } = worktreeWithLedger(t);
  writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}- parent: epic\n`);
  const parent = backlogTask(home, 'epic', '\n## Children\n- wt-title\n');
  const before = readFileSync(parent, 'utf8');

  const result = run(home, retire, worktree);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(readFileSync(parent, 'utf8'), before.replace('- wt-title\n', `- wt-title (retired ${today()})\n`));
  assert.deepEqual(parentLines(result.stdout), [HINT]);
});

test('retire of a backlog child marks it retired in a worktree parent and names the parent to retire', (t) => {
  const { home } = worktreeWithLedger(t);
  const child = backlogTask(home, 'idea', '- parent: epic\n');
  const parent = taskIn(home, 'wt-epic', 'epic', '\n## Children\n- idea\n');
  const before = readFileSync(parent.ledger, 'utf8');

  const result = run(home, retire, child);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(parent.ledger, 'utf8'), before.replace('- idea\n', `- idea (retired ${today()})\n`));
  assert.deepEqual(parentLines(result.stdout), [HINT]);
});

test('retire of a backlog child marks it retired in a backlog parent that keeps another active child', (t) => {
  const { home } = worktreeWithLedger(t);
  const child = backlogTask(home, 'idea', '- parent: epic\n');
  const parent = backlogTask(home, 'epic', '\n## Children\n- idea\n- wt-title\n');

  const result = run(home, retire, child);

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(parent, 'utf8'), new RegExp(`^- idea \\(retired ${today()}\\)\\n- wt-title\\n`, 'm'));
  assert.deepEqual(parentLines(result.stdout), []);
});

test('retire --delete-branch with a backlog ledger is a usage error and changes nothing', (t) => {
  const { home } = worktreeWithLedger(t);
  const ledger = backlogTask(home, 'idea');

  const result = run(home, retire, ledger, '--delete-branch', 'a'.repeat(40));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^usage: cc-worktree-retire /m);
  assert.ok(existsSync(ledger));
});

for (const option of ['--dry-run', '--porcelain', 'extra']) {
  test(`retire ${option} with a backlog ledger is a usage error and changes neither the ledger nor the registry`, (t) => {
    const { home } = worktreeWithLedger(t);
    const ledger = backlogTask(home, 'idea');
    const text = readFileSync(ledger, 'utf8');
    const upsert = run(home, [path.join(REPO, 'bin/cc-ledgers')], 'upsert', ledger);
    assert.equal(upsert.status, 0, upsert.stderr);
    const before = registered(home);

    const result = run(home, retire, ledger, option);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^usage: cc-worktree-retire /m);
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(ledger, 'utf8'), text);
    assert.equal(existsSync(path.join(home, '.claude/ledger-archive')), false);
    assert.deepEqual(registered(home), before);
  });
}

test('retire of a file that is not a backlog ledger is refused and changes nothing', (t) => {
  const { home, worktree, ledger } = worktreeWithLedger(t);

  const result = run(home, retire, ledger);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, `not a backlog ledger: ${ledger}\n`);
  assert.ok(existsSync(worktree));
  assert.ok(existsSync(ledger));
});
