import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { HELP } from '../mods/ledger/hooks/ledger.js';
import { REPO } from './helpers.js';

const read = (file: string) => readFileSync(path.join(REPO, file), 'utf8').replace(/\s+/g, ' ');

test('/ledger:task continues in this session when there is no current ledger', () => {
  const task = read('mods/ledger/commands/task.md');
  assert.match(task, /`\.claude\/ledger\.md` in the working directory/);
  assert.match(task, /If there is no current ledger, there is no old task to clear\. Move this session into the new worktree with the EnterWorktree tool/);
  assert.match(task, /continue with the operator's request in this session/);
});

test('/ledger:task without a current ledger reads the new ledger and follows the plan gate', () => {
  const step7 = read('mods/ledger/commands/task.md').match(/ 7\. If there is no current ledger.*/)?.[0] ?? '';
  assert.match(step7, /EnterWorktree.*Read `\.claude\/ledger\.md` in the new worktree/);
  assert.match(step7, /get the plan approved, then write the approved plan into the ledger/);
});

test('/ledger:task still hands over the start: line when a current ledger exists', () => {
  const task = read('mods/ledger/commands/task.md');
  assert.match(task, /under its Decisions/);
  assert.match(task, /Reply with the `start:` line/);
});

test('the "New work, new task" rule describes both cases', () => {
  const bullet = read('rules/10-operating-model.md').match(/\*\*New work, new task\.\*\*.*? - \*\*/)?.[0] ?? '';
  assert.match(bullet, /Without a current ledger, it moves the session into the new worktree with `EnterWorktree`/);
  assert.match(bullet, /`start:` line/);
});

test('/ledger:help says /ledger:task continues in this session without a current ledger', () => {
  const line = HELP.split('\n').find(l => l.startsWith('- `/ledger:task`')) ?? '';
  assert.match(line, /continues in this session/);
});

test('the usage guide covers the case with no open task', () => {
  const usage = read('docs/usage.md');
  assert.match(usage, /EnterWorktree/);
  assert.match(usage, /without `\/ledger:go`/);
});

test('the usage guide presents the start: line only for the case with another task open', () => {
  const usage = read('docs/usage.md');
  assert.doesNotMatch(usage, /plan approval, typing the `start:` line that a new task prints, and/);
  assert.match(usage, /`start:` line that a new task prints when another task is open/);
});

test('the README says /ledger:task continues in this session when no task is open', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /with the goal filled in\. The reply tells you to type `\/clear`, then `go <name>`/);
  assert.match(readme, /When no task is open, the session moves into the new worktree and continues there/);
});

test('the README no longer says /ledger:update starts a task', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /the same way `\/ledger:task` does/);
  assert.match(readme, /With no ledger in the working directory, the agent creates nothing and tells you to use `\/ledger:task`/);
});

test('/ledger:update with no ledger creates nothing and points to /ledger:task', () => {
  const update = read('mods/ledger/commands/update.md');
  assert.doesNotMatch(update, /cc-task-new/);
  assert.doesNotMatch(update, /`start:` line/);
  assert.doesNotMatch(update, /start a task/i);
  assert.match(update, /If `\.claude\/ledger\.md` does not exist, create nothing\. Tell the operator to use `\/ledger:task <what the task is>`/);
});

test('/ledger:help no longer says /ledger:update starts a task', () => {
  const line = HELP.split('\n').find(l => l.startsWith('- `/ledger:update`')) ?? '';
  assert.match(line, /Write the latest results/);
  assert.doesNotMatch(line, /start a task/);
});

test('the installation guide no longer says /ledger:update starts a task', () => {
  assert.doesNotMatch(read('docs/installation.md'), /When there is no ledger, it starts a task/);
});
