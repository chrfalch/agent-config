import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { freshHome, REPO, run } from './helpers.js';

const TASK_NEW = path.join(REPO, 'bin/cc-task-new');
const TEMPLATE = readFileSync(path.join(REPO, 'ledger.template.md'), 'utf8');
const GOAL_PLACEHOLDER = '<one paragraph — what done looks like>';

function git(home: string, directory: string, ...args: string[]): string {
  const result = run(home, ['git', '-C', directory, '-c', 'user.name=test', '-c', 'user.email=test@example.com'], ...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function taskNew(home: string, cwd: string, ...args: string[]) {
  return taskNewVia(home, cwd, TASK_NEW, ...args);
}

function taskNewVia(home: string, cwd: string, script: string, ...args: string[]) {
  return run(home, ['bash', '-c', 'cd "$1" && shift && exec "$@"', '_'], cwd, script, ...args);
}

// realpath, because git reports a tmpdir under /var as /private/var.
function checkout(t: TestContext) {
  const home = realpathSync(freshHome(t));
  const main = path.join(home, 'main');
  mkdirSync(main);
  git(home, main, 'init', '--quiet', '-b', 'main');
  git(home, main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  const first = git(home, main, 'rev-parse', 'HEAD');
  git(home, main, 'commit', '--quiet', '--allow-empty', '-m', 'second');
  const second = git(home, main, 'rev-parse', 'HEAD');
  return { home, main, first, second };
}

function linkedWorktree(home: string, main: string, branch: string) {
  const worktree = path.join(main, '.claude/worktrees', branch);
  git(home, main, 'worktree', 'add', '--quiet', '-b', branch, worktree);
  git(home, worktree, 'commit', '--quiet', '--allow-empty', '-m', `work on ${branch}`);
  return worktree;
}

function branches(home: string, main: string): string {
  return git(home, main, 'for-each-ref', '--format=%(refname)', 'refs/heads');
}

function expectedLedger(slug: string, goal: string | null, worktree: string, branch: string, base: string): string {
  const lines = TEMPLATE.split('\n').map((line) => {
    if (line === '# Task ledger — <slug>') return `# Task ledger — ${slug}`;
    if (line === GOAL_PLACEHOLDER && goal !== null) return goal;
    if (line === '- worktree: <path>') return `- worktree: ${worktree}`;
    if (line === '- branch: <name>') return `- branch: ${branch}`;
    if (line === '- base: <branch/commit>') return `- base: ${base}`;
    return line;
  });
  return lines.join('\n');
}

test('creates a worktree, branch and filled ledger from the main checkout', (t) => {
  const { home, main, second } = checkout(t);
  const result = taskNew(home, main, 'fix-login', '--goal', 'Users can log in again.');
  assert.equal(result.status, 0, result.stderr);

  const worktree = path.join(main, '.claude/worktrees/fix-login');
  const ledger = path.join(worktree, '.claude/ledger.md');
  const short = git(home, main, 'rev-parse', '--short', second);
  assert.equal(git(home, worktree, 'branch', '--show-current'), 'fix-login');
  assert.equal(git(home, worktree, 'rev-parse', 'HEAD'), second);
  assert.equal(
    readFileSync(ledger, 'utf8'),
    expectedLedger('fix-login', 'Users can log in again.', worktree, 'fix-login', `main @ ${short}`),
  );
  assert.equal(
    result.stdout,
    [
      `worktree ${worktree}`,
      'branch   fix-login',
      `base     main @ ${short}`,
      `ledger   ${ledger}`,
      `start:   cd ${worktree} && claude`,
      '',
    ].join('\n'),
  );
});

test('keeps the goal placeholder when no goal is given', (t) => {
  const { home, main } = checkout(t);
  const result = taskNew(home, main, 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  const ledger = readFileSync(path.join(main, '.claude/worktrees/fix-login/.claude/ledger.md'), 'utf8');
  assert.ok(ledger.includes(`## Goal\n${GOAL_PLACEHOLDER}\n`), ledger);
  assert.ok(ledger.startsWith('# Task ledger — fix-login\n'), ledger);
});

test('writes a goal with sed and shell metacharacters verbatim', (t) => {
  const { home, main } = checkout(t);
  const goal = `Fix a/b & c|d \\1 \\n "double" 'single' $HOME \`date\` <one> %s`;
  const result = taskNew(home, main, 'odd-goal', '--goal', goal);
  assert.equal(result.status, 0, result.stderr);
  const ledger = readFileSync(path.join(main, '.claude/worktrees/odd-goal/.claude/ledger.md'), 'utf8');
  assert.ok(ledger.includes(`## Goal\n${goal}\n\n## Location\n`), ledger);
});

test('runs through a relative symlink called from another folder', (t) => {
  const { home, main } = checkout(t);
  const links = path.join(home, 'bin');
  mkdirSync(links);
  const link = path.join(links, 'cc-task-new');
  symlinkSync(path.relative(links, TASK_NEW), link);
  // Deeper than the link, so the target misresolves if read against the cwd.
  const cwd = path.join(main, 'a/b/c');
  mkdirSync(cwd, { recursive: true });

  const result = taskNewVia(home, cwd, link, 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(main, '.claude/worktrees/fix-login/.claude/ledger.md')));
});

test('runs through a chain of two symlinks', (t) => {
  const { home, main } = checkout(t);
  mkdirSync(path.join(home, 'first'));
  mkdirSync(path.join(home, 'second'));
  const first = path.join(home, 'first/cc-task-new');
  const second = path.join(home, 'second/cc-task-new');
  symlinkSync(TASK_NEW, first);
  symlinkSync(first, second);

  const result = taskNewVia(home, main, second, 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(main, '.claude/worktrees/fix-login/.claude/ledger.md')));
});

test('removes the new worktree and branch when a step after creating them fails', (t) => {
  const { home, main } = checkout(t);
  // A tracked file named .claude makes the ledger folder impossible to create.
  git(home, main, 'checkout', '--quiet', '-b', 'blocked');
  writeFileSync(path.join(main, '.claude'), '');
  git(home, main, 'add', '.claude');
  git(home, main, 'commit', '--quiet', '-m', 'track a .claude file');
  git(home, main, 'checkout', '--quiet', 'main');
  const branchesBefore = branches(home, main);
  const worktreesBefore = git(home, main, 'worktree', 'list', '--porcelain');

  const result = taskNew(home, main, 'fix-login', '--base', 'blocked');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(branches(home, main), branchesBefore);
  assert.equal(git(home, main, 'worktree', 'list', '--porcelain'), worktreesBefore);
  assert.equal(existsSync(path.join(main, '.claude/worktrees/fix-login')), false);
});

test('from a linked worktree, lands under the main checkout and leaves the caller ledger alone', (t) => {
  const { home, main, second } = checkout(t);
  const caller = linkedWorktree(home, main, 'other-task');
  const callerLedger = path.join(caller, '.claude/ledger.md');
  mkdirSync(path.dirname(callerLedger), { recursive: true });
  writeFileSync(callerLedger, '# Task ledger — other-task\n\nmine, do not touch\n');
  const before = readFileSync(callerLedger);

  const result = taskNew(home, caller, 'fix-login', '--goal', 'Users can log in again.');
  assert.equal(result.status, 0, result.stderr);

  const worktree = path.join(main, '.claude/worktrees/fix-login');
  assert.ok(existsSync(path.join(worktree, '.claude/ledger.md')));
  assert.equal(existsSync(path.join(caller, '.claude/worktrees')), false);
  assert.equal(git(home, worktree, 'rev-parse', 'HEAD'), second);
  assert.deepEqual(readFileSync(callerLedger), before);
});

test('defaults to the commit origin/HEAD points at', (t) => {
  const { home, main, first } = checkout(t);
  git(home, main, 'update-ref', 'refs/remotes/origin/main', first);
  git(home, main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  const result = taskNew(home, main, 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  const worktree = path.join(main, '.claude/worktrees/fix-login');
  const short = git(home, main, 'rev-parse', '--short', first);
  assert.equal(git(home, worktree, 'rev-parse', 'HEAD'), first);
  assert.ok(result.stdout.includes(`base     origin/main @ ${short}\n`), result.stdout);
  assert.ok(readFileSync(path.join(worktree, '.claude/ledger.md'), 'utf8').includes(`- base: origin/main @ ${short}\n`));
});

test('--stack starts at the calling worktree branch', (t) => {
  const { home, main } = checkout(t);
  const caller = linkedWorktree(home, main, 'feature');
  const head = git(home, caller, 'rev-parse', 'HEAD');

  const result = taskNew(home, caller, 'follow-up', '--stack');
  assert.equal(result.status, 0, result.stderr);
  const worktree = path.join(main, '.claude/worktrees/follow-up');
  const short = git(home, main, 'rev-parse', '--short', head);
  assert.equal(git(home, worktree, 'rev-parse', 'HEAD'), head);
  assert.ok(result.stdout.includes(`base     feature @ ${short}\n`), result.stdout);
  assert.ok(readFileSync(path.join(worktree, '.claude/ledger.md'), 'utf8').includes(`- base: feature @ ${short}\n`));
});

test('--base starts the branch at that ref', (t) => {
  const { home, main, first } = checkout(t);
  git(home, main, 'tag', 'v1', first);

  const result = taskNew(home, main, 'fix-login', '--base', 'v1');
  assert.equal(result.status, 0, result.stderr);
  const worktree = path.join(main, '.claude/worktrees/fix-login');
  assert.equal(git(home, worktree, 'rev-parse', 'HEAD'), first);
  assert.ok(result.stdout.includes(`base     v1 @ ${git(home, main, 'rev-parse', '--short', first)}\n`), result.stdout);
});

test('--branch names the branch and keeps the folder named after the slug', (t) => {
  const { home, main } = checkout(t);
  const result = taskNew(home, main, 'fix-login', '--branch', 'chrfalch/fix-login');
  assert.equal(result.status, 0, result.stderr);
  const worktree = path.join(main, '.claude/worktrees/fix-login');
  assert.equal(git(home, worktree, 'branch', '--show-current'), 'chrfalch/fix-login');
  assert.ok(result.stdout.includes('branch   chrfalch/fix-login\n'), result.stdout);
  const ledger = readFileSync(path.join(worktree, '.claude/ledger.md'), 'utf8');
  assert.ok(ledger.startsWith('# Task ledger — fix-login\n'), ledger);
  assert.ok(ledger.includes('- branch: chrfalch/fix-login\n'), ledger);
});

test('ledger-list.sh in the main checkout lists the new ledger', (t) => {
  const { home, main } = checkout(t);
  assert.equal(taskNew(home, main, 'fix-login').status, 0);
  const result = run(home, ['bash', '-c', 'cd "$1" && bash "$2" paths', '_'], main, path.join(REPO, 'hooks/ledger-list.sh'));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.split('\n').includes(path.join(main, '.claude/worktrees/fix-login/.claude/ledger.md')),
    result.stdout,
  );
});

const failures: { name: string; args: string[]; arrange?: (home: string, main: string) => string | void }[] = [
  { name: 'no slug', args: [] },
  { name: 'an uppercase slug', args: ['Fix-Login'] },
  { name: 'a slug with a slash', args: ['fix/login'] },
  { name: 'a slug with a space', args: ['fix login'] },
  { name: 'a slug with an underscore', args: ['fix_login'] },
  { name: 'a slug that starts with a dash', args: ['-fix'] },
  { name: 'a second slug', args: ['fix-login', 'extra'] },
  { name: 'an unknown flag', args: ['fix-login', '--force'] },
  { name: '--goal without a value', args: ['fix-login', '--goal'] },
  { name: '--base and --stack together', args: ['fix-login', '--base', 'main', '--stack'] },
  { name: 'an unknown --base ref', args: ['fix-login', '--base', 'no-such-ref'] },
  { name: 'an invalid --branch name', args: ['fix-login', '--branch', 'bad..name'] },
  {
    name: 'an existing branch',
    args: ['fix-login'],
    arrange: (home, main) => void git(home, main, 'branch', 'fix-login'),
  },
  {
    name: 'an existing target folder',
    args: ['fix-login'],
    arrange: (_home, main) => void mkdirSync(path.join(main, '.claude/worktrees/fix-login'), { recursive: true }),
  },
  {
    name: '--stack on a detached HEAD',
    args: ['fix-login', '--stack'],
    arrange: (home, main) => {
      const caller = linkedWorktree(home, main, 'feature');
      git(home, caller, 'checkout', '--quiet', '--detach');
      return caller;
    },
  },
];

for (const { name, args, arrange } of failures) {
  test(`fails and creates nothing on ${name}`, (t) => {
    const { home, main } = checkout(t);
    const cwd = arrange?.(home, main) ?? main;
    const target = path.join(main, '.claude/worktrees/fix-login');
    const folderBefore = existsSync(target);
    const branchesBefore = branches(home, main);
    const worktreesBefore = git(home, main, 'worktree', 'list', '--porcelain');

    const result = taskNew(home, cwd, ...args);
    assert.equal(result.status, 1, result.stderr);
    assert.notEqual(result.stderr.trim(), '');
    assert.equal(result.stdout, '');
    assert.equal(branches(home, main), branchesBefore);
    assert.equal(git(home, main, 'worktree', 'list', '--porcelain'), worktreesBefore);
    assert.equal(existsSync(target), folderBefore);
    assert.equal(existsSync(path.join(target, '.claude/ledger.md')), false);
  });
}

test('fails outside a git repository', (t) => {
  const home = realpathSync(freshHome(t));
  const result = taskNew(home, home, 'fix-login');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /git/);
  assert.equal(existsSync(path.join(home, '.claude/worktrees')), false);
});
