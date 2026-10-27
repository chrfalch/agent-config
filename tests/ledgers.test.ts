import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { freshHome, REPO, run } from './helpers.js';

const LEDGERS = [path.join(REPO, 'bin/cc-ledgers')] as const;

type Entry = {
  repo: string;
  slug: string;
  path: string;
  branch: string;
  status: 'active' | 'archived' | 'backlog';
  created: string;
  updated: string;
  archivePath?: string;
  parent?: string;
  parentMain?: string;
  main?: string;
};

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function git(home: string, directory: string, ...args: string[]): void {
  const result = run(home, ['git', '-C', directory, '-c', 'user.name=test', '-c', 'user.email=test@example.com'], ...args);
  assert.equal(result.status, 0, result.stderr);
}

// realpath, because git reports a tmpdir under /var as /private/var.
function home(t: TestContext): string {
  return realpathSync(freshHome(t));
}

function checkout(home: string, folder: string): string {
  mkdirSync(folder, { recursive: true });
  git(home, folder, 'init', '--quiet', '-b', 'main');
  git(home, folder, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  return folder;
}

function worktree(home: string, main: string, folder: string, branch: string): string {
  git(home, main, 'worktree', 'add', '--quiet', '-b', branch, path.join(main, '.claude/worktrees', folder));
  return path.join(main, '.claude/worktrees', folder);
}

function ledgerIn(folder: string, slug: string, extra = ''): string {
  const ledger = path.join(folder, '.claude/ledger.md');
  mkdirSync(path.dirname(ledger), { recursive: true });
  writeFileSync(ledger, `# Task ledger — ${slug}\n\n## Goal\nA goal.\n${extra}`);
  return ledger;
}

function archiveCopy(home: string, repo: string, name: string, text: string): string {
  const file = path.join(home, '.claude/ledger-archive', repo, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function backlogLedger(home: string, repo: string, slug: string, main: string): string {
  const file = path.join(home, '.claude/ledger-backlog', repo, `${slug}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# Task ledger — some-title\n\n## Location\n- main: ${main}\n- worktree: <path>\n- branch: me/${slug}\n- base: <branch/commit>\n`);
  return file;
}

function setMtime(file: string, iso: string): void {
  const time = new Date(iso);
  utimesSync(file, time, time);
}

const registryFile = (home: string) => path.join(home, '.claude/ledgers.json');
const registry = (home: string): Entry[] => JSON.parse(readFileSync(registryFile(home), 'utf8')) as Entry[];
const mtimeIso = (file: string) => statSync(file).mtime.toISOString();

function ledgers(home: string, ...args: string[]) {
  const result = run(home, LEDGERS, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const line = (entry: Pick<Entry, 'repo' | 'slug' | 'status' | 'updated'>, file: string) =>
  [entry.repo, entry.slug, entry.status, entry.updated, file].join('\t');

test('upsert registers a worktree ledger with the title slug, the repo and the branch', (t) => {
  const h = home(t);
  const main = checkout(h, path.join(h, 'repos/org/app'));
  const ledger = ledgerIn(worktree(h, main, 'folder-name', 'me/fix-login'), 'fix-login');

  ledgers(h, 'upsert', ledger);

  const [entry, ...rest] = registry(h);
  assert.deepEqual(rest, []);
  assert.ok(entry);
  assert.match(entry.created, ISO);
  assert.deepEqual(entry, {
    repo: 'app',
    slug: 'fix-login',
    path: ledger,
    branch: 'me/fix-login',
    status: 'active',
    created: entry.created,
    updated: mtimeIso(ledger),
  });
});

test('upsert takes repo, slug and branch from flags', (t) => {
  const h = home(t);
  const ledger = ledgerIn(path.join(h, 'loose'), 'from-title');

  ledgers(h, 'upsert', ledger, '--repo', 'R', '--slug', 'S', '--branch', 'B');

  assert.deepEqual(
    registry(h).map(({ repo, slug, branch }) => ({ repo, slug, branch })),
    [{ repo: 'R', slug: 'S', branch: 'B' }],
  );
});

test('upsert outside git falls back to the folder name and an empty branch', (t) => {
  const h = home(t);
  const ledger = ledgerIn(path.join(h, 'issues/crash'), 'crash-fix');
  writeFileSync(ledger, 'no title\n');

  ledgers(h, 'upsert', ledger);

  assert.deepEqual(
    registry(h).map(({ repo, slug, branch }) => ({ repo, slug, branch })),
    [{ repo: 'crash', slug: 'crash', branch: '' }],
  );
});

test('upsert of a missing file fails and writes nothing', (t) => {
  const h = home(t);
  const result = run(h, LEDGERS, 'upsert', path.join(h, 'nowhere/.claude/ledger.md'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nowhere\/\.claude\/ledger\.md/);
  assert.throws(() => statSync(registryFile(h)));
});

test('a second upsert keeps created and takes the new mtime as updated', (t) => {
  const h = home(t);
  const main = checkout(h, path.join(h, 'repos/app'));
  const ledger = ledgerIn(worktree(h, main, 'fix', 'fix'), 'fix');
  ledgers(h, 'upsert', ledger);
  const [first] = registry(h);
  assert.ok(first);

  setMtime(ledger, '2099-01-02T03:04:05.000Z');
  ledgers(h, 'upsert', ledger);

  const [second, ...rest] = registry(h);
  assert.deepEqual(rest, []);
  assert.deepEqual(second, { ...first, updated: '2099-01-02T03:04:05.000Z' });
});

test('archive marks the entry archived with its archive path and keeps the other fields', (t) => {
  const h = home(t);
  const main = checkout(h, path.join(h, 'repos/app'));
  const ledger = ledgerIn(worktree(h, main, 'fix', 'me/fix'), 'fix');
  ledgers(h, 'upsert', ledger);
  const [before] = registry(h);
  assert.ok(before);
  const copy = archiveCopy(h, 'app', '2026-10-20-fix.md', readFileSync(ledger, 'utf8'));
  const start = Date.now();

  ledgers(h, 'archive', ledger, copy);

  const [after, ...rest] = registry(h);
  assert.deepEqual(rest, []);
  assert.ok(after);
  assert.match(after.updated, ISO);
  assert.ok(Date.parse(after.updated) >= start - 1000, after.updated);
  assert.deepEqual(after, { ...before, status: 'archived', archivePath: copy, updated: after.updated });
});

test('archive with no entry builds one from the archive copy and its Location section', (t) => {
  const h = home(t);
  const copy = archiveCopy(
    h,
    'app',
    '2026-10-20-fix.md',
    '# Task ledger — fix-title\n\n## Location\n- worktree: /work/app/.claude/worktrees/fix\n- branch: me/fix\n- base: main @ abc\n',
  );

  ledgers(h, 'archive', '/given/.claude/ledger.md', copy);

  const [entry, ...rest] = registry(h);
  assert.deepEqual(rest, []);
  assert.ok(entry);
  assert.match(entry.created, ISO);
  assert.deepEqual(entry, {
    repo: 'app',
    slug: 'fix-title',
    path: '/work/app/.claude/worktrees/fix/.claude/ledger.md',
    branch: 'me/fix',
    status: 'archived',
    created: entry.created,
    updated: entry.updated,
    archivePath: copy,
  });
});

test('archive with no entry and no Location section uses the given ledger path and an empty branch', (t) => {
  const h = home(t);
  const copy = archiveCopy(h, 'app', '2026-10-20-fix.md', '# Task ledger — fix\n');

  ledgers(h, 'archive', '/given/.claude/ledger.md', copy);

  assert.deepEqual(
    registry(h).map(({ path, branch, slug }) => ({ path, branch, slug })),
    [{ path: '/given/.claude/ledger.md', branch: '', slug: 'fix' }],
  );
});

test('list drops entries whose file is gone, rewrites the registry and prints the rest', (t) => {
  const h = home(t);
  const kept = ledgerIn(path.join(h, 'issues/kept'), 'kept');
  const gone = ledgerIn(path.join(h, 'issues/gone'), 'gone');
  const retired = ledgerIn(path.join(h, 'issues/retired'), 'retired');
  setMtime(kept, '2026-10-03T00:00:00.000Z');
  setMtime(gone, '2026-10-02T00:00:00.000Z');
  for (const ledger of [kept, gone, retired]) ledgers(h, 'upsert', ledger);
  const copy = archiveCopy(h, 'retired', '2026-10-01-retired.md', readFileSync(retired, 'utf8'));
  ledgers(h, 'archive', retired, copy);
  rmSync(gone);

  const [archived, active] = registry(h).filter((entry) => entry.slug !== 'gone');
  assert.ok(archived && active);
  assert.equal(archived.status, 'archived');
  assert.equal(
    ledgers(h, 'list').stdout,
    `${line(archived, copy)}\n${line(active, kept)}\n`,
  );
  assert.deepEqual(registry(h), [archived, active]);

  rmSync(copy);
  assert.equal(ledgers(h, 'list').stdout, `${line(active, kept)}\n`);
  assert.deepEqual(registry(h), [active]);
  assert.deepEqual(JSON.parse(ledgers(h, 'list', '--json').stdout), [active]);
});

test('list leaves the registry file untouched when every file still exists', (t) => {
  const h = home(t);
  const ledger = ledgerIn(path.join(h, 'issues/kept'), 'kept');
  const entry: Entry = {
    repo: 'kept',
    slug: 'kept',
    path: ledger,
    branch: '',
    status: 'active',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z',
  };
  const text = JSON.stringify([entry]);
  writeFileSync(registryFile(h), text);

  assert.equal(ledgers(h, 'list').stdout, `${line(entry, ledger)}\n`);
  assert.equal(readFileSync(registryFile(h), 'utf8'), text);
});

test('list reads an unparsable registry as empty and warns', (t) => {
  const h = home(t);
  writeFileSync(registryFile(h), '{ not json');

  const result = ledgers(h, 'list');

  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^warning: .*ledgers\.json/);
});

test('the registry is written newest first', (t) => {
  const h = home(t);
  const times = { middle: '2026-05-01T00:00:00.000Z', newest: '2026-09-01T00:00:00.000Z', oldest: '2026-01-01T00:00:00.000Z' };
  for (const [slug, time] of Object.entries(times)) {
    const ledger = ledgerIn(path.join(h, 'issues', slug), slug);
    setMtime(ledger, time);
    ledgers(h, 'upsert', ledger);
  }

  assert.deepEqual(
    registry(h).map(({ slug }) => slug),
    ['newest', 'middle', 'oldest'],
  );
});

test('scan rebuilds the registry from worktree ledgers, issue ledgers and the archive', (t) => {
  const h = home(t);
  const main = checkout(h, path.join(h, 'repos/org/app'));
  const feature = ledgerIn(worktree(h, main, 'feature', 'me/feature'), 'feature-title');
  const issue = ledgerIn(path.join(h, 'issues/crash'), 'crash');
  ledgerIn(path.join(main, 'node_modules/pkg'), 'from-node-modules');
  const copy = archiveCopy(
    h,
    'app',
    '2026-10-01-old.md',
    '# Task ledger — old-task\n\n## Location\n- worktree: /work/old\n- branch: me/old\n',
  );
  setMtime(feature, '2026-10-03T00:00:00.000Z');
  setMtime(issue, '2026-10-02T00:00:00.000Z');
  setMtime(copy, '2026-10-01T00:00:00.000Z');
  const prior: Entry[] = [
    { repo: 'app', slug: 'feature-title', path: feature, branch: 'me/feature', status: 'active', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z' },
    { repo: 'gone', slug: 'gone', path: '/gone/.claude/ledger.md', branch: '', status: 'active', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z' },
  ];
  writeFileSync(registryFile(h), JSON.stringify(prior));

  const result = ledgers(h, 'scan');

  const entries = registry(h);
  assert.equal(result.stderr, `rebuilt ${registryFile(h)}: 2 active, 1 archived\n`);
  assert.deepEqual(
    entries.map(({ created, ...rest }) => rest),
    [
      { repo: 'app', slug: 'feature-title', path: feature, branch: 'me/feature', status: 'active', updated: '2026-10-03T00:00:00.000Z' },
      { repo: 'crash', slug: 'crash', path: issue, branch: '', status: 'active', updated: '2026-10-02T00:00:00.000Z' },
      { repo: 'app', slug: 'old-task', path: '/work/old/.claude/ledger.md', branch: 'me/old', status: 'archived', updated: '2026-10-01T00:00:00.000Z', archivePath: copy },
    ],
  );
  assert.equal(entries[0]?.created, '2020-01-01T00:00:00.000Z');
  for (const entry of entries) assert.match(entry.created, ISO);
  assert.equal(result.stdout, ledgers(h, 'list').stdout);
  assert.deepEqual(JSON.parse(ledgers(h, 'scan', '--json').stdout), entries);
});

test('scan walks only the folders it is given', (t) => {
  const h = home(t);
  ledgerIn(path.join(h, 'repos/app'), 'skipped');
  const chosen = ledgerIn(path.join(h, 'elsewhere/app'), 'chosen');

  const result = ledgers(h, 'scan', path.join(h, 'elsewhere'));

  assert.deepEqual(registry(h).map(({ path }) => path), [chosen]);
  assert.equal(result.stderr, `rebuilt ${registryFile(h)}: 1 active, 0 archived\n`);
});

for (const command of ['upsert', 'archive']) {
  test(`${command} of an unparsable registry fails, names the file and leaves it as it is`, (t) => {
    const h = home(t);
    const ledger = ledgerIn(path.join(h, 'issues/kept'), 'kept');
    const copy = archiveCopy(h, 'kept', '2026-10-20-kept.md', '# Task ledger — kept\n');
    writeFileSync(registryFile(h), '{ not json');

    const result = run(h, LEDGERS, command, ...(command === 'upsert' ? [ledger] : [ledger, copy]));

    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(registryFile(h)), result.stderr);
    assert.equal(readFileSync(registryFile(h), 'utf8'), '{ not json');
  });

  test(`${command} drops entries whose file is gone`, (t) => {
    const h = home(t);
    const ledger = ledgerIn(path.join(h, 'issues/kept'), 'kept');
    const copy = archiveCopy(h, 'kept', '2026-10-20-kept.md', '# Task ledger — kept\n');
    const stale = { repo: 'gone', branch: '', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z' };
    writeFileSync(
      registryFile(h),
      JSON.stringify([
        { ...stale, slug: 'gone-active', path: '/gone/.claude/ledger.md', status: 'active' },
        { ...stale, slug: 'gone-archived', path: '/gone/.claude/ledger.md', status: 'archived', archivePath: '/gone/archive.md' },
      ]),
    );

    ledgers(h, command, ...(command === 'upsert' ? [ledger] : [ledger, copy]));

    assert.deepEqual(registry(h).map(({ slug }) => slug), ['kept']);
  });
}

test('upsert registers several ledgers in one call', (t) => {
  const h = home(t);
  const first = ledgerIn(path.join(h, 'issues/first'), 'first');
  const second = ledgerIn(path.join(h, 'issues/second'), 'second');

  ledgers(h, 'upsert', first, second);

  assert.deepEqual(registry(h).map(({ path }) => path).sort(), [first, second].sort());
});

test('upsert of several ledgers with a flag fails with usage and writes nothing', (t) => {
  const h = home(t);
  const first = ledgerIn(path.join(h, 'issues/first'), 'first');
  const second = ledgerIn(path.join(h, 'issues/second'), 'second');

  const result = run(h, LEDGERS, 'upsert', first, second, '--repo', 'R');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^usage: /);
  assert.equal(existsSync(registryFile(h)), false);
});

test('upsert skips and reports a missing ledger, writes the others and fails at the end', (t) => {
  const h = home(t);
  const first = ledgerIn(path.join(h, 'issues/first'), 'first');
  const missing = path.join(h, 'nowhere/.claude/ledger.md');
  const second = ledgerIn(path.join(h, 'issues/second'), 'second');

  const result = run(h, LEDGERS, 'upsert', first, missing, second);

  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(missing), result.stderr);
  assert.deepEqual(registry(h).map(({ path }) => path).sort(), [first, second].sort());
});

test('archive with a missing archive copy fails and writes nothing', (t) => {
  const h = home(t);
  const missing = path.join(h, '.claude/ledger-archive/app/2026-10-20-fix.md');

  const result = run(h, LEDGERS, 'archive', '/given/.claude/ledger.md', missing);

  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(missing), result.stderr);
  assert.equal(existsSync(registryFile(h)), false);
});

test('upsert of a ledger in ~/.claude/ledger-backlog registers it as backlog with its main checkout', (t) => {
  const h = home(t);
  const backlog = backlogLedger(h, 'app', 'fix-login', '/work/app');

  ledgers(h, 'upsert', backlog);

  const [entry, ...rest] = registry(h);
  assert.deepEqual(rest, []);
  assert.ok(entry);
  assert.match(entry.created, ISO);
  assert.deepEqual(entry, {
    repo: 'app',
    slug: 'fix-login',
    path: backlog,
    branch: 'me/fix-login',
    status: 'backlog',
    main: '/work/app',
    created: entry.created,
    updated: mtimeIso(backlog),
  });
  assert.deepEqual(JSON.parse(ledgers(h, 'list', '--json').stdout), [entry]);
  assert.equal(ledgers(h, 'list').stdout, `${line(entry, backlog)}\n`);
});

test('upsert of a backlog ledger takes repo, slug and branch from flags', (t) => {
  const h = home(t);
  const backlog = backlogLedger(h, 'app', 'fix-login', '/work/app');

  ledgers(h, 'upsert', backlog, '--repo', 'R', '--slug', 'S', '--branch', 'B');

  assert.deepEqual(
    registry(h).map(({ repo, slug, branch, status, main }) => ({ repo, slug, branch, status, main })),
    [{ repo: 'R', slug: 'S', branch: 'B', status: 'backlog', main: '/work/app' }],
  );
});

test('upsert --replaces swaps a promoted backlog entry for the active one and keeps its created time', (t) => {
  const h = home(t);
  const main = checkout(h, path.join(h, 'repos/app'));
  const backlog = backlogLedger(h, 'app', 'fix-login', main);
  ledgers(h, 'upsert', backlog);
  const created = '2020-01-01T00:00:00.000Z';
  writeFileSync(registryFile(h), JSON.stringify(registry(h).map((entry) => ({ ...entry, created }))));
  const active = ledgerIn(worktree(h, main, 'fix-login', 'fix-login'), 'fix-login');
  rmSync(backlog);

  ledgers(h, 'upsert', active, '--replaces', backlog);

  assert.deepEqual(
    registry(h).map(({ path, status, created }) => ({ path, status, created })),
    [{ path: active, status: 'active', created }],
  );
});

test('upsert --replaces ignores a backlog entry of another main checkout', (t) => {
  const h = home(t);
  const mainA = checkout(h, path.join(h, 'repos/a/app'));
  const mainB = checkout(h, path.join(h, 'repos/b/app'));
  const backlog = backlogLedger(h, 'app', 'fix-login', mainA);
  ledgers(h, 'upsert', backlog);
  const created = '2020-01-01T00:00:00.000Z';
  writeFileSync(registryFile(h), JSON.stringify(registry(h).map((entry) => ({ ...entry, created }))));
  const [before] = registry(h);
  const active = ledgerIn(worktree(h, mainB, 'fix-login', 'fix-login'), 'fix-login');

  ledgers(h, 'upsert', active, '--replaces', backlog);

  const entries = registry(h);
  assert.deepEqual(entries.find((e) => e.status === 'backlog'), before);
  const fresh = entries.find((e) => e.status === 'active');
  assert.equal(fresh?.path, active);
  assert.notEqual(fresh?.created, created);
  assert.equal(entries.length, 2);
});

test('scan reads ~/.claude/ledger-backlog as backlog entries', (t) => {
  const h = home(t);
  const backlog = backlogLedger(h, 'app', 'fix-login', '/work/app');
  setMtime(backlog, '2026-10-04T00:00:00.000Z');

  const result = ledgers(h, 'scan', path.join(h, 'nothing-here'));

  assert.equal(result.stderr, `rebuilt ${registryFile(h)}: 0 active, 0 archived, 1 backlog\n`);
  assert.deepEqual(
    registry(h).map(({ created, ...rest }) => rest),
    [{ repo: 'app', slug: 'fix-login', path: backlog, branch: 'me/fix-login', status: 'backlog', main: '/work/app', updated: '2026-10-04T00:00:00.000Z' }],
  );
});

test("SessionStart's upsert leaves backlog entries as they are", (t) => {
  const h = home(t);
  const main = checkout(h, path.join(h, 'repos/app'));
  const active = ledgerIn(worktree(h, main, 'feature', 'feature'), 'feature');
  const backlog = backlogLedger(h, 'app', 'fix-login', main);
  ledgers(h, 'upsert', backlog);
  const [before] = registry(h);
  setMtime(backlog, '2099-01-02T03:04:05.000Z');

  const result = run(h, ['bash', '-c', 'cd "$1" && bash "$2" session-start', '_'], main, path.join(REPO, 'hooks/ledger-list.sh'));
  assert.equal(result.status, 0, result.stderr);

  const entries = registry(h);
  assert.deepEqual(entries.find((e) => e.status === 'backlog'), before);
  assert.deepEqual(entries.filter((e) => e.status === 'active').map(({ path }) => path), [active]);
});

test('scan takes the slug of an untitled archive copy from its file name without the date', (t) => {
  const h = home(t);
  archiveCopy(h, 'app', '2026-10-20-foo-bar.md', 'no title\n');
  archiveCopy(h, 'app', '2026-10-20-foo-bar-2.md', 'no title\n');

  ledgers(h, 'scan', path.join(h, 'nothing-here'));

  assert.deepEqual(registry(h).map(({ slug }) => slug).sort(), ['foo-bar', 'foo-bar-2']);
});

const withParent = (parent: string) => `\n## Location\n- worktree: /work/child\n- branch: me/child\n- parent: ${parent}\n`;

test('upsert takes the parent from the Location section', (t) => {
  const h = home(t);
  const child = ledgerIn(path.join(h, 'issues/child'), 'child', withParent('epic'));
  const placeholder = ledgerIn(path.join(h, 'issues/template'), 'template', withParent('<slug>'));
  const orphan = ledgerIn(path.join(h, 'issues/orphan'), 'orphan');

  ledgers(h, 'upsert', child, placeholder, orphan);

  const bySlug = Object.fromEntries(registry(h).map((entry) => [entry.slug, entry]));
  assert.equal(bySlug.child?.parent, 'epic');
  assert.equal(Object.hasOwn(bySlug.template ?? {}, 'parent'), false);
  assert.equal(Object.hasOwn(bySlug.orphan ?? {}, 'parent'), false);
});

test('upsert takes the parent from --parent', (t) => {
  const h = home(t);
  const ledger = ledgerIn(path.join(h, 'issues/child'), 'child');

  ledgers(h, 'upsert', ledger, '--parent', 'epic');

  assert.deepEqual(registry(h).map(({ slug, parent }) => ({ slug, parent })), [{ slug: 'child', parent: 'epic' }]);
  assert.deepEqual(JSON.parse(ledgers(h, 'list', '--json').stdout), registry(h));
});

test('a later upsert drops the parent once the ledger no longer names one', (t) => {
  const h = home(t);
  const ledger = ledgerIn(path.join(h, 'issues/child'), 'child', withParent('epic'));
  ledgers(h, 'upsert', ledger);

  writeFileSync(ledger, readFileSync(ledger, 'utf8').replace('- parent: epic\n', ''));
  ledgers(h, 'upsert', ledger);

  assert.equal(Object.hasOwn(registry(h)[0] ?? {}, 'parent'), false);
});

test('upsert of a backlog ledger takes the parent from its Location section, in the same place as an active entry', (t) => {
  const h = home(t);
  const backlog = backlogLedger(h, 'app', 'fix-login', '/work/app');
  writeFileSync(backlog, `${readFileSync(backlog, 'utf8')}- parent: epic\n`);

  ledgers(h, 'upsert', backlog);

  const [entry] = registry(h);
  assert.deepEqual(Object.keys(entry ?? {}), ['repo', 'slug', 'path', 'branch', 'parent', 'status', 'main', 'created', 'updated']);
  assert.equal(entry?.parent, 'epic');
});

test('upsert reads a parent in another repository as its slug and parentMain, and a parent here has no parentMain', (t) => {
  const h = home(t);
  const child = ledgerIn(path.join(h, 'issues/child'), 'child', withParent('epic @ /work/app'));
  const local = ledgerIn(path.join(h, 'issues/local'), 'local', withParent('epic'));

  ledgers(h, 'upsert', child, local);

  const bySlug = Object.fromEntries(registry(h).map((entry) => [entry.slug, entry]));
  assert.deepEqual(Object.keys(bySlug.child ?? {}), ['repo', 'slug', 'path', 'branch', 'parent', 'parentMain', 'status', 'created', 'updated']);
  assert.deepEqual({ parent: bySlug.child?.parent, parentMain: bySlug.child?.parentMain }, { parent: 'epic', parentMain: '/work/app' });
  assert.equal(bySlug.local?.parent, 'epic');
  assert.equal(Object.hasOwn(bySlug.local ?? {}, 'parentMain'), false);
});

test('upsert takes a parent in another repository from --parent <slug>@<main>', (t) => {
  const h = home(t);
  const ledger = ledgerIn(path.join(h, 'issues/child'), 'child');

  ledgers(h, 'upsert', ledger, '--parent', 'epic@/work/app');

  assert.deepEqual(registry(h).map(({ parent, parentMain }) => ({ parent, parentMain })), [{ parent: 'epic', parentMain: '/work/app' }]);
});

test('upsert of a backlog ledger takes the parent from --parent before its Location section', (t) => {
  const h = home(t);
  const backlog = backlogLedger(h, 'app', 'fix-login', '/work/app');
  writeFileSync(backlog, `${readFileSync(backlog, 'utf8')}- parent: epic\n`);

  ledgers(h, 'upsert', backlog, '--parent', 'other');

  assert.deepEqual(registry(h).map(({ status, parent }) => ({ status, parent })), [{ status: 'backlog', parent: 'other' }]);
});

test('archive keeps the parent of the active entry', (t) => {
  const h = home(t);
  const ledger = ledgerIn(path.join(h, 'issues/child'), 'child', withParent('epic'));
  ledgers(h, 'upsert', ledger);
  const copy = archiveCopy(h, 'child', '2026-10-20-child.md', readFileSync(ledger, 'utf8'));

  ledgers(h, 'archive', ledger, copy);

  assert.deepEqual(registry(h).map(({ status, parent }) => ({ status, parent })), [{ status: 'archived', parent: 'epic' }]);
});

test('archive keeps the parentMain of an active entry whose parent is in another repository', (t) => {
  const h = home(t);
  const ledger = ledgerIn(path.join(h, 'issues/child'), 'child', withParent('epic @ /work/app'));
  ledgers(h, 'upsert', ledger);
  const copy = archiveCopy(h, 'child', '2026-10-20-child.md', readFileSync(ledger, 'utf8'));

  ledgers(h, 'archive', ledger, copy);

  assert.deepEqual(
    registry(h).map(({ status, parent, parentMain }) => ({ status, parent, parentMain })),
    [{ status: 'archived', parent: 'epic', parentMain: '/work/app' }],
  );
});

test('archive with no entry takes the parent from the archive copy', (t) => {
  const h = home(t);
  const copy = archiveCopy(h, 'app', '2026-10-20-child.md', `# Task ledger — child\n${withParent('epic')}`);

  ledgers(h, 'archive', '/given/.claude/ledger.md', copy);

  assert.equal(registry(h)[0]?.parent, 'epic');
});

test('scan rebuilds the parent of active and archived entries', (t) => {
  const h = home(t);
  ledgerIn(path.join(h, 'repos/app/child'), 'child', withParent('epic'));
  ledgerIn(path.join(h, 'repos/app/epic'), 'epic');
  archiveCopy(h, 'app', '2026-10-01-old-child.md', `# Task ledger — old-child\n${withParent('epic')}`);

  ledgers(h, 'scan');

  const entries = registry(h);
  assert.deepEqual(
    entries.map(({ slug, status, parent }) => ({ slug, status, parent })).sort((a, b) => a.slug.localeCompare(b.slug)),
    [
      { slug: 'child', status: 'active', parent: 'epic' },
      { slug: 'epic', status: 'active', parent: undefined },
      { slug: 'old-child', status: 'archived', parent: 'epic' },
    ],
  );
  assert.equal(Object.hasOwn(entries.find((entry) => entry.slug === 'epic') ?? {}, 'parent'), false);
});
