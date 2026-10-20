import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
