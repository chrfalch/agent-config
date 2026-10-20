import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { REPO } from './helpers.js';

const LEDGER_GATE = path.join(REPO, 'hooks/ledger-gate.sh');

function scratch(t: TestContext): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-config-ledger-gate-')));
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

/** A main checkout with a linked worktree inside it, the way cc-task-new lays them out. */
function checkouts(t: TestContext) {
  const root = scratch(t);
  const main = path.join(root, 'main');
  mkdirSync(main);
  git(root, main, 'init', '--quiet');
  git(root, main, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
  const worktree = path.join(main, '.claude/worktrees/task');
  git(root, main, 'worktree', 'add', '--quiet', '-b', 'task', worktree);
  const plain = path.join(root, 'plain');
  mkdirSync(plain);
  return { root, main, worktree, plain };
}

type ToolInput = { file_path: string } | { command: string };

function gate(root: string, cwd: string, toolName: string, toolInput: ToolInput) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd });
  const result = spawnSync('bash', [LEDGER_GATE], { cwd: root, env: environment(root), input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function assertDenied(stdout: string): string {
  assert.notEqual(stdout, '', 'expected a deny decision, got silence');
  const output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

function assertAllowed(stdout: string): void {
  assert.equal(stdout, '', `expected silence, got ${stdout}`);
}

for (const tool of ['Write', 'Edit', 'MultiEdit']) {
  test(`${tool} of the ledger in a main checkout is denied`, (t) => {
    const { root, main } = checkouts(t);
    assertDenied(gate(root, main, tool, { file_path: path.join(main, '.claude/ledger.md') }));
  });

  test(`${tool} of the ledger in a linked worktree is allowed`, (t) => {
    const { root, main, worktree } = checkouts(t);
    assertAllowed(gate(root, main, tool, { file_path: path.join(worktree, '.claude/ledger.md') }));
  });
}

test('a relative file_path is resolved against the hook cwd', (t) => {
  const { root, main, worktree } = checkouts(t);
  assertDenied(gate(root, main, 'Write', { file_path: '.claude/ledger.md' }));
  assertAllowed(gate(root, worktree, 'Write', { file_path: '.claude/ledger.md' }));
});

test('the deny reason points at cc-task-new and the worktree it prints', (t) => {
  const { root, main } = checkouts(t);
  const reason = assertDenied(gate(root, main, 'Write', { file_path: path.join(main, '.claude/ledger.md') }));
  assert.match(reason, /worktree/);
  assert.ok(reason.includes(`${path.join(REPO, 'bin/cc-task-new')} <slug> --goal '`), reason);
  assert.ok(reason.includes(path.join(main, '.claude/ledger.md')), reason);
});

test('the deny reason says the new task starts in the backlog and how to promote it to a worktree', (t) => {
  const { root, main } = checkouts(t);
  const reason = assertDenied(gate(root, main, 'Write', { file_path: path.join(main, '.claude/ledger.md') }));
  assert.match(reason, /backlog/);
  assert.ok(reason.includes(`${path.join(REPO, 'bin/cc-task-new')} --promote <slug>`), reason);
});

test('other files in a main checkout are allowed', (t) => {
  const { root, main } = checkouts(t);
  for (const file of ['.claude/settings.json', 'docs/ledger.md', '.claude/ledger.md.bak', 'ledger.md']) {
    assertAllowed(gate(root, main, 'Write', { file_path: path.join(main, file) }));
  }
});

test('the ledger outside any git repository is allowed', (t) => {
  const { root, plain } = checkouts(t);
  assertAllowed(gate(root, plain, 'Write', { file_path: path.join(plain, '.claude/ledger.md') }));
  assertAllowed(gate(root, plain, 'Bash', { command: 'echo x > .claude/ledger.md' }));
});

const bashWrites = [
  'echo x > .claude/ledger.md',
  'echo x >> .claude/ledger.md',
  'echo x>.claude/ledger.md',
  'cat > .claude/ledger.md <<EOF\n# Task ledger\nEOF',
  "printf '%s' x > \".claude/ledger.md\"",
  'echo x | tee .claude/ledger.md',
  'echo x | tee -a .claude/ledger.md > /dev/null',
  'cp /tmp/x .claude/ledger.md',
  'mv -f /tmp/x .claude/ledger.md && git status',
  "sed -i '' 's/a/b/' .claude/ledger.md",
  "sed -i.bak -e 's/a/b/' .claude/ledger.md",
  'git status; echo x >> ./.claude/ledger.md',
  'cp x .claude/ledger.md 2>/dev/null',
  'cp x .claude/ledger.md 2> /dev/null',
  'cp x .claude/ledger.md > /dev/null',
  'cp x .claude/ledger.md 2>&1',
  '  cp x .claude/ledger.md',
  '\tcp x .claude/ledger.md',
  'sudo tee .claude/ledger.md < x',
  'sudo cp x .claude/ledger.md',
  'ls | xargs -I{} cp {} .claude/ledger.md',
  'env FOO=1 cp x .claude/ledger.md',
  'FOO=1 cp x .claude/ledger.md',
  'command cp x .claude/ledger.md',
  '/bin/cp x .claude/ledger.md',
  '{ cp x .claude/ledger.md; }',
  'if true; then cp x .claude/ledger.md; fi',
  '(mv a .claude/ledger.md)',
  'echo $(cp x .claude/ledger.md)',
  'cp x .claude/ledger.md < /dev/null',
  'cp x .claude/ledger.md <<< hi',
  'mv a .claude/ledger.md < /dev/null',
  'tee .claude/ledger.md < /tmp/x',
];

for (const command of bashWrites) {
  test(`Bash ${JSON.stringify(command)} in a main checkout is denied`, (t) => {
    const { root, main } = checkouts(t);
    assertDenied(gate(root, main, 'Bash', { command }));
  });
}

test('Bash write to an absolute ledger path in a main checkout is denied from anywhere', (t) => {
  const { root, main, plain } = checkouts(t);
  assertDenied(gate(root, plain, 'Bash', { command: `echo x >> ${path.join(main, '.claude/ledger.md')}` }));
  assertDenied(gate(root, plain, 'Bash', { command: `cp /tmp/x '${path.join(main, '.claude/ledger.md')}'` }));
});

test('a Bash write after cd into a worktree is denied with a hint to use the absolute path', (t) => {
  const { root, main } = checkouts(t);
  const reason = assertDenied(gate(root, main, 'Bash', { command: 'cd .claude/worktrees/task && echo x > .claude/ledger.md' }));
  assert.ok(reason.includes("absolute path to the worktree's .claude/ledger.md"), reason);
});

test('Bash write through ~ to a ledger in a main checkout is denied', (t) => {
  const { root, main, plain } = checkouts(t);
  const fromHome = path.relative(root, path.join(main, '.claude/ledger.md'));
  assertDenied(gate(root, plain, 'Bash', { command: `echo x > ~/${fromHome}` }));
});

const bashReads = [
  'cat .claude/ledger.md',
  'grep -n Goal .claude/ledger.md',
  'cp .claude/ledger.md /tmp/ledger-copy.md',
  'cat .claude/ledger.md > /tmp/ledger-copy.md',
  'sed -n 1,20p .claude/ledger.md',
  'echo x > docs/ledger.md',
  'echo x > .claude/settings.json',
  'grep tee .claude/ledger.md',
  'grep -n cp .claude/ledger.md',
  'rg -i mv .claude/ledger.md',
  'tee /tmp/y < .claude/ledger.md',
  'tee -a /tmp/log < .claude/ledger.md',
];

for (const command of bashReads) {
  test(`Bash ${JSON.stringify(command)} in a main checkout is allowed`, (t) => {
    const { root, main } = checkouts(t);
    assertAllowed(gate(root, main, 'Bash', { command }));
  });
}

function assertFailsOpen(input: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync('bash', [LEDGER_GATE], { env, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assertAllowed(result.stdout);
}

function writeInput(cwd: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x > .claude/ledger.md' }, cwd });
}

test('malformed JSON input is allowed', (t) => {
  const { root } = checkouts(t);
  assertFailsOpen('{not json', environment(root));
});

test('a git failure is allowed', (t) => {
  const { root, main } = checkouts(t);
  assertFailsOpen(writeInput(main), { ...environment(root), GIT_DIR: path.join(root, 'missing') });
});

test('a missing jq is allowed', (t) => {
  const { root, main } = checkouts(t);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  for (const tool of ['bash', 'cat', 'dirname', 'git', 'grep', 'sed', 'awk', 'tr', 'readlink']) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(found, path.join(bin, tool));
  }
  assertFailsOpen(writeInput(main), { ...environment(root), PATH: bin });
});

for (const command of bashWrites) {
  test(`Bash ${JSON.stringify(command)} in a linked worktree is allowed`, (t) => {
    const { root, worktree } = checkouts(t);
    assertAllowed(gate(root, worktree, 'Bash', { command }));
  });
}
