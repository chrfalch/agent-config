import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { freshHome, REPO, run } from './helpers.js';

const PARENT = path.join(REPO, 'bin/cc-ledger-parent');
const LEDGERS = [path.join(REPO, 'bin/cc-ledgers')] as const;

type Entry = { slug: string; path: string; status: string; parent?: string; parentMain?: string };
type Shown = { parent: string; goal: string; children: { slug: string; status: string; next: string; main?: string }[] };

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

test('show lists the active children first, then the others, each newest first by ledger time or retire date, children without either last', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'lost', 'waiting', 'busy-old', 'busy-new');
  ledgers.idea = addBacklogTask(home, main, 'idea');
  for (const child of ['lost', 'waiting', 'busy-old', 'idea', 'busy-new']) ok(home, main, 'add', 'epic', child);
  const waiting = ledgers.waiting ?? '';
  writeFileSync(waiting, read(waiting).replace('## Next step\n', '## Next step\nParked: 2026-10-01 — waiting on the API review\n'));
  const epic = ledgers.epic ?? '';
  writeFileSync(
    epic,
    read(epic).replace('- lost\n', '- ancient (retired 2026-09-28)\n- gone (retired 2026-10-02)\n- recent (retired 2026-10-05)\n- lost\n'),
  );
  rmSync(ledgers.lost ?? '');
  const days = { waiting: 1, 'busy-old': 2, idea: 3, 'busy-new': 4 };
  for (const [slug, day] of Object.entries(days)) utimesSync(ledgers[slug] ?? '', new Date(2026, 9, day), new Date(2026, 9, day));

  const order = ['busy-new', 'busy-old', 'recent', 'idea', 'gone', 'waiting', 'ancient', 'lost'];
  assert.deepEqual(
    ok(home, main, 'show', 'epic').stdout.split('\n').map((line) => line.split('\t')[0]),
    ['epic', ...order, ''],
  );
  const shown = JSON.parse(ok(home, main, 'show', 'epic', '--json').stdout) as Shown;
  assert.deepEqual(shown.children.map(({ slug }) => slug), order);
});

test('show orders a retired child by its retire date, not by a live ledger that reuses its slug', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'waiting', 'reused');
  ok(home, main, 'add', 'epic', 'waiting');
  const waiting = ledgers.waiting ?? '';
  writeFileSync(waiting, read(waiting).replace('## Next step\n', '## Next step\nParked: 2026-10-01 — waiting on the API review\n'));
  const epic = ledgers.epic ?? '';
  writeFileSync(epic, read(epic).replace('- waiting\n', '- reused (retired 2026-09-01)\n- waiting\n'));
  utimesSync(waiting, new Date(2026, 9, 1), new Date(2026, 9, 1));
  utimesSync(ledgers.reused ?? '', new Date(2026, 9, 10), new Date(2026, 9, 10));

  const shown = JSON.parse(ok(home, main, 'show', 'epic', '--json').stdout) as Shown;

  assert.deepEqual(shown.children.map(({ slug }) => slug), ['waiting', 'reused']);
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
  ['remove', 'nope', 'child one'],
  ['start', 'nope', 'child one'],
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

const today = () => {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
};

function setChildren(ledger: string, lines: string) {
  writeFileSync(ledger, read(ledger).replace('## Plan', `## Children\n${lines}\n## Plan`));
}

test('show keeps a child whose line is marked started, with its own status', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'busy');
  addBacklogTask(home, main, 'idea');
  setChildren(ledgers.epic ?? '', '- busy (started 2026-10-20)\n- idea (started 2026-10-21)\n');

  assert.deepEqual(
    (JSON.parse(ok(home, main, 'show', 'epic', '--json').stdout) as Shown).children.map(({ slug, status }) => ({ slug, status })),
    [
      { slug: 'busy', status: 'active' },
      { slug: 'idea', status: 'backlog' },
    ],
  );
});

test('start marks the child line in a worktree parent with today, and prints the ledger it changed', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a', 'child-b');
  ok(home, main, 'add', 'epic', 'child-a');
  ok(home, main, 'add', 'epic', 'child-b');
  const epic = ledgers.epic ?? '';
  const before = read(epic);

  const result = ok(home, main, 'start', 'epic', 'child-a');

  assert.equal(read(epic), before.replace('- child-a\n', `- child-a (started ${today()})\n`));
  assert.equal(result.stdout, `started child-a in ${epic}\n`);
  assert.equal(result.stderr, '');
});

test('start marks the child line in a backlog parent, run from the child worktree', (t) => {
  const { home, main, ledgers } = repository(t, 'child-a');
  const epic = addBacklogTask(home, main, 'epic');
  ok(home, main, 'add', 'epic', 'child-a');
  const before = read(epic);

  const result = ok(home, path.dirname(path.dirname(ledgers['child-a'] ?? '')), 'start', 'epic', 'child-a');

  assert.equal(read(epic), before.replace('- child-a\n', `- child-a (started ${today()})\n`));
  assert.equal(result.stdout, `started child-a in ${epic}\n`);
});

for (const mark of ['started 2026-10-01', 'retired 2026-10-01']) {
  test(`start leaves a child line marked ${mark.split(' ')[0]} as it is and prints nothing`, (t) => {
    const { home, main, ledgers } = repository(t, 'epic', 'child-a');
    const epic = ledgers.epic ?? '';
    setChildren(epic, `- child-a (${mark})\n`);
    const before = read(epic);

    const result = ok(home, main, 'start', 'epic', 'child-a');

    assert.equal(read(epic), before);
    assert.equal(result.stdout, '');
  });
}

test('start a second time changes nothing', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  ok(home, main, 'add', 'epic', 'child-a');
  ok(home, main, 'start', 'epic', 'child-a');
  const after = read(ledgers.epic ?? '');

  assert.equal(ok(home, main, 'start', 'epic', 'child-a').stdout, '');
  assert.equal(read(ledgers.epic ?? ''), after);
});

test('start keeps CRLF line endings', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  ok(home, main, 'add', 'epic', 'child-a');
  const epic = ledgers.epic ?? '';
  writeFileSync(epic, crlf(read(epic)));
  const before = read(epic);

  ok(home, main, 'start', 'epic', 'child-a');

  assert.equal(read(epic), before.replace('- child-a\r\n', `- child-a (started ${today()})\r\n`));
});

test('start of a slug that is not under the parent Children fails with one line and changes nothing', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a', 'other');
  ok(home, main, 'add', 'epic', 'child-a');
  const before = read(ledgers.epic ?? '');

  const result = parent(home, main, 'start', 'epic', 'other');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]*other[^\n]*epic[^\n]*\n$/);
  assert.equal(read(ledgers.epic ?? ''), before);
});

test('start of a slug that is not under the parent Children names the command that adds it', (t) => {
  const { home, main } = repository(t, 'epic', 'other');

  const result = parent(home, main, 'start', 'epic', 'other');

  assert.match(result.stderr, /\/ledger:parent epic add other\b/);
});

for (const args of [['start', 'epic'], ['start', 'epic', 'a', 'b'], ['start', 'epic', 'a', '--json'], ['next'], ['next', 'epic', 'a']]) {
  test(`${args.join(' ')} is a usage error`, (t) => {
    const { home, main } = repository(t, 'epic');

    const result = parent(home, main, ...args);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^usage: cc-ledger-parent /);
  });
}

test('next prints the parent and the first child in Children line order that is unmarked and in the backlog', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'busy');
  const backlog = Object.fromEntries(['begun', 'old-idea', 'new-idea'].map((slug) => [slug, addBacklogTask(home, main, slug)]));
  setChildren(ledgers.epic ?? '', '- busy\n- gone (retired 2026-10-01)\n- begun (started 2026-10-02)\n- old-idea\n- new-idea\n');
  utimesSync(backlog.begun ?? '', new Date(2026, 9, 2), new Date(2026, 9, 2));
  utimesSync(backlog['old-idea'] ?? '', new Date(2026, 9, 1), new Date(2026, 9, 1));
  utimesSync(backlog['new-idea'] ?? '', new Date(2026, 9, 9), new Date(2026, 9, 9));
  const shown = JSON.parse(ok(home, main, 'show', 'epic', '--json').stdout) as Shown;
  assert.equal(shown.children.find(({ status }) => status === 'backlog')?.slug, 'new-idea');

  assert.equal(ok(home, main, 'next', 'epic').stdout, 'epic old-idea\n');
});

test('next walks into a picked child that has children of its own, and prints the whole path', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const phase = addBacklogTask(home, main, 'phase');
  addBacklogTask(home, main, 'leaf');
  addBacklogTask(home, main, 'later');
  setChildren(ledgers.epic ?? '', '- phase\n- later\n');
  setChildren(phase, '- leaf\n');

  assert.equal(ok(home, main, 'next', 'epic').stdout, 'epic phase leaf\n');
});

test('next passes over a backlog child whose own children leave nothing to start', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const phase = addBacklogTask(home, main, 'phase');
  addBacklogTask(home, main, 'leaf');
  addBacklogTask(home, main, 'later');
  setChildren(ledgers.epic ?? '', '- phase\n- later\n');
  setChildren(phase, '- leaf (started 2026-10-01)\n- done (retired 2026-10-01)\n');

  assert.equal(ok(home, main, 'next', 'epic').stdout, 'epic later\n');
});

test('next stops at a cycle among the children and still finds the next child', (t) => {
  const { home, main } = repository(t);
  const epic = addBacklogTask(home, main, 'epic');
  const loop = addBacklogTask(home, main, 'loop');
  addBacklogTask(home, main, 'last');
  setChildren(epic, '- loop\n- last\n');
  setChildren(loop, '- epic\n');

  const result = parent(home, main, 'next', 'epic');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'epic last\n');
});

test('next prints nothing when no child is left to start', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'busy');
  addBacklogTask(home, main, 'begun');
  setChildren(ledgers.epic ?? '', '- busy\n- gone (retired 2026-10-01)\n- begun (started 2026-10-02)\n- lost\n');

  const result = ok(home, main, 'next', 'epic');

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

// A second repository in the same HOME, at `folder` under it, with a worktree task for each slug.
function otherRepository(home: string, folder: string, ...slugs: string[]) {
  const main = path.join(home, folder);
  mkdirSync(main, { recursive: true });
  git(home, main, 'init', '--quiet', '-b', 'main');
  git(home, main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  const ledgers: Record<string, string> = {};
  for (const slug of slugs) ledgers[slug] = addTask(home, main, slug);
  return { main, ledgers };
}

const withParentBullet = (text: string, bullet: string) => text.replace('- base: main @ abc1234\n', `- base: main @ abc1234\n${bullet}\n`);
const withChildren = (text: string, lines: string) => text.replace('- base: main @ abc1234\n\n', `- base: main @ abc1234\n\n## Children\n${lines}\n`);

test('add of a child in another repository writes both links with the other main checkout, and a rerun changes nothing', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  const parser = lib.ledgers.parser ?? '';
  const epic = ledgers.epic ?? '';
  const before = [read(parser), read(epic)] as const;

  const result = ok(home, main, 'add', 'epic', `parser@${lib.main}`);

  assert.equal(result.stderr, '');
  assert.equal(read(parser), withParentBullet(before[0], `- parent: epic @ ${main}`));
  assert.equal(read(epic), withChildren(before[1], `- parser @ ${lib.main}\n`));
  const after = [read(parser), read(epic)];
  assert.equal(ok(home, main, 'add', 'epic', `parser@${lib.main}`).stderr, '');
  assert.deepEqual([read(parser), read(epic)], after);
});

test('add of a child in another repository registers the parent slug and its main checkout', (t) => {
  const { home, main } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'parser');

  ok(home, main, 'add', 'epic', `parser@${lib.main}`);

  const { parent, parentMain } = registered(home, 'parser') ?? {};
  assert.deepEqual({ parent, parentMain }, { parent: 'epic', parentMain: main });
  assert.equal(Object.hasOwn(registered(home, 'epic') ?? {}, 'parentMain'), false);
});

test('add run in the child repository, with the parent named by slug@path, writes the same links', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  const parser = lib.ledgers.parser ?? '';
  const epic = ledgers.epic ?? '';
  const before = [read(parser), read(epic)] as const;

  ok(home, lib.main, 'add', `epic@${main}`, 'parser');

  assert.equal(read(parser), withParentBullet(before[0], `- parent: epic @ ${main}`));
  assert.equal(read(epic), withChildren(before[1], `- parser @ ${lib.main}\n`));
});

test('a slug@path argument may name a linked worktree of the repository, relative to the current folder', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'parser');

  ok(home, main, 'add', 'epic', 'parser@../lib/.claude/worktrees/parser');

  assert.match(read(ledgers.epic ?? ''), new RegExp(`^## Children\\n- parser @ ${lib.main}$`, 'm'));
  assert.match(read(lib.ledgers.parser ?? ''), new RegExp(`^- parent: epic @ ${main}$`, 'm'));
});

test('a slug@path argument that names the current repository writes the links of one repository', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'child-a');
  const before = [read(ledgers['child-a'] ?? ''), read(ledgers.epic ?? '')] as const;

  ok(home, main, 'add', `epic@${main}`, 'child-a@.');

  assert.equal(read(ledgers['child-a'] ?? ''), withParentBullet(before[0], '- parent: epic'));
  assert.equal(read(ledgers.epic ?? ''), withChildren(before[1], '- child-a\n'));
  assert.equal(Object.hasOwn(registered(home, 'child-a') ?? {}, 'parentMain'), false);
});

test('tasks with one slug in two repositories are two children, and a bare slug finds only this repository\'s task', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'shared');
  const lib = otherRepository(home, 'repos/lib', 'shared', 'only-lib');
  const epicBefore = read(ledgers.epic ?? '');

  ok(home, main, 'add', 'epic', 'shared');
  ok(home, main, 'add', 'epic', `shared@${lib.main}`);

  assert.equal(read(ledgers.epic ?? ''), withChildren(epicBefore, `- shared\n- shared @ ${lib.main}\n`));
  assert.match(read(ledgers.shared ?? ''), /^- parent: epic$/m);
  assert.match(read(lib.ledgers.shared ?? ''), new RegExp(`^- parent: epic @ ${main}$`, 'm'));
  const unknown = parent(home, main, 'add', 'epic', 'only-lib');
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr, 'no task ledger with the slug only-lib in this repository\n');

  ok(home, main, 'remove', 'epic', `shared@${lib.main}`);

  assert.equal(read(ledgers.epic ?? ''), withChildren(epicBefore, '- shared\n'));
  assert.match(read(ledgers.shared ?? ''), /^- parent: epic$/m);
  assert.doesNotMatch(read(lib.ledgers.shared ?? ''), /^- parent:/m);
});

test('remove of a child in another repository restores both ledgers and clears the parent in the registry', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  const files = [lib.ledgers.parser ?? '', ledgers.epic ?? ''];
  const before = files.map(read);
  ok(home, main, 'add', 'epic', `parser@${lib.main}`);

  ok(home, lib.main, 'remove', `epic@${main}`, 'parser');

  assert.deepEqual(files.map(read), before);
  const entry = registered(home, 'parser') ?? {};
  assert.equal(Object.hasOwn(entry, 'parent') || Object.hasOwn(entry, 'parentMain'), false);
});

test('show names a child in another repository as slug@main, looks up its status there, and JSON adds main to it only', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'busy');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  addBacklogTask(home, lib.main, 'idea');
  ok(home, main, 'add', 'epic', 'busy');
  ok(home, main, 'add', 'epic', `parser@${lib.main}`);
  ok(home, main, 'add', 'epic', `idea@${lib.main}`);
  utimesSync(ledgers.busy ?? '', new Date(2026, 9, 9), new Date(2026, 9, 9));
  utimesSync(lib.ledgers.parser ?? '', new Date(2026, 9, 8), new Date(2026, 9, 8));

  assert.equal(
    ok(home, main, 'show', 'epic').stdout,
    [
      'epic\tGoal of epic.',
      'busy\tactive\tNext step of busy.',
      `parser@${lib.main}\tactive\tNext step of parser.`,
      `idea@${lib.main}\tbacklog\tNext step of idea.`,
      '',
    ].join('\n'),
  );
  assert.deepEqual((JSON.parse(ok(home, main, 'show', 'epic', '--json').stdout) as Shown).children, [
    { slug: 'busy', status: 'active', next: 'Next step of busy.' },
    { slug: 'parser', status: 'active', next: 'Next step of parser.', main: lib.main },
    { slug: 'idea', status: 'backlog', next: 'Next step of idea.', main: lib.main },
  ]);
});

test('start marks a child in another repository and keeps its main checkout on the line', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  ok(home, main, 'add', 'epic', `parser@${lib.main}`);
  const epic = ledgers.epic ?? '';
  const before = read(epic);

  const result = ok(home, main, 'start', 'epic', `parser@${lib.main}`);

  assert.equal(read(epic), before.replace(`- parser @ ${lib.main}\n`, `- parser @ ${lib.main} (started ${today()})\n`));
  assert.equal(result.stdout, `started parser@${lib.main} in ${epic}\n`);
});

test('start of a bare slug does not match a child of that slug in another repository', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  ok(home, main, 'add', 'epic', `parser@${lib.main}`);
  const before = read(ledgers.epic ?? '');

  const result = parent(home, main, 'start', 'epic', 'parser');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]*parser[^\n]*epic[^\n]*\n$/);
  assert.equal(read(ledgers.epic ?? ''), before);
});

test('next prints a picked child in another repository, and its own children there, as slug@main', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib');
  const phase = addBacklogTask(home, lib.main, 'phase');
  addBacklogTask(home, lib.main, 'leaf');
  setChildren(ledgers.epic ?? '', `- phase @ ${lib.main}\n`);
  setChildren(phase, '- leaf\n');

  assert.equal(ok(home, main, 'next', 'epic').stdout, `epic phase@${lib.main} leaf@${lib.main}\n`);
});

test('next looks up the children of a child in another repository in that repository, not in this one', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'leaf');
  const phase = addBacklogTask(home, lib.main, 'phase');
  addBacklogTask(home, main, 'leaf');
  addBacklogTask(home, main, 'later');
  setChildren(ledgers.epic ?? '', `- phase @ ${lib.main}\n- later\n`);
  setChildren(phase, '- leaf\n');

  assert.equal(ok(home, main, 'next', 'epic').stdout, 'epic later\n');
});

test('add refuses a cycle across repositories with one line and changes nothing', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  ok(home, main, 'add', 'epic', `parser@${lib.main}`);
  const files = [ledgers.epic ?? '', lib.ledgers.parser ?? ''];
  const before = files.map(read);

  for (const [cwd, args] of [
    [main, [`parser@${lib.main}`, 'epic']],
    [lib.main, ['parser', `epic@${main}`]],
  ] as const) {
    const result = parent(home, cwd, 'add', ...args);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^[^\n]*epic[^\n]*parser[^\n]*cycle[^\n]*\n$/);
    assert.deepEqual(files.map(read), before);
  }
});

test('add refuses a retired child in another repository, and takes a task of the same slug in this repository', (t) => {
  const { home, main, ledgers } = repository(t, 'epic', 'parser');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  setChildren(ledgers.epic ?? '', `- parser @ ${lib.main} (retired 2026-10-01)\n`);
  const before = read(lib.ledgers.parser ?? '');

  const refused = parent(home, main, 'add', 'epic', `parser@${lib.main}`);

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /retired/);
  assert.equal(read(lib.ledgers.parser ?? ''), before);
  ok(home, main, 'add', 'epic', 'parser');
  assert.match(read(ledgers.epic ?? ''), new RegExp(`^- parser @ ${lib.main} \\(retired 2026-10-01\\)\\n- parser$`, 'm'));
});

test('add refuses a child whose parent is in another repository, and names the remove command that works from here', (t) => {
  const { home, main } = repository(t, 'epic', 'other');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  ok(home, main, 'add', 'epic', `parser@${lib.main}`);

  const result = parent(home, lib.main, 'add', `other@${main}`, 'parser');

  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`cc-ledger-parent remove epic@${main} parser`), result.stderr);
});

test('add refuses a main checkout path with whitespace in one line, and changes nothing', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const spaced = otherRepository(home, 'repos/my lib', 'parser');
  const files = [ledgers.epic ?? '', spaced.ledgers.parser ?? ''];
  const before = files.map(read);

  for (const [cwd, args] of [
    [main, ['epic', `parser@${spaced.main}`]],
    [spaced.main, [`epic@${main}`, 'parser']],
  ] as const) {
    const result = parent(home, cwd, 'add', ...args);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^[^\n]*whitespace[^\n]*\n$/);
    assert.ok(result.stderr.includes(spaced.main), result.stderr);
    assert.deepEqual(files.map(read), before);
  }
});

for (const [name, folder] of [
  ['a folder outside any git repository', 'plain'],
  ['a folder that does not exist', 'nowhere'],
] as const) {
  test(`a slug@path argument that names ${name} fails with one line that names the folder`, (t) => {
    const { home, main, ledgers } = repository(t, 'epic');
    mkdirSync(path.join(home, 'plain'));
    const target = path.join(home, folder);
    const before = read(ledgers.epic ?? '');

    const result = parent(home, main, 'add', 'epic', `parser@${target}`);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^[^\n]+\n$/);
    assert.ok(result.stderr.includes(target), result.stderr);
    assert.equal(read(ledgers.epic ?? ''), before);
  });
}

test('a slug@ argument with no path is refused with one line', (t) => {
  const { home, main } = repository(t, 'epic');

  const result = parent(home, main, 'add', 'epic', 'parser@');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^[^\n]+\n$/);
});

// A bare repository's main checkout, the folder that holds it, is not a git folder, so its worktrees are listed from a folder in it.
function bareRepository(home: string, ...slugs: string[]) {
  const source = path.join(home, 'repos/source');
  mkdirSync(source, { recursive: true });
  git(home, source, 'init', '--quiet', '-b', 'main');
  git(home, source, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  const bare = path.join(home, 'bare/app.git');
  git(home, home, 'clone', '--quiet', '--bare', source, bare);
  const worktrees: Record<string, string> = {};
  const ledgers: Record<string, string> = {};
  for (const slug of slugs) {
    const worktree = path.join(home, 'bare/worktrees', slug);
    git(home, bare, 'worktree', 'add', '--quiet', '-b', `me/${slug}`, worktree);
    const ledger = path.join(worktree, '.claude/ledger.md');
    mkdirSync(path.dirname(ledger));
    writeFileSync(ledger, ledgerText(slug, worktree));
    worktrees[slug] = worktree;
    ledgers[slug] = ledger;
  }
  return { worktrees, ledgers };
}

test('a bare slug in a worktree of a bare repository finds the tasks of its worktrees', (t) => {
  const home = realpathSync(freshHome(t));
  const { worktrees, ledgers } = bareRepository(home, 'epic', 'parser');

  ok(home, worktrees.epic ?? '', 'add', 'epic', 'parser');

  assert.match(read(ledgers.parser ?? ''), /^- parent: epic$/m);
  assert.match(read(ledgers.epic ?? ''), /^## Children\n- parser$/m);
});

test('a slug@path argument finds a task in a worktree of a bare repository', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const bare = bareRepository(home, 'parser');

  ok(home, main, 'add', 'epic', `parser@${bare.worktrees.parser}`);

  assert.match(read(bare.ledgers.parser ?? ''), new RegExp(`^- parent: epic @ ${main}$`, 'm'));
  assert.match(read(ledgers.epic ?? ''), /^## Children\n- parser @ \S+$/m);
});

test('with every task named by slug@path, the current folder need not be in a git repository; a bare slug there fails', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const lib = otherRepository(home, 'repos/lib', 'parser');
  const outside = path.join(home, 'plain');
  mkdirSync(outside);

  ok(home, outside, 'add', `epic@${main}`, `parser@${lib.main}`);

  assert.match(read(ledgers.epic ?? ''), new RegExp(`^## Children\\n- parser @ ${lib.main}$`, 'm'));
  assert.equal(ok(home, outside, 'show', `epic@${main}`).stdout.split('\n')[1], `parser@${lib.main}\tactive\tNext step of parser.`);
  const bare = parent(home, outside, 'show', 'epic');
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /^not inside a git repository: [^\n]+\n$/);
});

test('two repositories with the same folder name keep their backlog tasks apart', (t) => {
  const { home, main, ledgers } = repository(t, 'epic');
  const fork = otherRepository(home, 'forks/app');
  const idea = addBacklogTask(home, fork.main, 'idea');

  const bare = parent(home, main, 'add', 'epic', 'idea');
  assert.equal(bare.status, 1);
  assert.equal(bare.stderr, 'no task ledger with the slug idea in this repository\n');

  ok(home, main, 'add', 'epic', `idea@${fork.main}`);

  assert.match(read(ledgers.epic ?? ''), new RegExp(`^## Children\\n- idea @ ${fork.main}$`, 'm'));
  assert.match(read(idea), new RegExp(`^- parent: epic @ ${main}$`, 'm'));
  assert.equal(ok(home, main, 'next', 'epic').stdout, `epic idea@${fork.main}\n`);
});
