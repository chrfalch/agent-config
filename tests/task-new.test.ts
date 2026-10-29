import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

const backlogFile = (home: string, slug: string, repo = 'main') => path.join(home, '.claude/ledger-backlog', repo, `${slug}.md`);
const registryFile = (home: string) => path.join(home, '.claude/ledgers.json');
const registryText = (home: string) => (existsSync(registryFile(home)) ? readFileSync(registryFile(home), 'utf8') : null);
const registry = (home: string) => JSON.parse(readFileSync(registryFile(home), 'utf8')) as Record<string, string>[];

function backlogged(home: string, cwd: string, slug: string, ...args: string[]) {
  const result = taskNew(home, cwd, slug, ...args);
  assert.equal(result.status, 0, result.stderr);
  return backlogFile(home, slug);
}

function expectedBacklog(slug: string, goal: string | null, main: string, branch = '<name>', base = '<branch/commit>'): string {
  return expectedLedger(slug, goal, '<path>', branch, base).replace('## Location\n', `## Location\n- main: ${main}\n`);
}

function expectedLedger(slug: string, goal: string | null, worktree: string, branch: string, base: string): string {
  const lines = TEMPLATE.split('\n').filter((line) => !line.startsWith('- design refs: ')).map((line) => {
    if (line === '# Task ledger — <slug>') return `# Task ledger — ${slug}`;
    if (line === GOAL_PLACEHOLDER && goal !== null) return goal;
    if (line === '- worktree: <path>') return `- worktree: ${worktree}`;
    if (line === '- branch: <name>') return `- branch: ${branch}`;
    if (line === '- base: <branch/commit>') return `- base: ${base}`;
    return line;
  });
  return lines.join('\n');
}

test('the template has a Report section with only a hint, directly before Next step', () => {
  assert.match(TEMPLATE, /\n## Report\n<[^\n]*>\n\n## Next step\n/);
});

test('creates a worktree, branch and filled ledger from the main checkout', (t) => {
  const { home, main, second } = checkout(t);
  const result = taskNew(home, main, 'fix-login', '--stack', '--goal', 'Users can log in again.');
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
      'start:   /ledger:go fix-login',
      '',
    ].join('\n'),
  );
});

test('registers the new ledger as active in ~/.claude/ledgers.json', (t) => {
  const { home, main } = checkout(t);
  const result = taskNew(home, main, 'fix-login', '--stack', '--branch', 'me/fix-login');
  assert.equal(result.status, 0, result.stderr);

  const entries = JSON.parse(readFileSync(path.join(home, '.claude/ledgers.json'), 'utf8')) as Record<string, string>[];
  assert.deepEqual(
    entries.map(({ repo, slug, path, branch, status }) => ({ repo, slug, path, branch, status })),
    [
      {
        repo: 'main',
        slug: 'fix-login',
        path: path.join(main, '.claude/worktrees/fix-login/.claude/ledger.md'),
        branch: 'me/fix-login',
        status: 'active',
      },
    ],
  );
});

test('creates the task even when the registry cannot be written', (t) => {
  const { home, main } = checkout(t);
  rmSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(path.join(home, '.claude'), 'a file, so ~/.claude/ledgers.json cannot exist');

  const result = taskNew(home, main, 'fix-login', '--stack');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: registry not updated/);
  assert.ok(existsSync(path.join(main, '.claude/worktrees/fix-login/.claude/ledger.md')));
});

test('keeps the goal placeholder when no goal is given', (t) => {
  const { home, main } = checkout(t);
  const result = taskNew(home, main, 'fix-login', '--stack');
  assert.equal(result.status, 0, result.stderr);
  const ledger = readFileSync(path.join(main, '.claude/worktrees/fix-login/.claude/ledger.md'), 'utf8');
  assert.ok(ledger.includes(`## Goal\n${GOAL_PLACEHOLDER}\n`), ledger);
  assert.ok(ledger.startsWith('# Task ledger — fix-login\n'), ledger);
});

test('writes a goal with sed and shell metacharacters verbatim', (t) => {
  const { home, main } = checkout(t);
  const goal = `Fix a/b & c|d \\1 \\n "double" 'single' $HOME \`date\` <one> %s`;
  const result = taskNew(home, main, 'odd-goal', '--stack', '--goal', goal);
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

  const result = taskNewVia(home, cwd, link, 'fix-login', '--stack');
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

  const result = taskNewVia(home, main, second, 'fix-login', '--stack');
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
  const backlog = backlogged(home, main, 'fix-login', '--base', 'blocked');
  const backlogBefore = readFileSync(backlog, 'utf8');
  const registryBefore = registryText(home);
  const branchesBefore = branches(home, main);
  const worktreesBefore = git(home, main, 'worktree', 'list', '--porcelain');

  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(branches(home, main), branchesBefore);
  assert.equal(git(home, main, 'worktree', 'list', '--porcelain'), worktreesBefore);
  assert.equal(existsSync(path.join(main, '.claude/worktrees/fix-login')), false);
  assert.equal(readFileSync(backlog, 'utf8'), backlogBefore);
  assert.equal(registryText(home), registryBefore);
});

test('from a linked worktree, lands under the main checkout and leaves the caller ledger alone', (t) => {
  const { home, main, second } = checkout(t);
  const caller = linkedWorktree(home, main, 'other-task');
  const callerLedger = path.join(caller, '.claude/ledger.md');
  mkdirSync(path.dirname(callerLedger), { recursive: true });
  writeFileSync(callerLedger, '# Task ledger — other-task\n\nmine, do not touch\n');
  const before = readFileSync(callerLedger);

  const backlog = backlogged(home, caller, 'fix-login', '--goal', 'Users can log in again.');
  assert.ok(readFileSync(backlog, 'utf8').includes(`## Location\n- main: ${main}\n`));
  const result = taskNew(home, caller, '--promote', 'fix-login');
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

  backlogged(home, main, 'fix-login');
  const result = taskNew(home, main, '--promote', 'fix-login');
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

test('--base starts the branch at that ref when the task is promoted', (t) => {
  const { home, main, first } = checkout(t);
  git(home, main, 'tag', 'v1', first);

  const backlog = backlogged(home, main, 'fix-login', '--base', 'v1');
  assert.ok(readFileSync(backlog, 'utf8').includes('- base: v1\n'));
  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  const worktree = path.join(main, '.claude/worktrees/fix-login');
  assert.equal(git(home, worktree, 'rev-parse', 'HEAD'), first);
  assert.ok(result.stdout.includes(`base     v1 @ ${git(home, main, 'rev-parse', '--short', first)}\n`), result.stdout);
});

test('--branch names the branch made at promotion and keeps the folder named after the slug', (t) => {
  const { home, main } = checkout(t);
  const backlog = backlogged(home, main, 'fix-login', '--branch', 'chrfalch/fix-login');
  assert.ok(readFileSync(backlog, 'utf8').includes('- branch: chrfalch/fix-login\n'));
  assert.equal(branches(home, main), 'refs/heads/main');
  const result = taskNew(home, main, '--promote', 'fix-login');
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
  assert.equal(taskNew(home, main, 'fix-login', '--stack').status, 0);
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

function ownerWorktree(home: string, main: string, branch: string) {
  const worktree = path.join(main, '.claude/worktrees', branch.split('/').at(-1) ?? branch);
  git(home, main, 'worktree', 'add', '--quiet', '-b', branch, worktree);
  git(home, worktree, 'commit', '--quiet', '--allow-empty', '-m', `work on ${branch}`);
  return worktree;
}

test('--here adds a ledger to the current worktree, named after its branch without the owner prefix', (t) => {
  const { home, main } = checkout(t);
  const worktree = ownerWorktree(home, main, 'chrfalch/fix-login');
  const head = git(home, worktree, 'rev-parse', 'HEAD');
  const short = git(home, worktree, 'rev-parse', '--short', head);
  const branchesBefore = branches(home, main);
  const worktreesBefore = git(home, main, 'worktree', 'list', '--porcelain');

  const result = taskNew(home, worktree, '--here', '--goal', 'Users can log in again.');
  assert.equal(result.status, 0, result.stderr);

  const ledger = path.join(worktree, '.claude/ledger.md');
  assert.equal(
    readFileSync(ledger, 'utf8'),
    expectedLedger('fix-login', 'Users can log in again.', worktree, 'chrfalch/fix-login', `HEAD @ ${short}`),
  );
  assert.equal(
    result.stdout,
    [
      `worktree ${worktree}`,
      'branch   chrfalch/fix-login',
      `base     HEAD @ ${short}`,
      `ledger   ${ledger}`,
      'start:   /ledger:go fix-login',
      '',
    ].join('\n'),
  );
  assert.equal(branches(home, main), branchesBefore);
  assert.equal(git(home, main, 'worktree', 'list', '--porcelain'), worktreesBefore);
  assert.equal(git(home, worktree, 'rev-parse', 'HEAD'), head);
});

test('--here <slug> names the ledger after the slug given', (t) => {
  const { home, main } = checkout(t);
  const worktree = ownerWorktree(home, main, 'chrfalch/fix-login');
  const result = taskNew(home, worktree, '--here', 'login-again');
  assert.equal(result.status, 0, result.stderr);
  const ledger = readFileSync(path.join(worktree, '.claude/ledger.md'), 'utf8');
  assert.ok(ledger.startsWith('# Task ledger — login-again\n'), ledger);
  assert.ok(ledger.includes(`## Goal\n${GOAL_PLACEHOLDER}\n`), ledger);
  assert.ok(ledger.includes('- branch: chrfalch/fix-login\n'), ledger);
});

test('--here registers the ledger as active in ~/.claude/ledgers.json', (t) => {
  const { home, main } = checkout(t);
  const worktree = ownerWorktree(home, main, 'chrfalch/fix-login');
  const result = taskNew(home, worktree, '--here');
  assert.equal(result.status, 0, result.stderr);

  const entries = JSON.parse(readFileSync(path.join(home, '.claude/ledgers.json'), 'utf8')) as Record<string, string>[];
  assert.deepEqual(
    entries.map(({ repo, slug, path, branch, status }) => ({ repo, slug, path, branch, status })),
    [
      {
        repo: 'main',
        slug: 'fix-login',
        path: path.join(worktree, '.claude/ledger.md'),
        branch: 'chrfalch/fix-login',
        status: 'active',
      },
    ],
  );
});

test('--here from a subfolder writes the ledger at the worktree root', (t) => {
  const { home, main } = checkout(t);
  const worktree = ownerWorktree(home, main, 'fix-login');
  const cwd = path.join(worktree, 'src/deep');
  mkdirSync(cwd, { recursive: true });
  const result = taskNew(home, cwd, '--here');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(path.join(worktree, '.claude/ledger.md')));
  assert.equal(existsSync(path.join(cwd, '.claude')), false);
});

const hereFailures: { name: string; args: string[]; inMain?: boolean; arrange?: (worktree: string) => void }[] = [
  { name: 'the main checkout', args: ['--here'], inMain: true },
  {
    name: 'a worktree that already has a ledger',
    args: ['--here'],
    arrange: (worktree) => {
      mkdirSync(path.join(worktree, '.claude'), { recursive: true });
      writeFileSync(path.join(worktree, '.claude/ledger.md'), '# Task ledger — mine\n');
    },
  },
  { name: '--here with --stack', args: ['--here', '--stack'] },
  { name: '--here with --base', args: ['--here', '--base', 'main'] },
  { name: '--here with --branch', args: ['--here', '--branch', 'other'] },
  { name: '--here with a branch that is not a valid slug', args: ['--here'], arrange: () => undefined },
];

for (const { name, args, inMain, arrange } of hereFailures) {
  test(`--here fails and writes nothing on ${name}`, (t) => {
    const { home, main } = checkout(t);
    const branch = name.includes('not a valid slug') ? 'Feature_X' : 'fix-login';
    const worktree = ownerWorktree(home, main, branch);
    arrange?.(worktree);
    const cwd = inMain ? main : worktree;
    const ledger = path.join(cwd, '.claude/ledger.md');
    const ledgerBefore = existsSync(ledger) ? readFileSync(ledger, 'utf8') : null;
    const branchesBefore = branches(home, main);
    const worktreesBefore = git(home, main, 'worktree', 'list', '--porcelain');

    const result = taskNew(home, cwd, ...args);
    assert.equal(result.status, 1, result.stderr);
    assert.notEqual(result.stderr.trim(), '');
    assert.equal(result.stdout, '');
    assert.equal(existsSync(ledger) ? readFileSync(ledger, 'utf8') : null, ledgerBefore);
    assert.equal(branches(home, main), branchesBefore);
    assert.equal(git(home, main, 'worktree', 'list', '--porcelain'), worktreesBefore);
  });
}

test('a new task is a backlog ledger only: no worktree and no branch', (t) => {
  const { home, main } = checkout(t);
  const branchesBefore = branches(home, main);
  const worktreesBefore = git(home, main, 'worktree', 'list', '--porcelain');

  const result = taskNew(home, main, 'fix-login', '--goal', 'Users can log in again.');
  assert.equal(result.status, 0, result.stderr);

  const backlog = backlogFile(home, 'fix-login');
  assert.equal(readFileSync(backlog, 'utf8'), expectedBacklog('fix-login', 'Users can log in again.', main));
  assert.equal(result.stdout, [`ledger:  ${backlog}`, 'status:  backlog', 'start:   /ledger:go fix-login', ''].join('\n'));
  assert.equal(existsSync(path.join(main, '.claude/worktrees/fix-login')), false);
  assert.equal(branches(home, main), branchesBefore);
  assert.equal(git(home, main, 'worktree', 'list', '--porcelain'), worktreesBefore);
});

test('registers the backlog ledger with its main checkout', (t) => {
  const { home, main } = checkout(t);
  const backlog = backlogged(home, main, 'fix-login');
  const [entry, ...rest] = registry(home);
  assert.deepEqual(rest, []);
  assert.ok(entry);
  assert.deepEqual(
    { repo: entry.repo, slug: entry.slug, path: entry.path, branch: entry.branch, status: entry.status, main: entry.main },
    { repo: 'main', slug: 'fix-login', path: backlog, branch: '', status: 'backlog', main },
  );
});

test('a backlog ledger keeps --branch and --base for promotion and registers the branch', (t) => {
  const { home, main } = checkout(t);
  const backlog = backlogged(home, main, 'fix-login', '--branch', 'me/fix-login', '--base', 'main');
  assert.equal(readFileSync(backlog, 'utf8'), expectedBacklog('fix-login', null, main, 'me/fix-login', 'main'));
  assert.equal(registry(home)[0]?.branch, 'me/fix-login');
  assert.equal(branches(home, main), 'refs/heads/main');
});

const backlogRefusals: { name: string; args: string[]; arrange: (home: string, main: string) => void }[] = [
  {
    name: 'a backlog ledger that already exists',
    args: ['fix-login'],
    arrange: (home) => {
      mkdirSync(path.dirname(backlogFile(home, 'fix-login')), { recursive: true });
      writeFileSync(backlogFile(home, 'fix-login'), 'mine, do not touch\n');
    },
  },
  {
    name: 'an existing worktree folder',
    args: ['fix-login'],
    arrange: (_home, main) => void mkdirSync(path.join(main, '.claude/worktrees/fix-login'), { recursive: true }),
  },
  { name: 'an existing branch named after the slug', args: ['fix-login'], arrange: (home, main) => void git(home, main, 'branch', 'fix-login') },
  {
    name: 'an existing --branch',
    args: ['fix-login', '--branch', 'me/fix-login'],
    arrange: (home, main) => void git(home, main, 'branch', 'me/fix-login'),
  },
];

for (const { name, args, arrange } of backlogRefusals) {
  test(`a backlog task is refused with one line and nothing written on ${name}`, (t) => {
    const { home, main } = checkout(t);
    arrange(home, main);
    const backlog = backlogFile(home, 'fix-login');
    const backlogBefore = existsSync(backlog) ? readFileSync(backlog, 'utf8') : null;
    const branchesBefore = branches(home, main);
    const worktreesBefore = git(home, main, 'worktree', 'list', '--porcelain');

    const result = taskNew(home, main, ...args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
    assert.equal(existsSync(backlog) ? readFileSync(backlog, 'utf8') : null, backlogBefore);
    assert.equal(registryText(home), null);
    assert.equal(branches(home, main), branchesBefore);
    assert.equal(git(home, main, 'worktree', 'list', '--porcelain'), worktreesBefore);
  });
}

test('--promote moves the backlog ledger into a new worktree and keeps its other sections', (t) => {
  const { home, main, second } = checkout(t);
  const goal = 'Users can log in again.';
  const backlog = backlogged(home, main, 'fix-login', '--goal', goal);
  const decision = '- Keep the session cookie — because a/b & c \\1 $HOME';
  writeFileSync(backlog, readFileSync(backlog, 'utf8').replace('- <decision> — because <reason>', decision));

  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 0, result.stderr);

  const worktree = path.join(main, '.claude/worktrees/fix-login');
  const ledger = path.join(worktree, '.claude/ledger.md');
  const short = git(home, main, 'rev-parse', '--short', second);
  assert.equal(git(home, worktree, 'branch', '--show-current'), 'fix-login');
  assert.equal(git(home, worktree, 'rev-parse', 'HEAD'), second);
  assert.equal(
    readFileSync(ledger, 'utf8'),
    expectedLedger('fix-login', goal, worktree, 'fix-login', `main @ ${short}`).replace('- <decision> — because <reason>', decision),
  );
  assert.equal(
    result.stdout,
    [`worktree ${worktree}`, 'branch   fix-login', `base     main @ ${short}`, `ledger   ${ledger}`, ''].join('\n'),
  );
  assert.equal(existsSync(backlog), false);
  assert.deepEqual(
    registry(home).map(({ repo, slug, path, branch, status }) => ({ repo, slug, path, branch, status })),
    [{ repo: 'main', slug: 'fix-login', path: ledger, branch: 'fix-login', status: 'active' }],
  );
});

test('--promote of a slug with no backlog ledger exits 2 and makes nothing', (t) => {
  const { home, main } = checkout(t);
  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /no backlog task fix-login/);
  assert.equal(result.stdout, '');
  assert.equal(branches(home, main), 'refs/heads/main');
  assert.equal(existsSync(path.join(main, '.claude/worktrees/fix-login')), false);
});

test('--promote from another repository with the same folder name exits 3 and changes nothing', (t) => {
  const { home, main } = checkout(t);
  const backlog = backlogged(home, main, 'fix-login');
  const other = path.join(home, 'elsewhere/main');
  mkdirSync(other, { recursive: true });
  git(home, other, 'init', '--quiet', '-b', 'main');
  git(home, other, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  const backlogBefore = readFileSync(backlog, 'utf8');
  const registryBefore = registryText(home);

  const result = taskNew(home, other, '--promote', 'fix-login');
  assert.equal(result.status, 3, result.stderr);
  assert.ok(result.stderr.includes(main), result.stderr);
  assert.ok(result.stderr.includes('/ledger:go fix-login'), result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(readFileSync(backlog, 'utf8'), backlogBefore);
  assert.equal(registryText(home), registryBefore);
  assert.equal(branches(home, other), 'refs/heads/main');
  assert.equal(existsSync(path.join(other, '.claude/worktrees')), false);
});

test('--promote of a backlog ledger with no main line exits 4 and changes nothing', (t) => {
  const { home, main } = checkout(t);
  const backlog = backlogged(home, main, 'fix-login');
  writeFileSync(backlog, readFileSync(backlog, 'utf8').replace(`- main: ${main}\n`, ''));
  const backlogBefore = readFileSync(backlog, 'utf8');
  const registryBefore = registryText(home);

  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 4, result.stderr);
  assert.equal(result.stderr, `backlog ledger ${backlog} has no main line\n`);
  assert.equal(result.stdout, '');
  assert.equal(readFileSync(backlog, 'utf8'), backlogBefore);
  assert.equal(registryText(home), registryBefore);
  assert.equal(branches(home, main), 'refs/heads/main');
  assert.equal(existsSync(path.join(main, '.claude/worktrees/fix-login')), false);
});

test('--promote keeps a missing final newline missing', (t) => {
  const { home, main, second } = checkout(t);
  const backlog = backlogged(home, main, 'fix-login');
  writeFileSync(backlog, readFileSync(backlog, 'utf8').replace(/\n$/, ''));

  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  const worktree = path.join(main, '.claude/worktrees/fix-login');
  const short = git(home, main, 'rev-parse', '--short', second);
  assert.equal(
    readFileSync(path.join(worktree, '.claude/ledger.md'), 'utf8'),
    expectedLedger('fix-login', null, worktree, 'fix-login', `main @ ${short}`).replace(/\n$/, ''),
  );
});

const promoteRefusals: { name: string; arrange: (home: string, main: string, backlog: string) => void }[] = [
  { name: 'a branch made after the backlog task', arrange: (home, main) => void git(home, main, 'branch', 'fix-login') },
  {
    name: 'a worktree folder made after the backlog task',
    arrange: (_home, main) => void mkdirSync(path.join(main, '.claude/worktrees/fix-login'), { recursive: true }),
  },
  {
    name: 'a hand-edited invalid branch',
    arrange: (_home, _main, backlog) => writeFileSync(backlog, readFileSync(backlog, 'utf8').replace('- branch: <name>', '- branch: bad..name')),
  },
];

for (const { name, arrange } of promoteRefusals) {
  test(`--promote refuses and changes nothing on ${name}`, (t) => {
    const { home, main } = checkout(t);
    const backlog = backlogged(home, main, 'fix-login');
    arrange(home, main, backlog);
    const backlogBefore = readFileSync(backlog, 'utf8');
    const registryBefore = registryText(home);
    const branchesBefore = branches(home, main);
    const worktreesBefore = git(home, main, 'worktree', 'list', '--porcelain');

    const result = taskNew(home, main, '--promote', 'fix-login');
    assert.equal(result.status, 1, result.stderr);
    assert.notEqual(result.stderr.trim(), '');
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(backlog, 'utf8'), backlogBefore);
    assert.equal(registryText(home), registryBefore);
    assert.equal(branches(home, main), branchesBefore);
    assert.equal(git(home, main, 'worktree', 'list', '--porcelain'), worktreesBefore);
    assert.equal(existsSync(path.join(main, '.claude/worktrees/fix-login/.claude/ledger.md')), false);
  });
}

test('--promote keeps the created time of the backlog entry', (t) => {
  const { home, main } = checkout(t);
  backlogged(home, main, 'fix-login');
  const created = '2020-01-01T00:00:00.000Z';
  writeFileSync(registryFile(home), JSON.stringify(registry(home).map((entry) => ({ ...entry, created }))));

  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    registry(home).map(({ status, created }) => ({ status, created })),
    [{ status: 'active', created }],
  );
});

test('--promote of a backlog child keeps its parent bullet, and registers the parent on the active entry', (t) => {
  const { home, main } = checkout(t);
  const backlog = backlogged(home, main, 'fix-login');
  writeFileSync(backlog, readFileSync(backlog, 'utf8').replace('- base: <branch/commit>\n', '- base: <branch/commit>\n- parent: epic\n'));

  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 0, result.stderr);

  assert.match(readFileSync(path.join(main, '.claude/worktrees/fix-login/.claude/ledger.md'), 'utf8'), /^- base: main @ \w+\n- parent: epic\n/m);
  assert.deepEqual(
    registry(home).map(({ status, parent }) => ({ status, parent })),
    [{ status: 'active', parent: 'epic' }],
  );
});

test('--promote of a backlog parent keeps its Children section', (t) => {
  const { home, main } = checkout(t);
  const backlog = backlogged(home, main, 'epic');
  const children = '## Children\n- fix-login\n- old (retired 2026-10-01)\n\n';
  writeFileSync(backlog, readFileSync(backlog, 'utf8').replace('## Plan', `${children}## Plan`));

  const result = taskNew(home, main, '--promote', 'epic');
  assert.equal(result.status, 0, result.stderr);

  assert.ok(readFileSync(path.join(main, '.claude/worktrees/epic/.claude/ledger.md'), 'utf8').includes(`\n\n${children}## Plan`));
});

test('--promote from a linked worktree resolves the stored base in the main checkout', (t) => {
  const { home, main, second } = checkout(t);
  backlogged(home, main, 'fix-login', '--base', 'HEAD');
  const caller = linkedWorktree(home, main, 'other-task');
  assert.notEqual(git(home, caller, 'rev-parse', 'HEAD'), second);

  const result = taskNew(home, caller, '--promote', 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(home, path.join(main, '.claude/worktrees/fix-login'), 'rev-parse', 'HEAD'), second);
});

test('a backlog write, then --promote, both from a linked worktree with no ledger, leave one active task under the main checkout', (t) => {
  const { home, main, first } = checkout(t);
  git(home, main, 'update-ref', 'refs/remotes/origin/main', first);
  git(home, main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const caller = linkedWorktree(home, main, 'other-task');

  assert.equal(taskNew(home, caller, 'fix-login', '--goal', 'Users can log in again.').status, 0);
  const result = taskNew(home, caller, '--promote', 'fix-login');
  assert.equal(result.status, 0, result.stderr);

  const worktree = path.join(main, '.claude/worktrees/fix-login');
  const ledger = path.join(worktree, '.claude/ledger.md');
  assert.match(result.stdout, new RegExp(`^worktree ${worktree}$`, 'm'));
  assert.doesNotMatch(result.stdout, /start:/);
  assert.equal(git(home, worktree, 'rev-parse', 'HEAD'), first);
  assert.equal(existsSync(path.join(caller, '.claude/ledger.md')), false);
  assert.equal(existsSync(backlogFile(home, 'fix-login')), false);
  assert.deepEqual(
    registry(home).map(({ slug, path, status }) => ({ slug, path, status })),
    [{ slug: 'fix-login', path: ledger, status: 'active' }],
  );
});

const promoteFailures: { name: string; args: string[] }[] = [
  { name: '--promote without a slug', args: ['--promote'] },
  { name: '--promote with --goal', args: ['--promote', 'fix-login', '--goal', 'x'] },
  { name: '--promote with --branch', args: ['--promote', 'fix-login', '--branch', 'x'] },
  { name: '--promote with --base', args: ['--promote', 'fix-login', '--base', 'main'] },
  { name: '--promote with --stack', args: ['--promote', 'fix-login', '--stack'] },
  { name: '--promote with --here', args: ['--promote', 'fix-login', '--here'] },
];

for (const { name, args } of promoteFailures) {
  test(`fails and changes nothing on ${name}`, (t) => {
    const { home, main } = checkout(t);
    const backlog = backlogged(home, main, 'fix-login');
    const backlogBefore = readFileSync(backlog, 'utf8');

    const result = taskNew(home, main, ...args);
    assert.equal(result.status, 1, result.stderr);
    assert.notEqual(result.stderr.trim(), '');
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(backlog, 'utf8'), backlogBefore);
    assert.equal(branches(home, main), 'refs/heads/main');
    assert.equal(existsSync(path.join(main, '.claude/worktrees/fix-login')), false);
  });
}

const EVIDENCE = '.claude/evidence/';
const excludeFile = (main: string) => path.join(main, '.git/info/exclude');
const evidenceLines = (main: string) => readFileSync(excludeFile(main), 'utf8').split('\n').filter((line) => line === EVIDENCE).length;

function assertEvidenceIgnored(home: string, worktree: string) {
  mkdirSync(path.join(worktree, EVIDENCE), { recursive: true });
  writeFileSync(path.join(worktree, EVIDENCE, 'red.log'), 'FAIL\n');
  assert.doesNotMatch(git(home, worktree, 'status', '--porcelain', '--untracked-files=all'), /evidence/);
}

test('--promote keeps .claude/evidence/ out of git through info/exclude, and a second task adds no second line', (t) => {
  const { home, main } = checkout(t);
  backlogged(home, main, 'fix-login');
  backlogged(home, main, 'new-api');

  const first = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(evidenceLines(main), 1);
  assertEvidenceIgnored(home, path.join(main, '.claude/worktrees/fix-login'));

  const second = taskNew(home, main, '--promote', 'new-api');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(evidenceLines(main), 1);
});

test('--stack keeps .claude/evidence/ out of git through info/exclude', (t) => {
  const { home, main } = checkout(t);
  const result = taskNew(home, main, 'fix-login', '--stack');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(evidenceLines(main), 1);
  assertEvidenceIgnored(home, path.join(main, '.claude/worktrees/fix-login'));
});

test('--here keeps .claude/evidence/ out of git through info/exclude', (t) => {
  const { home, main } = checkout(t);
  const worktree = ownerWorktree(home, main, 'chrfalch/fix-login');
  const result = taskNew(home, worktree, '--here');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(evidenceLines(main), 1);
  assertEvidenceIgnored(home, worktree);
});

test('--promote creates info/exclude when the repository has none', (t) => {
  const { home, main } = checkout(t);
  rmSync(path.join(main, '.git/info'), { recursive: true, force: true });
  backlogged(home, main, 'fix-login');
  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(excludeFile(main), 'utf8'), `${EVIDENCE}\n`);
});

test('--promote puts the exclude line on its own line after an exclude file with no final newline', (t) => {
  const { home, main } = checkout(t);
  writeFileSync(excludeFile(main), '*.log');
  backlogged(home, main, 'fix-login');
  const result = taskNew(home, main, '--promote', 'fix-login');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(excludeFile(main), 'utf8'), `*.log\n${EVIDENCE}\n`);
});

test('a backlog task leaves info/exclude alone: it has no worktree yet', (t) => {
  const { home, main } = checkout(t);
  const before = readFileSync(excludeFile(main), 'utf8');
  backlogged(home, main, 'fix-login');
  assert.equal(readFileSync(excludeFile(main), 'utf8'), before);
});

function secondCheckout(home: string, folder = 'lib') {
  const lib = path.join(home, folder);
  mkdirSync(lib);
  git(home, lib, 'init', '--quiet', '-b', 'main');
  git(home, lib, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  return lib;
}

test('--repo makes the backlog task in that repository, run from another one', (t) => {
  const { home, main } = checkout(t);
  const lib = secondCheckout(home);

  const result = taskNew(home, main, 'parser', '--repo', lib, '--goal', 'Parse it.', '--branch', 'me/parser', '--base', 'main');
  assert.equal(result.status, 0, result.stderr);

  const backlog = backlogFile(home, 'parser', 'lib');
  assert.equal(readFileSync(backlog, 'utf8'), expectedBacklog('parser', 'Parse it.', lib, 'me/parser', 'main'));
  assert.equal(result.stdout, [`ledger:  ${backlog}`, 'status:  backlog', 'start:   /ledger:go parser', ''].join('\n'));
  assert.deepEqual(
    registry(home).map(({ repo, slug, main }) => ({ repo, slug, main })),
    [{ repo: 'lib', slug: 'parser', main: lib }],
  );
  assert.equal(existsSync(backlogFile(home, 'parser')), false);
});

test('--repo takes a path relative to the current folder, and a linked worktree stands for its main checkout', (t) => {
  const { home, main } = checkout(t);
  const lib = secondCheckout(home);
  linkedWorktree(home, lib, 'other-task');

  const result = taskNew(home, main, 'parser', '--repo', '../lib/.claude/worktrees/other-task');
  assert.equal(result.status, 0, result.stderr);

  assert.equal(readFileSync(backlogFile(home, 'parser', 'lib'), 'utf8'), expectedBacklog('parser', null, lib));
});

test('--promote with --repo promotes a backlog task of that repository, run from another one', (t) => {
  const { home, main } = checkout(t);
  const lib = secondCheckout(home);
  assert.equal(taskNew(home, lib, 'parser').status, 0);
  const caller = linkedWorktree(home, main, 'epic');

  const result = taskNew(home, caller, '--repo', lib, '--promote', 'parser');
  assert.equal(result.status, 0, result.stderr);

  const worktree = path.join(lib, '.claude/worktrees/parser');
  const ledger = path.join(worktree, '.claude/ledger.md');
  assert.match(result.stdout, new RegExp(`^worktree ${worktree}\nbranch   parser\nbase     main @ \\w+\nledger   ${ledger}\n$`));
  assert.equal(git(home, worktree, 'branch', '--show-current'), 'parser');
  assert.equal(existsSync(backlogFile(home, 'parser', 'lib')), false);
  assert.equal(branches(home, main), 'refs/heads/epic\nrefs/heads/main');
  assert.equal(existsSync(path.join(main, '.claude/worktrees/parser')), false);
  assert.deepEqual(
    registry(home).map(({ repo, slug, path, status }) => ({ repo, slug, path, status })),
    [{ repo: 'lib', slug: 'parser', path: ledger, status: 'active' }],
  );
});

const BUILDS_HERE = '--here and --stack build on this worktree, so they take no --repo\n';

const repoFailures: { name: string; args: (lib: string) => string[]; stderr?: string }[] = [
  { name: '--repo with --here', args: (lib) => ['--here', 'parser', '--repo', lib], stderr: BUILDS_HERE },
  { name: '--repo with --stack', args: (lib) => ['parser', '--stack', '--repo', lib], stderr: BUILDS_HERE },
  { name: '--repo without a value', args: () => ['parser', '--repo'] },
  { name: '--repo that names no git repository', args: (lib) => ['parser', '--repo', path.dirname(lib)] },
  { name: '--repo that names a missing folder', args: (lib) => ['parser', '--repo', path.join(lib, 'nowhere')] },
];

for (const { name, args, stderr } of repoFailures) {
  test(`fails and creates nothing on ${name}`, (t) => {
    const { home, main } = checkout(t);
    const lib = secondCheckout(home);
    const caller = linkedWorktree(home, main, 'epic');

    const result = taskNew(home, caller, ...args(lib));
    assert.equal(result.status, 1, result.stderr);
    if (stderr === undefined) assert.notEqual(result.stderr.trim(), '');
    else assert.equal(result.stderr, stderr);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(path.join(home, '.claude/ledger-backlog')), false);
    assert.equal(existsSync(path.join(caller, '.claude/ledger.md')), false);
    assert.equal(branches(home, lib), 'refs/heads/main');
  });
}

function llp(root: string, ...names: string[]) {
  mkdirSync(path.join(root, 'llp'), { recursive: true });
  for (const name of names) writeFileSync(path.join(root, 'llp', name), '# Design\n');
}

test('LLP refs are written in input order with LLP prefixes and survive promotion', (t) => {
  const { home, main } = checkout(t);
  llp(main, '0042-sync.rfc.md', '0042.001-rollout.plan.md');
  const file = backlogged(home, main, 'sync', '--refs', '0042.001, 0042');
  const bullet = '- design refs: LLP 0042.001, LLP 0042\n';
  assert.ok(readFileSync(file, 'utf8').includes(bullet));
  assert.equal(taskNew(home, main, '--promote', 'sync').status, 0);
  const ledger = readFileSync(path.join(main, '.claude/worktrees/sync/.claude/ledger.md'), 'utf8');
  assert.ok(ledger.includes(bullet));
  assert.doesNotMatch(ledger, /<LLP numbers/);
});

test('LLP repo without --refs writes design refs: none', (t) => {
  const { home, main } = checkout(t);
  llp(main);
  const file = backlogged(home, main, 'sync');
  assert.match(readFileSync(file, 'utf8'), /- design refs: none\n/);
});

for (const [name, files, refs] of [
  ['unknown', ['0042.001-rollout.plan.md'], '0042'],
  ['ambiguous', ['0042-sync.rfc.md', '0042-other.plan.md'], '0042'],
] as const) {
  test(`${name} LLP number fails without writing a ledger`, (t) => {
    const { home, main } = checkout(t);
    llp(main, ...files);
    const result = taskNew(home, main, 'sync', '--refs', refs);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /0042/);
    assert.equal(existsSync(backlogFile(home, 'sync')), false);
    assert.equal(existsSync(path.join(main, '.claude/worktrees/sync')), false);
    assert.equal(registryText(home), null);
  });
}

test('repo without llp omits the design refs line', (t) => {
  const { home, main } = checkout(t);
  const file = backlogged(home, main, 'sync');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /design refs/);
});

test('--refs without llp fails with the repo path and writes nothing', (t) => {
  const { home, main } = checkout(t);
  const result = taskNew(home, main, 'sync', '--refs', '0042');
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(`no llp/ folder in ${main}`), result.stderr);
  assert.equal(existsSync(backlogFile(home, 'sync')), false);
});

test('--refs with --promote is refused and leaves the backlog intact', (t) => {
  const { home, main } = checkout(t);
  const file = backlogged(home, main, 'sync');
  const before = readFileSync(file, 'utf8');
  const result = taskNew(home, main, '--promote', 'sync', '--refs', '0042');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--promote takes only a slug/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(path.join(main, '.claude/worktrees/sync')), false);
});

test('--here --refs uses llp in the current worktree', (t) => {
  const { home, main } = checkout(t);
  const worktree = linkedWorktree(home, main, 'sync');
  llp(worktree, '0042-sync.rfc.md');
  const result = taskNew(home, worktree, '--here', '--refs', '0042');
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(worktree, '.claude/ledger.md'), 'utf8'), /- design refs: LLP 0042\n/);
});

for (const inCaller of [true, false]) {
  test(`--stack follows the current worktree llp folder (present: ${inCaller})`, (t) => {
    const { home, main } = checkout(t);
    const caller = linkedWorktree(home, main, 'caller');
    llp(inCaller ? caller : main, '0042-sync.rfc.md');
    const nested = path.join(caller, 'nested');
    mkdirSync(nested);
    const result = taskNew(home, nested, 'follow-up', '--stack');
    assert.equal(result.status, 0, result.stderr);
    const ledger = readFileSync(path.join(main, '.claude/worktrees/follow-up/.claude/ledger.md'), 'utf8');
    if (inCaller) assert.match(ledger, /- design refs: none\n/);
    else assert.doesNotMatch(ledger, /design refs/);
  });
}

test('--stack validates refs against the current worktree llp folder', (t) => {
  const { home, main } = checkout(t);
  const caller = linkedWorktree(home, main, 'caller');
  llp(caller, '0042-sync.rfc.md');
  const result = taskNew(home, caller, 'follow-up', '--stack', '--refs', '0042');
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(main, '.claude/worktrees/follow-up/.claude/ledger.md'), 'utf8'), /- design refs: LLP 0042\n/);
});

for (const refs of ['00420', '42', '0042;echo injected', '$(echo 0042)']) {
  test(`invalid refs item ${JSON.stringify(refs)} fails`, (t) => {
    const { home, main } = checkout(t);
    llp(main, '0042-sync.rfc.md', '00420-long.rfc.md');
    const result = taskNew(home, main, 'sync', '--refs', refs);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(backlogFile(home, 'sync')), false);
    assert.equal(registryText(home), null);
  });
}

test('a 4-digit ref matches its own file, not a longer number', (t) => {
  const { home, main } = checkout(t);
  llp(main, '0042-sync.rfc.md', '00420-long.rfc.md');
  const file = backlogged(home, main, 'sync', '--refs', '0042');
  assert.match(readFileSync(file, 'utf8'), /- design refs: LLP 0042\n/);
});

test('a 4-digit ref with only a longer number in llp fails', (t) => {
  const { home, main } = checkout(t);
  llp(main, '00420-long.rfc.md');
  const result = taskNew(home, main, 'sync', '--refs', '0042');
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(backlogFile(home, 'sync')), false);
});

for (const refs of ['0042,,0043', '']) {
  test(`empty refs item in ${JSON.stringify(refs)} fails with an empty-item message`, (t) => {
    const { home, main } = checkout(t);
    llp(main, '0042-sync.rfc.md', '0043-other.rfc.md');
    const result = taskNew(home, main, 'sync', '--refs', refs);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /item.*empty|empty.*item/i);
    assert.equal(existsSync(backlogFile(home, 'sync')), false);
    assert.equal(registryText(home), null);
  });
}

test('duplicate refs are written once', (t) => {
  const { home, main } = checkout(t);
  llp(main, '0042-sync.rfc.md');
  const file = backlogged(home, main, 'sync', '--refs', '0042,0042');
  assert.match(readFileSync(file, 'utf8'), /- design refs: LLP 0042\n/);
});
