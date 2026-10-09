import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
