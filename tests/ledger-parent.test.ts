import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { freshHome, REPO, run } from './helpers.js';

const PARENT = path.join(REPO, 'bin/cc-ledger-parent');
const LEDGERS = [path.join(REPO, 'bin/cc-ledgers')] as const;

type Entry = { slug: string; path: string; status: string; parent?: string };
type Shown = { parent: string; goal: string; children: { slug: string; status: string; next: string }[] };

function git(home: string, directory: string, ...args: string[]): void {
  const result = run(home, ['git', '-C', directory, '-c', 'user.name=test', '-c', 'user.email=test@example.com'], ...args);
  assert.equal(result.status, 0, result.stderr);
}

function ledgerText(slug: string, worktree: string, next = `Next step of ${slug}.`): string {
  return [
    `# Task ledger — ${slug}`,
    '',
    '## Goal',
    `Goal of ${slug}.`,
    'More goal.',
    '',
    '## Location',
    `- worktree: ${worktree}`,
    `- branch: me/${slug}`,
    '- base: main @ abc1234',
    '',
    '## Plan (approved 2026-10-20)',
    '| # | step | status | owner | note |',
    '',
    '## Next step',
    next,
    '',
  ].join('\n');
}

// realpath, because git reports a tmpdir under /var as /private/var.
function repository(t: TestContext, ...slugs: string[]) {
  const home = realpathSync(freshHome(t));
  const main = path.join(home, 'repos/app');
  mkdirSync(main, { recursive: true });
  git(home, main, 'init', '--quiet', '-b', 'main');
  git(home, main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  const ledgers: Record<string, string> = {};
  for (const slug of slugs) ledgers[slug] = addTask(home, main, slug);
  return { home, main, ledgers };
}

function addTask(home: string, main: string, slug: string, folder = slug): string {
  const worktree = path.join(main, '.claude/worktrees', folder);
  git(home, main, 'worktree', 'add', '--quiet', '-b', `me/${folder}`, worktree);
  const ledger = path.join(worktree, '.claude/ledger.md');
  mkdirSync(path.dirname(ledger));
  writeFileSync(ledger, ledgerText(slug, worktree));
  const upsert = run(home, LEDGERS, 'upsert', ledger);
  assert.equal(upsert.status, 0, upsert.stderr);
  return ledger;
}

function parent(home: string, cwd: string, ...args: string[]) {
  return run(home, ['bash', '-c', 'cd "$1" && shift && exec "$@"', '_', cwd, PARENT], ...args);
}

function ok(home: string, cwd: string, ...args: string[]) {
  const result = parent(home, cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const read = (file: string) => readFileSync(file, 'utf8');
const registry = (home: string) => JSON.parse(read(path.join(home, '.claude/ledgers.json'))) as Entry[];
const registered = (home: string, slug: string) => registry(home).find((entry) => entry.slug === slug);

test('add appends the parent bullet to the child Location and a Children section after the parent Location', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const childBefore = read(ledgers['child-a'] ?? '');
  const parentBefore = read(ledgers.epic ?? '');

  const result = ok(home, main, 'add', 'epic', 'child-a');

  assert.equal(result.stderr, '');
  assert.equal(
    read(ledgers['child-a'] ?? ''),
    childBefore.replace('- base: main @ abc1234\n', '- base: main @ abc1234\n- parent: epic\n'),
  );
  assert.equal(
    read(ledgers.epic ?? ''),
    parentBefore.replace('- base: main @ abc1234\n\n', '- base: main @ abc1234\n\n## Children\n- child-a\n\n'),
  );
});

test('add of a second child extends the Children section in order', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a', 'child-b');
  const parentBefore = read(ledgers.epic ?? '');

  ok(home, main, 'add', 'epic', 'child-a');
  ok(home, main, 'add', 'epic', 'child-b');

  assert.equal(
    read(ledgers.epic ?? ''),
    parentBefore.replace('- base: main @ abc1234\n\n', '- base: main @ abc1234\n\n## Children\n- child-a\n- child-b\n\n'),
  );
});

test('add records the parent on the child registry entry, and list --json shows it', (t) => {
  const { home, main } = repository(t, 'epic', 'child-a');

  ok(home, main, 'add', 'epic', 'child-a');

  assert.equal(registered(home, 'child-a')?.parent, 'epic');
  assert.equal(Object.hasOwn(registered(home, 'epic') ?? {}, 'parent'), false);
  const listed = JSON.parse(run(home, LEDGERS, 'list', '--json').stdout) as Entry[];
  assert.equal(listed.find((entry) => entry.slug === 'child-a')?.parent, 'epic');
});

for (const where of ['the main checkout', 'the child worktree', 'an unrelated worktree'] as const) {
  test(`add works from ${where}`, (t) => {
    const { home, main, ledgers } = repository(t, 'epic', 'child-a', 'other');
    const cwd = {
      'the main checkout': main,
      'the child worktree': path.dirname(path.dirname(ledgers['child-a'] ?? '')),
      'an unrelated worktree': path.join(path.dirname(path.dirname(ledgers.other ?? '')), 'nested'),
    }[where];
    mkdirSync(cwd, { recursive: true });

    ok(home, cwd, 'add', 'epic', 'child-a');

    assert.match(read(ledgers['child-a'] ?? ''), /^- parent: epic$/m);
  });
}

test('add of the same pair again succeeds and changes nothing', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  ok(home, main, 'add', 'epic', 'child-a');
  const child = read(ledgers['child-a'] ?? '');
  const epic = read(ledgers.epic ?? '');

  const again = ok(home, main, 'add', 'epic', 'child-a');

  assert.equal(again.stderr, '');
  assert.equal(read(ledgers['child-a'] ?? ''), child);
  assert.equal(read(ledgers.epic ?? ''), epic);
});

const refusals: [string, string[], RegExp][] = [
  ['an unknown parent', ['add', 'nope', 'child-a'], /nope/],
  ['an unknown child', ['add', 'epic', 'nope'], /nope/],
  ['a child from another repository', ['add', 'epic', 'elsewhere'], /elsewhere/],
  ['a task as its own parent', ['add', 'epic', 'epic'], /epic/],
  ['a child that has a different parent', ['add', 'other', 'child-a'], /child-a.*epic/],
  ['a cycle: the child is the parent of its new parent', ['add', 'child-a', 'epic'], /epic.*child-a.*cycle/],
  ['remove of a child that is not attached', ['remove', 'epic', 'child-b'], /child-b.*epic/],
  ['remove from the wrong parent', ['remove', 'other', 'child-a'], /child-a.*other/],
];

for (const [name, args, message] of refusals) {
  test(`${args[0]} refuses ${name} with one line and changes nothing`, (t) => {
    const { home, main, ledgers } = repository(t, 'epic', 'child-a', 'child-b', 'other');
    ok(home, main, 'add', 'epic', 'child-a');
    const elsewhere = path.join(home, 'repos/elsewhere');
    mkdirSync(elsewhere);
    git(home, elsewhere, 'init', '--quiet', '-b', 'main');
    git(home, elsewhere, 'commit', '--quiet', '--allow-empty', '-m', 'first');
    addTask(home, elsewhere, 'elsewhere');
    const before = Object.values(ledgers).map(read);
    const registryBefore = read(path.join(home, '.claude/ledgers.json'));

    const result = parent(home, main, ...args);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^[^\n]+\n$/);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, '');
    assert.deepEqual(Object.values(ledgers).map(read), before);
    assert.equal(read(path.join(home, '.claude/ledgers.json')), registryBefore);
  });
}

test('add makes a child task the parent of another, and a task with children the child of another', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a', 'grandchild', 'program');

  ok(home, main, 'add', 'epic', 'child-a');
  ok(home, main, 'add', 'child-a', 'grandchild');
  ok(home, main, 'add', 'program', 'epic');

  assert.match(read(ledgers.grandchild ?? ''), /^- parent: child-a$/m);
  assert.match(read(ledgers['child-a'] ?? ''), /^- parent: epic$/m);
  assert.match(read(ledgers['child-a'] ?? ''), /^## Children\n- grandchild$/m);
  assert.match(read(ledgers.epic ?? ''), /^- parent: program$/m);
  assert.match(read(ledgers.epic ?? ''), /^## Children\n- child-a$/m);
  assert.equal(registered(home, 'grandchild')?.parent, 'child-a');
  assert.equal(registered(home, 'epic')?.parent, 'program');
});

test('add refuses a cycle through a grandparent with one line and changes nothing', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a', 'grandchild');
  ok(home, main, 'add', 'epic', 'child-a');
  ok(home, main, 'add', 'child-a', 'grandchild');
  const before = Object.values(ledgers).map(read);

  const result = parent(home, main, 'add', 'grandchild', 'epic');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]*epic[^\n]*grandchild[^\n]*cycle[^\n]*\n$/);
  assert.deepEqual(Object.values(ledgers).map(read), before);
});

test('add stops at a cycle already in the ledgers instead of walking it forever', (t) => {
  const { home, main, ledgers } = repository(t, 'x', 'y', 'child-a');
  for (const [slug, other] of [['x', 'y'], ['y', 'x']] as const) {
    const file = ledgers[slug] ?? '';
    writeFileSync(file, read(file).replace('- base: main @ abc1234\n', `- base: main @ abc1234\n- parent: ${other}\n`));
  }

  ok(home, main, 'add', 'x', 'child-a');

  assert.match(read(ledgers['child-a'] ?? ''), /^- parent: x$/m);
});

test('add refuses a slug that two ledgers in the repository share, naming both', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const twin = addTask(home, main, 'epic', 'epic-again');
  const epic = read(ledgers.epic ?? '');

  const result = parent(home, main, 'add', 'epic', 'child-a');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]+\n$/);
  assert.ok(result.stderr.includes(ledgers.epic ?? '') && result.stderr.includes(twin), result.stderr);
  assert.equal(read(ledgers.epic ?? ''), epic);
});

test('add refuses a ledger without a Location section', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const child = ledgers['child-a'] ?? '';
  writeFileSync(child, '# Task ledger — child-a\n\n## Goal\nA goal.\n');

  const result = parent(home, main, 'add', 'epic', 'child-a');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]*Location[^\n]*\n$/);
  assert.equal(read(child), '# Task ledger — child-a\n\n## Goal\nA goal.\n');
});

test('remove restores both ledgers and clears the parent in the registry', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const child = read(ledgers['child-a'] ?? '');
  const epic = read(ledgers.epic ?? '');
  ok(home, main, 'add', 'epic', 'child-a');

  const result = ok(home, main, 'remove', 'epic', 'child-a');

  assert.equal(result.stderr, '');
  assert.equal(read(ledgers['child-a'] ?? ''), child);
  assert.equal(read(ledgers.epic ?? ''), epic);
  assert.equal(Object.hasOwn(registered(home, 'child-a') ?? {}, 'parent'), false);
});

test('remove of one child keeps the Children section with the others', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a', 'child-b');
  const epic = read(ledgers.epic ?? '');
  ok(home, main, 'add', 'epic', 'child-a');
  ok(home, main, 'add', 'epic', 'child-b');

  ok(home, main, 'remove', 'epic', 'child-a');

  assert.equal(
    read(ledgers.epic ?? ''),
    epic.replace('- base: main @ abc1234\n\n', '- base: main @ abc1234\n\n## Children\n- child-b\n\n'),
  );
});

test('the ledger edit stands when the registry cannot be written', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  rmSync(path.join(home, '.claude/ledgers.json'));
  mkdirSync(path.join(home, '.claude/ledgers.json'));

  const result = ok(home, main, 'add', 'epic', 'child-a');

  assert.match(result.stderr, /warning: registry not updated/);
  assert.match(read(ledgers['child-a'] ?? ''), /^- parent: epic$/m);
  assert.match(read(ledgers.epic ?? ''), /^## Children\n- child-a$/m);
});

function family(t: TestContext) {
  const repo = repository(t, 'epic', 'busy', 'waiting', 'lost');
  const { home, main, ledgers } = repo;
  for (const child of ['busy', 'waiting', 'lost']) ok(home, main, 'add', 'epic', child);
  const waiting = ledgers.waiting ?? '';
  writeFileSync(waiting, read(waiting).replace('## Next step\n', '## Next step\nParked: 2026-10-01 — waiting on the API review\n'));
  // A retired child has no ledger left: only the parent's Children line remembers it.
  const epic = ledgers.epic ?? '';
  writeFileSync(epic, read(epic).replace('- lost\n', '- gone (retired 2026-10-02)\n'));
  rmSync(ledgers.lost ?? '');
  return repo;
}

test('show prints the parent goal, then each child with its status and next step', (t) => {
  const { home, main } = family(t);

  const result = ok(home, main, 'show', 'epic');

  assert.equal(
    result.stdout,
    [
      'epic\tGoal of epic.',
      'busy\tactive\tNext step of busy.',
      'waiting\tparked\tNext step of waiting.',
      'gone\tretired\t',
      '',
    ].join('\n'),
  );
});

test('show --json prints the same as an object', (t) => {
  const { home, main } = family(t);

  const shown = JSON.parse(ok(home, main, 'show', 'epic', '--json').stdout) as Shown;

  assert.deepEqual(shown, {
    parent: 'epic',
    goal: 'Goal of epic.',
    children: [
      { slug: 'busy', status: 'active', next: 'Next step of busy.' },
      { slug: 'waiting', status: 'parked', next: 'Next step of waiting.' },
      { slug: 'gone', status: 'retired', next: '' },
    ],
  });
});

test('show lists the active children first, then the others in the order of the Children section', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'waiting', 'busy');
  for (const child of ['waiting', 'busy']) ok(home, main, 'add', 'epic', child);
  const waiting = ledgers.waiting ?? '';
  writeFileSync(waiting, read(waiting).replace('## Next step\n', '## Next step\nParked: 2026-10-01 — waiting on the API review\n'));
  const epic = ledgers.epic ?? '';
  writeFileSync(epic, read(epic).replace('- busy\n', '- gone (retired 2026-10-02)\n- busy\n'));

  assert.deepEqual(
    ok(home, main, 'show', 'epic').stdout.split('\n').map((line) => line.split('\t')[0]),
    ['epic', 'busy', 'waiting', 'gone', ''],
  );
});

test('show of a task without children prints only the parent line', (t) => {
  const { home, main } = repository(t, 'epic');

  assert.equal(ok(home, main, 'show', 'epic').stdout, 'epic\tGoal of epic.\n');
});

test('show names a listed child whose ledger is gone without a retire as missing', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  ok(home, main, 'add', 'epic', 'child-a');
  rmSync(ledgers['child-a'] ?? '');

  assert.equal(ok(home, main, 'show', 'epic').stdout, 'epic\tGoal of epic.\nchild-a\tmissing\t\n');
});

test('show of an unknown slug fails with one line', (t) => {
  const { home, main } = repository(t, 'epic');

  const result = parent(home, main, 'show', 'nope');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]*nope[^\n]*\n$/);
});

test('a slug with a line break is refused in one line that shows it escaped', (t) => {
  const { home, main } = repository(t, 'epic');

  const result = parent(home, main, 'show', 'bad\nslug');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]*"bad\\nslug"[^\n]*\n$/);
});

for (const args of [[], ['add', 'epic'], ['add', 'a', 'b', 'c'], ['show'], ['show', 'epic', '--yaml'], ['move', 'a', 'b']]) {
  test(`${args.join(' ') || 'no arguments'} is a usage error`, (t) => {
    const { home, main } = repository(t, 'epic');

    const result = parent(home, main, ...args);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^usage: cc-ledger-parent /);
  });
}

const crlf = (text: string) => text.replace(/\n/g, '\r\n');

function crlfRepository(t: TestContext, ...slugs: string[]) {
  const repo = repository(t, ...slugs);
  for (const ledger of Object.values(repo.ledgers)) writeFileSync(ledger, crlf(read(ledger)));
  return repo;
}

test('add, a repeated add and remove keep CRLF line endings', (t) => {
  const { home, main, ledgers } = crlfRepository(t, 'epic', 'child-a');
  const child = ledgers['child-a'] ?? '';
  const epic = ledgers.epic ?? '';
  const childBefore = read(child);
  const epicBefore = read(epic);
  const attached = {
    child: childBefore.replace('- base: main @ abc1234\r\n', '- base: main @ abc1234\r\n- parent: epic\r\n'),
    epic: epicBefore.replace('- base: main @ abc1234\r\n\r\n', '- base: main @ abc1234\r\n\r\n## Children\r\n- child-a\r\n\r\n'),
  };

  ok(home, main, 'add', 'epic', 'child-a');
  assert.deepEqual({ child: read(child), epic: read(epic) }, attached);
  ok(home, main, 'add', 'epic', 'child-a');
  assert.deepEqual({ child: read(child), epic: read(epic) }, attached);

  ok(home, main, 'remove', 'epic', 'child-a');
  assert.deepEqual({ child: read(child), epic: read(epic) }, { child: childBefore, epic: epicBefore });
});

test('add refuses a different parent named in a CRLF ledger', (t) => {
  const { home, main, ledgers } = crlfRepository(t, 'epic', 'other', 'child-a');
  const child = ledgers['child-a'] ?? '';
  writeFileSync(child, read(child).replace('- base: main @ abc1234\r\n', '- base: main @ abc1234\r\n- parent: epic\r\n'));

  const result = parent(home, main, 'add', 'other', 'child-a');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]*child-a[^\n]*epic[^\n]*\n$/);
});

test('show reads CRLF ledgers without carriage returns in its output', (t) => {
  const { home, main } = crlfRepository(t, 'epic', 'busy');
  ok(home, main, 'add', 'epic', 'busy');

  assert.equal(ok(home, main, 'show', 'epic').stdout, 'epic\tGoal of epic.\nbusy\tactive\tNext step of busy.\n');
});

// A folder without write permission refuses the new file a temporary-then-rename write needs.
function readOnly<T>(folder: string, action: () => T): T {
  chmodSync(folder, 0o555);
  try {
    return action();
  } finally {
    chmodSync(folder, 0o755);
  }
}

test('add that fails at the parent write leaves the child attached, and a rerun finishes', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const epic = ledgers.epic ?? '';
  const epicBefore = read(epic);

  const failed = readOnly(path.dirname(epic), () => parent(home, main, 'add', 'epic', 'child-a'));

  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^[^\n]+\n$/);
  assert.equal(read(epic), epicBefore);
  assert.match(read(ledgers['child-a'] ?? ''), /^- parent: epic$/m);

  ok(home, main, 'add', 'epic', 'child-a');

  assert.match(read(epic), /^## Children\n- child-a$/m);
  assert.deepEqual(readdirSync(path.dirname(epic)), ['ledger.md']);
});

test('remove writes the parent first, so a failed child write can be finished by a rerun', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const child = ledgers['child-a'] ?? '';
  const epic = ledgers.epic ?? '';
  const childBefore = read(child);
  const epicBefore = read(epic);
  ok(home, main, 'add', 'epic', 'child-a');
  const childAttached = read(child);

  const failed = readOnly(path.dirname(child), () => parent(home, main, 'remove', 'epic', 'child-a'));

  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^[^\n]+\n$/);
  assert.equal(read(child), childAttached);
  assert.equal(read(epic), epicBefore);

  ok(home, main, 'remove', 'epic', 'child-a');

  assert.deepEqual({ child: read(child), epic: read(epic) }, { child: childBefore, epic: epicBefore });
  assert.deepEqual(readdirSync(path.dirname(child)), ['ledger.md']);
});

test('add refuses a new task that reuses the slug of a retired child', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'reused');
  const epic = ledgers.epic ?? '';
  writeFileSync(epic, read(epic).replace('- base: main @ abc1234\n\n', '- base: main @ abc1234\n\n## Children\n- reused (retired 2026-10-01)\n\n'));
  const before = Object.values(ledgers).map(read);

  const result = parent(home, main, 'add', 'epic', 'reused');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]*reused[^\n]*retired[^\n]*epic[^\n]*another slug[^\n]*\n$/);
  assert.deepEqual(Object.values(ledgers).map(read), before);
});

test('add matches the Location and Children headings exactly, trailing whitespace allowed', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const child = ledgers['child-a'] ?? '';
  const epic = ledgers.epic ?? '';
  writeFileSync(child, read(child).replace('## Location\n', '## Location notes\n- parent: other\n\n## Location \t\n'));
  writeFileSync(epic, read(epic).replace('## Location\n', '## Children (old)\n- stale\n\n## Location\n'));
  const childBefore = read(child);
  const epicBefore = read(epic);

  ok(home, main, 'add', 'epic', 'child-a');

  assert.equal(read(child), childBefore.replace('- base: main @ abc1234\n', '- base: main @ abc1234\n- parent: epic\n'));
  assert.equal(read(epic), epicBefore.replace('- base: main @ abc1234\n\n', '- base: main @ abc1234\n\n## Children\n- child-a\n\n'));
});

test('show ignores a section whose heading only starts with Children', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const epic = ledgers.epic ?? '';
  writeFileSync(epic, read(epic).replace('## Location\n', '## Children (old)\n- stale\n\n## Location\n'));

  assert.equal(ok(home, main, 'show', 'epic').stdout, 'epic\tGoal of epic.\n');
});

for (const args of [
  ['add', 'epic', 'child one'],
  ['add', 'epic one', 'child-a'],
  ['remove', 'epic', 'child one'],
  ['remove', 'epic one', 'child-a'],
  ['show', 'epic one'],
]) {
  test(`${args[0]} refuses the unsupported slug in ${JSON.stringify(args.slice(1))} with one line and changes nothing`, (t) => {
    const { home, main, ledgers } = repository(t, 'epic', 'child-a');
    ledgers['child one'] = addTask(home, main, 'child one', 'child-one');
    ledgers['epic one'] = addTask(home, main, 'epic one', 'epic-one');
    const before = Object.values(ledgers).map(read);

    const result = parent(home, main, ...args);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^[^\n]+\n$/);
    assert.ok(result.stderr.includes('^[A-Za-z0-9._-]+$'), result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(Object.values(ledgers).map(read), before);
  });
}

test('add reads a parent bullet with more than one word as no parent, as retire does', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const child = ledgers['child-a'] ?? '';
  writeFileSync(child, read(child).replace('- base: main @ abc1234\n', '- base: main @ abc1234\n- parent: some epic\n'));

  ok(home, main, 'add', 'epic', 'child-a');

  assert.match(read(child), /^- parent: some epic\n- parent: epic$/m);
});

// A backlog task has no worktree: its ledger is in ~/.claude/ledger-backlog/<main checkout folder>/, and names its main checkout.
function addBacklogTask(home: string, main: string, slug: string, owner = main): string {
  const ledger = path.join(home, '.claude/ledger-backlog', path.basename(main), `${slug}.md`);
  mkdirSync(path.dirname(ledger), { recursive: true });
  writeFileSync(ledger, ledgerText(slug, '<path>').replace('## Location\n', `## Location\n- main: ${owner}\n`));
  return ledger;
}

test('add attaches a backlog child to a worktree parent, and keeps the parent on its backlog registry entry', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const idea = addBacklogTask(home, main, 'idea');
  const ideaBefore = read(idea);
  const epicBefore = read(ledgers.epic ?? '');

  ok(home, main, 'add', 'epic', 'idea');

  assert.equal(read(idea), ideaBefore.replace('- base: main @ abc1234\n', '- base: main @ abc1234\n- parent: epic\n'));
  assert.equal(
    read(ledgers.epic ?? ''),
    epicBefore.replace('- base: main @ abc1234\n\n', '- base: main @ abc1234\n\n## Children\n- idea\n\n'),
  );
  assert.deepEqual(
    registry(home).filter((entry) => entry.slug === 'idea').map(({ path, status, parent }) => ({ path, status, parent })),
    [{ path: idea, status: 'backlog', parent: 'epic' }],
  );
});

test('add attaches a worktree child to a backlog parent', (t) => {
  const { home, main, ledgers } = repository(t, 'child-a');
  const epic = addBacklogTask(home, main, 'epic');
  const epicBefore = read(epic);

  ok(home, main, 'add', 'epic', 'child-a');

  assert.match(read(ledgers['child-a'] ?? ''), /^- parent: epic$/m);
  assert.equal(read(epic), epicBefore.replace('- base: main @ abc1234\n\n', '- base: main @ abc1234\n\n## Children\n- child-a\n\n'));
  assert.equal(registered(home, 'child-a')?.parent, 'epic');
});

test('remove detaches a backlog child from a backlog parent', (t) => {
  const { home, main } = repository(t);
  const epic = addBacklogTask(home, main, 'epic');
  const idea = addBacklogTask(home, main, 'idea');
  const before = [read(epic), read(idea)];
  ok(home, main, 'add', 'epic', 'idea');

  ok(home, main, 'remove', 'epic', 'idea');

  assert.deepEqual([read(epic), read(idea)], before);
});

test('show names a backlog child as backlog, with its next step, in text and JSON', (t) => {
  const { home, main } = repository(t, 'epic', 'busy');
  addBacklogTask(home, main, 'idea');
  ok(home, main, 'add', 'epic', 'busy');
  ok(home, main, 'add', 'epic', 'idea');

  assert.equal(ok(home, main, 'show', 'epic').stdout, 'epic\tGoal of epic.\nbusy\tactive\tNext step of busy.\nidea\tbacklog\tNext step of idea.\n');
  assert.deepEqual((JSON.parse(ok(home, main, 'show', 'epic', '--json').stdout) as Shown).children, [
    { slug: 'busy', status: 'active', next: 'Next step of busy.' },
    { slug: 'idea', status: 'backlog', next: 'Next step of idea.' },
  ]);
});

test('a backlog ledger of another repository with the same folder name is neither found nor changed', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const foreign = addBacklogTask(home, main, 'idea', path.join(home, 'elsewhere/app'));
  const before = read(foreign);

  const result = parent(home, main, 'add', 'epic', 'idea');

  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'no task ledger with the slug idea in this repository\n');
  assert.equal(read(foreign), before);
  const epic = ledgers.epic ?? '';
  writeFileSync(epic, read(epic).replace('## Plan', '## Children\n- idea\n\n## Plan'));
  assert.equal(ok(home, main, 'show', 'epic').stdout, 'epic\tGoal of epic.\nidea\tmissing\t\n');
});

test('add refuses a slug that a worktree ledger and a backlog ledger share, naming both', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const twin = addBacklogTask(home, main, 'epic');
  const files = [ledgers.epic ?? '', twin, ledgers['child-a'] ?? ''];
  const before = files.map(read);

  const result = parent(home, main, 'add', 'epic', 'child-a');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]+\n$/);
  assert.ok(result.stderr.includes(ledgers.epic ?? '') && result.stderr.includes(twin), result.stderr);
  assert.deepEqual(files.map(read), before);
});
