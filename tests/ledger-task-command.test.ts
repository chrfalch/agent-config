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
  const step7 = task.match(/ 7\. If there is no current ledger.*/)?.[0] ?? '';
  assert.match(step7, /there is no old task to clear/);
  assert.match(step7, /move this session into the new worktree with the EnterWorktree tool/i);
  assert.match(task, /continue with the operator's request in this session/);
});

test('/ledger:task without a current ledger reads the new ledger and follows the plan gate', () => {
  const step7 = read('mods/ledger/commands/task.md').match(/ 7\. If there is no current ledger.*/)?.[0] ?? '';
  assert.match(step7, /EnterWorktree.*Read `\.claude\/ledger\.md` in the new worktree/);
  assert.match(step7, /get the plan approved, then write the approved plan into the ledger/);
});

test('/ledger:task without a current ledger promotes the backlog task, then enters the worktree --promote printed', () => {
  const step7 = read('mods/ledger/commands/task.md').match(/ 7\. If there is no current ledger.*/)?.[0] ?? '';
  assert.match(step7, /without `--stack`, .*`--promote <slug>`.*EnterWorktree/i);
  assert.doesNotMatch(step7, /Before that/);
  assert.match(step7, /Set `path` to the path on the `worktree` line that `--promote` printed/);
});

test('/ledger:task with a current ledger leaves the task in the backlog', () => {
  const step6 = read('mods/ledger/commands/task.md').match(/ 6\. If there is a current ledger.*? 7\. /)?.[0] ?? '';
  assert.match(step6, /under its Decisions/);
  assert.doesNotMatch(step6, /--promote/);
});

test('/ledger:task describes both cases in its frontmatter', () => {
  const description = read('mods/ledger/commands/task.md').match(/description: (.*?) argument-hint:/)?.[1] ?? '';
  assert.match(description, /backlog ledger/);
  assert.match(description, /With no current ledger, it starts the task at once and continues in this session/);
});

test('/ledger:help says /ledger:task starts the task at once without a current ledger', () => {
  const line = HELP.split('\n').find(l => l.startsWith('- `/ledger:task`')) ?? '';
  assert.match(line, /backlog/);
  assert.match(line, /With no current ledger, it starts the task at once and continues in this session/);
});

test('the "New work, new task" rule promotes at once without a current ledger', () => {
  const bullet = read('rules/10-operating-model.md').match(/\*\*New work, new task\.\*\*.*? - \*\*/)?.[0] ?? '';
  assert.match(bullet, /Without a current ledger, it promotes the task with `bin\/cc-task-new --promote <slug>`.*Then it moves the session into the new worktree with `EnterWorktree`/);
  assert.doesNotMatch(bullet, /that worktree\. If you/);
});

test('the "New work, new task" rule says how to promote without the ledger mod', () => {
  const bullet = read('rules/10-operating-model.md').match(/\*\*New work, new task\.\*\*.*? - \*\*/)?.[0] ?? '';
  assert.match(bullet, /Without the ledger mod, run `bin\/cc-task-new <slug> --goal '<one paragraph>'`.*Then `bin\/cc-task-new --promote <slug>` creates the worktree and branch/);
});

test('no document says promotion branches from the current main branch', () => {
  for (const file of ['README.md', 'DECISIONS.md', 'docs/usage.md', 'docs/installation.md', 'rules/10-operating-model.md', 'mods/ledger/commands/go.md', 'mods/ledger/commands/task.md']) {
    assert.doesNotMatch(read(file), /current main/, file);
  }
});

test('/ledger:help and the /ledger:all description both mention backlog tasks', () => {
  const line = HELP.split('\n').find(l => l.startsWith('- `/ledger:all`')) ?? '';
  const description = read('mods/ledger/commands/all.md').match(/description: (.*?) (argument-hint:|---)/)?.[1] ?? '';
  assert.match(line, /active, backlog and archived/);
  assert.match(description, /active, backlog and archived/);
});

test('each document names the stored --base first when it describes where promotion branches from', () => {
  for (const file of ['README.md', 'docs/usage.md', 'docs/installation.md']) {
    assert.match(read(file), /`--base`.*?Without one, .*?`origin\/HEAD`.*?Without `origin\/HEAD`/, file);
  }
});

test('the README /ledger:all row names the Backlog section', () => {
  const row = read('README.md').match(/\| `\/ledger:all` \|[^|]*\|/)?.[0] ?? '';
  assert.match(row, /active and archived, with its next step\. Backlog tasks follow in their own section, \*\*Backlog\*\*\./);
});

test('/ledger:task still hands over the start: line when a current ledger exists', () => {
  const task = read('mods/ledger/commands/task.md');
  assert.match(task, /under its Decisions/);
  assert.match(task, /Reply with the `start:` line/);
});

test('the "New work, new task" rule describes both cases', () => {
  const bullet = read('rules/10-operating-model.md').match(/\*\*New work, new task\.\*\*.*? - \*\*/)?.[0] ?? '';
  assert.match(bullet, /Without a current ledger, .*moves the session into the new worktree with `EnterWorktree`/);
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
