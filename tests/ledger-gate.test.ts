import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { REPO } from './helpers.js';

const LEDGER_GATE = path.join(REPO, 'hooks/ledger-gate.sh');

function scratch(t: TestContext): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-ledger-gate-')));
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

type ToolInput =
  | { file_path: string; content?: string; old_string?: string; new_string?: string; edits?: { old_string: string; new_string: string }[] }
  | { command: string };

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

const SESSION = '/private/tmp/claude-501/-Users-me-repos-app/3757e52e-56c2-4bea-866f-8e427c324a1e';
const citations = [
  `${SESSION}/scratchpad/xcodebuild-red.log`,
  '/tmp/claude-501/-Users-me-repos-app/3757e52e-56c2-4bea-866f-8e427c324a1e/tasks/b1.output',
  '/tmp/claude-501/-Users-me-repos-app/3757E52E-56C2-4BEA-866F-8E427C324A1E/tasks/b1.output',
  '<scratchpad>/handover.md',
  'scratchpad/review-1.txt',
];
const prose = [
  'Files in the session scratchpad are deleted by macOS.',
  'Evidence used to live under /tmp/claude-501 and is lost.',
  '- red: .claude/evidence/xcodebuild-red.log',
  'The scratchpad/ folder is not cited.',
];

/** The tool input that writes `text` into `file` with each file tool. */
function writing(tool: string, file: string, text: string): ToolInput {
  switch (tool) {
    case 'Write':
      return { file_path: file, content: `# Task ledger — task\n\n${text}\n` };
    case 'Edit':
      return { file_path: file, old_string: '- <decision>', new_string: text };
    default:
      return { file_path: file, edits: [{ old_string: 'a', new_string: 'fine' }, { old_string: 'b', new_string: text }] };
  }
}

for (const tool of ['Write', 'Edit', 'MultiEdit']) {
  for (const citation of citations) {
    test(`${tool} of a worktree ledger that cites ${citation} is denied`, (t) => {
      const { root, worktree } = checkouts(t);
      assertDenied(gate(root, worktree, tool, writing(tool, path.join(worktree, '.claude/ledger.md'), `- red: ${citation}`)));
    });
  }

  for (const text of prose) {
    test(`${tool} of a worktree ledger with ${JSON.stringify(text)} is allowed`, (t) => {
      const { root, worktree } = checkouts(t);
      assertAllowed(gate(root, worktree, tool, writing(tool, path.join(worktree, '.claude/ledger.md'), text)));
    });
  }

  test(`${tool} of a backlog ledger that cites the scratchpad is denied`, (t) => {
    const { root, plain } = checkouts(t);
    const backlog = path.join(root, '.claude/ledger-backlog/main/idea.md');
    assertDenied(gate(root, plain, tool, writing(tool, backlog, `- notes: ${citations[0]}`)));
    assertAllowed(gate(root, plain, tool, writing(tool, backlog, '- red: .claude/evidence/red.log')));
  });

  test(`${tool} of a file that is not a ledger may cite the scratchpad`, (t) => {
    const { root, worktree } = checkouts(t);
    assertAllowed(gate(root, worktree, tool, writing(tool, path.join(worktree, 'docs/notes.md'), `- red: ${citations[0]}`)));
  });
}

test('an Edit whose old text cites the scratchpad and new text does not is allowed', (t) => {
  const { root, worktree } = checkouts(t);
  const edit = { file_path: path.join(worktree, '.claude/ledger.md'), old_string: `- red: ${citations[0]}`, new_string: '- red: .claude/evidence/red.log' };
  assertAllowed(gate(root, worktree, 'Edit', edit));
});

test('the citation deny reason says why and names .claude/evidence/', (t) => {
  const { root, worktree } = checkouts(t);
  const reason = assertDenied(gate(root, worktree, 'Write', writing('Write', path.join(worktree, '.claude/ledger.md'), `- red: ${citations[0]}`)));
  assert.match(reason, /macOS deletes/);
  assert.ok(reason.includes('.claude/evidence/'), reason);
  assert.match(reason, /two separate commands/);
  assert.doesNotMatch(reason, /cc-task-new/);
});

test('a ledger write in a main checkout that also cites the scratchpad keeps the main-checkout reason', (t) => {
  const { root, main } = checkouts(t);
  const reason = assertDenied(gate(root, main, 'Write', writing('Write', path.join(main, '.claude/ledger.md'), `- red: ${citations[0]}`)));
  assert.match(reason, /main checkout/);
});

const bashCitingWrites = [
  `cat > .claude/ledger.md <<EOF\n# Task ledger — task\n- red: ${citations[0]}\nEOF`,
  "echo '- handover: <scratchpad>/handover.md' >> .claude/ledger.md",
  "printf '%s\\n' '- review: scratchpad/review-1.txt' | tee -a .claude/ledger.md",
  `cat >> ~/.claude/ledger-backlog/main/idea.md <<EOF\n- red: ${citations[1]}\nEOF`,
];

for (const command of bashCitingWrites) {
  test(`Bash ${JSON.stringify(command)} in a linked worktree is denied`, (t) => {
    const { root, worktree } = checkouts(t);
    assertDenied(gate(root, worktree, 'Bash', { command }));
  });
}

const bashAllowedNearCitations = [
  `cp ${citations[0]} .claude/evidence/xcodebuild-red.log`,
  `cat ${citations[0]} > .claude/evidence/red.log`,
  "echo '- the scratchpad is gone; see .claude/evidence/red.log' >> .claude/ledger.md",
];

for (const command of bashAllowedNearCitations) {
  test(`Bash ${JSON.stringify(command)} in a linked worktree is allowed`, (t) => {
    const { root, worktree } = checkouts(t);
    assertAllowed(gate(root, worktree, 'Bash', { command }));
  });
}
