import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { snapshot } from './helpers.js';

function tree(t: TestContext, make: (root: string) => void): Record<string, string> {
  const root = mkdtempSync(path.join(tmpdir(), 'ledger-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  make(root);
  return snapshot(root);
}

test('snapshot tells an empty file from an empty directory', (t) => {
  const file = tree(t, (root) => writeFileSync(path.join(root, 'entry'), ''));
  const directory = tree(t, (root) => mkdirSync(path.join(root, 'entry')));
  assert.notDeepEqual(file, directory);
});

test('snapshot tells apart files whose bytes are not valid UTF-8', (t) => {
  const first = tree(t, (root) => writeFileSync(path.join(root, 'entry'), Buffer.from([0xff])));
  const second = tree(t, (root) => writeFileSync(path.join(root, 'entry'), Buffer.from([0xfe])));
  assert.notDeepEqual(first, second);
});

test('snapshot tells a symlink from a file that holds its target path', (t) => {
  const link = tree(t, (root) => symlinkSync('target', path.join(root, 'entry')));
  const file = tree(t, (root) => writeFileSync(path.join(root, 'entry'), '-> target'));
  assert.notDeepEqual(link, file);
});

test('snapshot is equal for equal trees', (t) => {
  const make = (root: string): void => {
    mkdirSync(path.join(root, 'dir'));
    writeFileSync(path.join(root, 'dir/file'), 'content');
    symlinkSync('dir/file', path.join(root, 'link'));
  };
  assert.deepEqual(tree(t, make), tree(t, make));
});
