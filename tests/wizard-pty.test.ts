import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { freshHome, REPO, snapshot } from './helpers.js';

const EXPECT = '/usr/bin/expect';
const skip = existsSync(EXPECT) ? false : `${EXPECT} is missing, and these tests need it to drive the wizard through a terminal`;

const ENTER = '\\r';
const DOWN = '\\033\\[B';
const CTRL_C = '\\003';

// A wait that times out fails the run, so a wizard that hangs fails the test instead of stalling it.
const SCRIPT_HEAD = `
set timeout 30
log_user 1
set stty_init "rows 40 cols 120"
proc wait_for {text} {
  expect {
    -ex $text {}
    timeout { puts stderr "TIMEOUT waiting for: $text"; exit 124 }
    eof { puts stderr "EOF waiting for: $text"; exit 125 }
  }
}
spawn bin/deploy
`;
const SCRIPT_TAIL = `
expect {
  eof {}
  timeout { puts stderr "TIMEOUT waiting for the wizard to exit"; exit 124 }
}
lassign [wait] pid spawn_id os_error status
exit $status
`;

function answer(prompt: string, ...keys: string[]): string {
  return [`wait_for {${prompt}}`, ...keys.map((key) => `send -- "${key}"`)].join('\nsleep 0.2\n');
}

const DEFAULT_SELECTIONS = [
  answer('What do you want to do?', ENTER),
  answer('Which components should deploy install?', ENTER),
  answer('Which agents?', ENTER),
  answer('Which models should the routing rules keep?', ENTER),
];

function wizard(home: string, steps: string[]) {
  const result = spawnSync(EXPECT, ['-c', SCRIPT_HEAD + steps.join('\n') + SCRIPT_TAIL], {
    cwd: REPO,
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

function homeWithOwnTemplate(t: Parameters<typeof freshHome>[0]): { home: string; template: string } {
  const home = freshHome(t);
  const template = path.join(home, '.claude/ledger.template.md');
  writeFileSync(template, 'MY OWN TEMPLATE\n');
  return { home, template };
}

test('asking for each file reads the answer, and n skips the file', { skip }, (t) => {
  const { home, template } = homeWithOwnTemplate(t);
  const { status, output } = wizard(home, [
    ...DEFAULT_SELECTIONS,
    answer('What should deploy do with them?', DOWN, ENTER),
    answer('[y/N]', `n${ENTER}`),
  ]);
  assert.equal(status, 0, output);
  assert.match(output, /skipped  ~\/\.claude\/ledger\.template\.md/);
  assert.ok(!lstatSync(template).isSymbolicLink());
  assert.equal(readFileSync(template, 'utf8'), 'MY OWN TEMPLATE\n');
});

test('asking for each file reads the answer, and y backs the file up and links it', { skip }, (t) => {
  const { home, template } = homeWithOwnTemplate(t);
  const { status, output } = wizard(home, [
    ...DEFAULT_SELECTIONS,
    answer('What should deploy do with them?', DOWN, ENTER),
    answer('[y/N]', `y${ENTER}`),
  ]);
  assert.equal(status, 0, output);
  assert.match(output, /linked   ~\/\.claude\/ledger\.template\.md/);
  assert.equal(readlinkSync(template), path.join(REPO, 'ledger.template.md'));
  const [backup] = readdirSync(path.join(home, '.claude/backups'));
  assert.equal(readFileSync(path.join(home, '.claude/backups', backup, '.claude/ledger.template.md'), 'utf8'), 'MY OWN TEMPLATE\n');
});

test('replacing all files backs them up and links them without asking', { skip }, (t) => {
  const { home, template } = homeWithOwnTemplate(t);
  const { status, output } = wizard(home, [
    ...DEFAULT_SELECTIONS,
    answer('What should deploy do with them?', ENTER),
  ]);
  assert.equal(status, 0, output);
  assert.match(output, /same as: bin\/deploy .*--force/);
  assert.doesNotMatch(output, /\[y\/N\]/);
  assert.equal(readlinkSync(template), path.join(REPO, 'ledger.template.md'));
  const [backup] = readdirSync(path.join(home, '.claude/backups'));
  assert.equal(readFileSync(path.join(home, '.claude/backups', backup, '.claude/ledger.template.md'), 'utf8'), 'MY OWN TEMPLATE\n');
});

test('Ctrl-C exits 1 and leaves HOME as it was', { skip }, (t) => {
  const { home } = homeWithOwnTemplate(t);
  const before = snapshot(home);
  const { status, output } = wizard(home, [
    answer('What do you want to do?', ENTER),
    answer('Which components should deploy install?', ENTER),
    answer('Which agents?', CTRL_C),
  ]);
  assert.equal(status, 1, output);
  assert.match(output, /Nothing was written\./);
  assert.deepEqual(snapshot(home), before);
});

test('cancelling after the preview exits 1 and leaves HOME as it was', { skip }, (t) => {
  const home = freshHome(t);
  const before = snapshot(home);
  const { status, output } = wizard(home, [
    ...DEFAULT_SELECTIONS,
    answer('Apply these changes?', 'n'),
  ]);
  assert.equal(status, 1, output);
  assert.match(output, /DRY RUN -- nothing was written\./);
  assert.match(output, /Nothing was written\./);
  assert.deepEqual(snapshot(home), before);
});

test('cancelling at the choice for files of your own exits 1 and leaves HOME as it was', { skip }, (t) => {
  const { home } = homeWithOwnTemplate(t);
  const before = snapshot(home);
  const { status, output } = wizard(home, [
    ...DEFAULT_SELECTIONS,
    answer('What should deploy do with them?', DOWN, DOWN, ENTER),
  ]);
  assert.equal(status, 1, output);
  assert.match(output, /REPLACE  ~\/\.claude\/ledger\.template\.md/);
  assert.match(output, /Nothing was written\./);
  assert.deepEqual(snapshot(home), before);
});

test('a deploy that fails after the preview reports the error and its status', { skip }, (t) => {
  const home = freshHome(t);
  const gitConfigDir = path.join(home, '.config/git');
  mkdirSync(gitConfigDir, { recursive: true });
  chmodSync(gitConfigDir, 0o555);
  // After hooks run in registration order, so freshHome's cleanup may already have removed it.
  t.after(() => existsSync(gitConfigDir) && chmodSync(gitConfigDir, 0o755));
  const { status, output } = wizard(home, [
    ...DEFAULT_SELECTIONS,
    answer('Apply these changes?', ENTER),
  ]);
  assert.equal(status, 1, output);
  assert.match(output, /EACCES: permission denied, mkdir '.*\/\.config\/git\/hooks'/);
  assert.match(output, /Deploy exited with status 1\./);
  assert.match(output, /└(?:\u001b\[\d+m)*  Deploy exited with status 1\./, 'the outro closes the frame');
});

test('a preview that throws is reported, and the wizard says nothing was written', { skip }, (t) => {
  const home = freshHome(t);
  writeFileSync(path.join(home, '.claude/backups'), 'a file where revert expects a directory\n');
  const { status, output } = wizard(home, [answer('What do you want to do?', DOWN, ENTER)]);
  assert.equal(status, 1, output);
  assert.match(output, /ENOTDIR/);
  assert.match(output, /Nothing was written\./);
});
