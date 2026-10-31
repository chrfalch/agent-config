import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { freshHome, REPO } from './helpers.js';
import type { Mod } from '../tools/ledger-cli/hooks.js';
import { table, truncate } from '../tools/ledger-cli/table.js';
import { parentView } from '../tools/ledger-cli/views.js';
import { loadHooks, nodeEngine, type Engine } from '../tools/lib/node-engine.js';

const LEDGER = path.join(REPO, 'bin/ledger');
const COMMANDS = ['all', 'archive', 'parent', 'worktrees'] as const;

type Ran = { status: number | null; stdout: string; stderr: string };

function spawn(home: string, cwd: string, command: string, args: string[]): Ran {
  // gh fails the way it does when it is missing or logged out, so no test depends on GitHub.
  const stubs = path.join(home, 'stub-bin');
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, HOME: home, NO_COLOR: '1', PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ''}`, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ledger(home: string, cwd: string, ...args: string[]): Ran {
  const ran = spawn(home, cwd, LEDGER, args);
  assert.doesNotMatch(ran.stdout + ran.stderr, /\/ledger:/, 'the terminal tool names its own commands, not the plugin commands');
  return ran;
}

function ok(ran: Ran): string {
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}

function script(home: string, cwd: string, name: string, ...args: string[]): void {
  const ran = spawn(home, cwd, path.join(REPO, 'bin', name), args);
  assert.equal(ran.status, 0, ran.stderr);
}

function git(home: string, directory: string, ...args: string[]): void {
  const ran = spawn(home, directory, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  assert.equal(ran.status, 0, ran.stderr);
}

// realpath, because git reports a tmpdir under /var as /private/var.
function home(t: TestContext): string {
  const folder = realpathSync(freshHome(t));
  const stubs = path.join(folder, 'stub-bin');
  mkdirSync(stubs);
  writeFileSync(path.join(stubs, 'gh'), '#!/bin/sh\necho "gh: not logged in" >&2\nexit 4\n');
  chmodSync(path.join(stubs, 'gh'), 0o755);
  return folder;
}

function ledgerText(slug: string, worktree: string, goal: string): string {
  return [
    `# Task ledger — ${slug}`,
    '',
    '## Goal',
    goal,
    '',
    '## Location',
    `- worktree: ${worktree}`,
    `- branch: me/${slug}`,
    '- base: main @ abc1234',
    '',
    '## Next step',
    `Next step of ${slug}.`,
    '',
  ].join('\n');
}

/** A main checkout at ~/repos/app with a registered parent task and child task, each in its own linked worktree. */
function repository(t: TestContext) {
  const h = home(t);
  const main = path.join(h, 'repos/app');
  mkdirSync(main, { recursive: true });
  git(h, main, 'init', '--quiet', '-b', 'main');
  git(h, main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  const worktrees: Record<string, string> = {};
  for (const slug of ['parent-task', 'child-task']) {
    const worktree = path.join(main, '.claude/worktrees', slug);
    git(h, main, 'worktree', 'add', '--quiet', '-b', `me/${slug}`, worktree);
    mkdirSync(path.join(worktree, '.claude'));
    writeFileSync(path.join(worktree, '.claude/ledger.md'), ledgerText(slug, worktree, `Goal of ${slug}.`));
    worktrees[slug] = worktree;
  }
  script(h, main, 'cc-ledger-parent', 'add', 'parent-task', 'child-task');
  script(h, main, 'cc-ledgers', 'upsert', ...Object.values(worktrees).map(worktree => path.join(worktree, '.claude/ledger.md')));
  return { home: h, main, worktrees };
}

function backlogTask(home: string, main: string, slug: string): void {
  const file = path.join(home, '.claude/ledger-backlog/app', `${slug}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# Task ledger — ${slug}\n\n## Goal\nGoal of ${slug}.\n\n## Location\n- main: ${main}\n- worktree: <path>\n- branch: me/${slug}\n- base: <branch/commit>\n`);
  script(home, main, 'cc-ledgers', 'upsert', file);
}

function archived(home: string, repo: string, name: string, goal: string): void {
  const file = path.join(home, '.claude/ledger-archive', repo, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ledgerText(name.replace(/^\d{4}-\d\d-\d\d-|\.md$/g, ''), '/gone', goal));
}

const lineWith = (output: string, text: string): string => output.split('\n').find(line => line.includes(text)) ?? assert.fail(`no line contains "${text}" in:\n${output}`);

const rowOf = (output: string, name: string): string =>
  output.split('\n').find(line => line.startsWith(`${name} `)) ?? assert.fail(`no row starts with "${name}" in:\n${output}`);

test('ledger --help lists the five commands', (t) => {
  const stdout = ok(ledger(home(t), REPO, '--help'));
  assert.match(stdout, /^Usage: ledger /m);
  for (const command of [...COMMANDS, 'help']) assert.match(stdout, new RegExp(`^\\s+${command}\\b`, 'm'), `--help lists ${command}`);
});

test('ledger <command> --help shows the usage of that command', (t) => {
  const h = home(t);
  const expected: Record<(typeof COMMANDS)[number], RegExp> = {
    all: /--scan/,
    archive: /\[term\][\s\S]*--all/,
    parent: /\[slug\]/,
    worktrees: /Usage: ledger worktrees/,
  };
  for (const command of COMMANDS) {
    const stdout = ok(ledger(h, REPO, command, '--help'));
    assert.match(stdout, new RegExp(`^Usage: ledger ${command}\\b`, 'm'));
    assert.match(stdout, expected[command]);
  }
  assert.match(ok(ledger(h, REPO, 'help', 'archive')), /^Usage: ledger archive\b/m);
});

test('an unknown command exits non-zero and names the command', (t) => {
  const ran = ledger(home(t), REPO, 'nope');
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /nope/);
});

test('an unknown option exits non-zero', (t) => {
  const ran = ledger(home(t), REPO, 'all', '--nope');
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /--nope/);
});

test('ledger all lists the registered tasks, children under their parent, and the backlog', (t) => {
  const { home: h, main } = repository(t);
  backlogTask(h, main, 'later-task');
  const stdout = ok(ledger(h, h, 'all'));
  assert.doesNotMatch(stdout, /\x1b\[/, 'NO_COLOR and a pipe leave no escape codes');
  assert.match(stdout, /All task ledgers · 3 tasks, 2 active, 1 backlog/);
  assert.match(lineWith(stdout, 'parent-task'), /app\s+parent-task\s+active\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+Next step of parent-task\./);
  assert.match(lineWith(stdout, 'child-task'), /↳ child-task\s+active\s+.*Next step of child-task\./);
  assert.ok(stdout.indexOf('parent-task') < stdout.indexOf('child-task'), 'the child comes after its parent');
  const backlog = stdout.slice(stdout.indexOf('Backlog'));
  assert.match(lineWith(backlog, 'later-task'), /app\s+later-task\s+.*Goal of later-task\./);
});

test('ledger all lines up its columns', (t) => {
  const { home: h } = repository(t);
  const stdout = ok(ledger(h, h, 'all'));
  const header = lineWith(stdout, 'status');
  const status = header.indexOf('status');
  assert.equal(lineWith(stdout, 'parent-task').indexOf('active'), status);
  assert.equal(lineWith(stdout, 'child-task').indexOf('active'), status);
});

test('ledger all without a registry tells how to rebuild it', (t) => {
  const h = home(t);
  const stdout = ok(ledger(h, h, 'all'));
  assert.match(stdout, /No ledgers registered\. Run `?ledger all --scan`? to rebuild from disk\./);
});

test('ledger all --scan rebuilds the registry from disk and says so', (t) => {
  const { home: h } = repository(t);
  const registry = path.join(h, '.claude/ledgers.json');
  rmSync(registry);
  assert.equal(existsSync(registry), false);
  const ran = ledger(h, h, 'all', '--scan');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout + ran.stderr, /rebuilt .*ledgers\.json: 2 active, 0 archived/);
  assert.match(ran.stdout, /All task ledgers · 2 tasks, 2 active/);
  assert.equal(existsSync(registry), true);
});

test("ledger archive lists this repo's archived ledgers, newest first", (t) => {
  const { home: h, main } = repository(t);
  archived(h, 'app', '2026-10-01-old-task.md', 'Fix the login screen.');
  archived(h, 'app', '2026-10-05-newer-task.md', 'Speed up the build.');
  archived(h, 'web', '2026-09-01-web-task.md', 'Fix the login page.');
  const stdout = ok(ledger(h, main, 'archive'));
  assert.match(stdout, /Archived ledgers · app · 2 ledgers, newest first/);
  assert.match(lineWith(stdout, 'newer-task'), /2026-10-05\s+newer-task\s+me\/newer-task\s+Speed up the build\./);
  assert.ok(stdout.indexOf('newer-task') < stdout.indexOf('old-task'));
  assert.doesNotMatch(stdout, /web-task/);
});

test('ledger archive <term> keeps the ledgers that contain the term, and shows the matching line', (t) => {
  const { home: h, main } = repository(t);
  archived(h, 'app', '2026-10-01-old-task.md', 'Fix the login screen.');
  archived(h, 'app', '2026-10-05-newer-task.md', 'Speed up the build.');
  const stdout = ok(ledger(h, main, 'archive', 'LOGIN'));
  assert.match(stdout, /1 ledger that contains "LOGIN"/);
  assert.match(lineWith(stdout, 'old-task'), /Fix the login screen\./);
  assert.doesNotMatch(stdout, /newer-task/);
});

test('ledger archive --all lists every repo and names the repo of each ledger', (t) => {
  const { home: h, main } = repository(t);
  archived(h, 'app', '2026-10-01-old-task.md', 'Fix the login screen.');
  archived(h, 'web', '2026-09-01-web-task.md', 'Fix the login page.');
  const stdout = ok(ledger(h, main, 'archive', '--all'));
  assert.match(stdout, /Archived ledgers · every repo · 2 ledgers, newest first/);
  assert.match(lineWith(stdout, 'old-task'), /2026-10-01\s+app\s+old-task/);
  assert.match(lineWith(stdout, 'web-task'), /2026-09-01\s+web\s+web-task/);
});

test('ledger archive says so when nothing is archived or nothing matches', (t) => {
  const { home: h, main } = repository(t);
  assert.match(ok(ledger(h, main, 'archive')), /No archived ledgers in ~\/\.claude\/ledger-archive\/app\/\./);
  archived(h, 'app', '2026-10-01-old-task.md', 'Fix the login screen.');
  assert.match(ok(ledger(h, main, 'archive', 'missing')), /No archived ledger in ~\/\.claude\/ledger-archive\/app\/ contains "missing"\./);
});

test('ledger archive outside a git repository fails and suggests --all', (t) => {
  const h = home(t);
  const ran = ledger(h, h, 'archive');
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /Could not tell which repo .* is in\..*--all/);
});

test('ledger parent <slug> shows the parent task and its children', (t) => {
  const { home: h, main } = repository(t);
  const stdout = ok(ledger(h, main, 'parent', 'parent-task'));
  assert.match(stdout, /Parent task parent-task · 1 child, 1 active/);
  assert.match(stdout, /Goal of parent-task\./);
  assert.match(lineWith(stdout, 'child-task'), /child-task\s+active\s+Next step of child-task\./);
});

test("ledger parent without a slug shows the family of the folder's own task", (t) => {
  const { home: h, worktrees } = repository(t);
  const stdout = ok(ledger(h, worktrees['child-task'] ?? '', 'parent'));
  assert.match(stdout, /Parent task parent-task · 1 child, 1 active/);
});

test('ledger parent without a slug, outside any family, exits non-zero and asks for a slug', (t) => {
  const { home: h, main } = repository(t);
  const ran = ledger(h, main, 'parent');
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /ledger parent <slug>/);
});

test('ledger parent of an unknown slug fails with the reason', (t) => {
  const { home: h, main } = repository(t);
  const ran = ledger(h, main, 'parent', 'no-such-task');
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /Could not show no-such-task\./);
});

test('ledger worktrees shows a row per linked worktree, and a PR of ? when gh fails', (t) => {
  const { home: h, main } = repository(t);
  const stdout = ok(ledger(h, main, 'worktrees'));
  assert.match(stdout, /Worktrees · 2 worktrees, largest first · \d+\.\d GB total/);
  assert.match(rowOf(stdout, 'parent-task'), /parent-task\s+\d+\.\d\s+\d\d-\d\d\s+\d+\s+parent of 1\s+\?/);
  assert.match(rowOf(stdout, 'child-task'), /child-task\s+.*child of parent-task\s+\?/);
  assert.match(stdout, /PR is \? because gh pr list failed \(exit 4\): gh: not logged in/);
});

test('ledger worktrees outside a git repository fails with the reason', (t) => {
  const h = home(t);
  const ran = ledger(h, h, 'worktrees');
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /Could not list worktrees\./);
});

function colorRun(h: string, overrides: NodeJS.ProcessEnv): Ran {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: h, CI: '1', GIT_CONFIG_GLOBAL: path.join(h, '.gitconfig') };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const result = spawnSync(LEDGER, ['all'], {
    cwd: h,
    env: { ...env, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('ledger emits no ANSI when CI stdout is piped without color overrides', (t) => {
  assert.doesNotMatch(ok(colorRun(home(t), {})), /\x1b/);
});

test('ledger honors FORCE_COLOR when piped and NO_COLOR is set', (t) => {
  const { home: h } = repository(t);
  const stdout = ok(colorRun(h, { FORCE_COLOR: '1', NO_COLOR: '1' }));
  assert.match(stdout, /\x1b/);
  const plain = stripVTControlCharacters(stdout);
  const status = lineWith(plain, 'status').indexOf('status');
  assert.equal(lineWith(plain, 'parent-task').indexOf('active'), status);
  assert.equal(lineWith(plain, 'child-task').indexOf('active'), status);
});

test('ledger treats zero and empty FORCE_COLOR as unforced on a pipe', (t) => {
  const h = home(t);
  for (const FORCE_COLOR of ['0', '']) assert.doesNotMatch(ok(colorRun(h, { FORCE_COLOR })), /\x1b/);
});

for (const { name, env, isTTY, expected } of [
  { name: 'TTY with NO_COLOR', env: { NO_COLOR: '1' }, isTTY: true, expected: false },
  { name: 'TTY without color overrides', env: {}, isTTY: true, expected: true },
  { name: 'pipe', env: {}, isTTY: false, expected: false },
  { name: 'pipe with FORCE_COLOR', env: { FORCE_COLOR: '1' }, isTTY: false, expected: false },
]) {
  test(`spinner policy: ${name}`, async () => {
    const { showSpinner } = await import('../tools/ledger-cli/colors.js');
    assert.equal(showSpinner(env, isTTY), expected);
  });
}

const displayWidth = (text: string): number => [...stripVTControlCharacters(text)
  .replaceAll('👩🏽‍💻', 'xx')
  .replaceAll('🇳🇴', 'xx')
  .replace(/[東京ＡＢ😀]/gu, 'xx')
  .replace(/[\u0301\u200b]/gu, '')].length;

test('table pads CJK, fullwidth, emoji, combining and zero-width text by display columns', () => {
  const lines = table(['name', 'end'], ['東京', 'abcd', '😀', 'ＡＢ', 'e\u0301', 'a\u200bb', '👩🏽‍💻', '🇳🇴'].map(text => [text, '|']));
  for (const line of lines.slice(1)) assert.equal(displayWidth(line.split('|')[0] ?? ''), 6, line);
});

test('truncate keeps emoji surrogates intact within the display width limit', () => {
  const text = '😀'.repeat(8);
  for (const limit of [0, 1, 2, 3, 4, 5, 8, 16]) {
    const result = truncate(text, limit);
    assert.doesNotMatch(result, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    assert.ok(displayWidth(result) <= limit, `${JSON.stringify(result)} exceeds ${limit} columns`);
  }
});

test('truncate preserves whole grapheme clusters', () => {
  for (const cluster of ['e\u0301', '👩🏽‍💻', '🇳🇴']) {
    const text = cluster.repeat(8);
    for (const limit of [1, 2, 3, 4, 5]) {
      const result = truncate(text, limit);
      assert.ok(displayWidth(result) <= limit);
      assert.ok(new RegExp(`^(?:${cluster})*…$`, 'u').test(result), JSON.stringify(result));
    }
  }
});

test('parent next steps use the overview text width', () => {
  const stdout = parentView({ parent: 'parent', goal: '', children: [{ slug: 'child', status: 'active', next: 'x'.repeat(100) }] });
  const row = stripVTControlCharacters(lineWith(stdout, 'child '));
  const next = row.split(/ {2,}/)[2] ?? assert.fail('missing next cell');
  assert.equal(next, `${'x'.repeat(79)}…`);
});

test('loaded hooks retain every copied row field', async (t) => {
  const { home: h, main, worktrees } = repository(t);
  backlogTask(h, main, 'later-task');
  archived(h, 'app', '2026-10-01-old-task.md', 'Fixture goal.');
  const $: Engine = {
    ...nodeEngine(main),
    env: { get: async name => name === 'HOME' ? h : process.env[name] },
    process: {
      run: async ([command = '', ...args], init) => {
        const ran = spawn(h, init?.cwd ?? main, command, args);
        return { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr, isStdoutTruncated: false, isStderrTruncated: false };
      },
    },
  };
  const { MOD_EXPORTS } = await import('../tools/ledger-cli/hooks.js');
  const mod = await loadHooks<Mod>(['all-command', 'archive', 'archive-command', 'parent-command', 'worktrees-command'], MOD_EXPORTS);
  const registry = await mod.readRegistry($, false);
  if ('error' in registry) assert.fail(registry.error);
  assert.equal(registry.entries.length, 3);
  for (const entry of registry.entries) {
    for (const field of ['repo', 'slug', 'status', 'updated', 'path', 'main']) assert.ok(Object.hasOwn(entry, field), field);
  }
  const child = registry.entries.find(entry => entry.slug === 'child-task') ?? assert.fail('missing child entry');
  assert.ok(Object.hasOwn(child, 'parent'));
  const overview = await mod.overview($, registry.entries);
  for (const field of ['tasks', 'backlog']) assert.ok(Object.hasOwn(overview, field), field);
  assert.equal(overview.tasks.length, 2);
  for (const row of overview.tasks) {
    for (const field of ['entry', 'name', 'status', 'next']) assert.ok(Object.hasOwn(row, field), field);
  }
  assert.equal(overview.backlog.length, 1);
  for (const row of overview.backlog) {
    for (const field of ['entry', 'name', 'goal']) assert.ok(Object.hasOwn(row, field), field);
  }
  const shown = await mod.familyToShow($, 'parent-task');
  if ('error' in shown) assert.fail(shown.error);
  if ('none' in shown) assert.fail('missing parent family');
  for (const field of ['parent', 'goal', 'children']) assert.ok(Object.hasOwn(shown, field), field);
  assert.equal(shown.children.length, 1);
  for (const child of shown.children) {
    for (const field of ['slug', 'status', 'next']) assert.ok(Object.hasOwn(child, field), field);
  }
  const linked = Object.entries(worktrees).map(([slug, path]) => ({ path, branch: `me/${slug}` }));
  const { rows } = await mod.worktreeRows($, linked, main);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    for (const field of ['name', 'sizeGb', 'lastCommit', 'dirty', 'hasLedger', 'ledgerRole', 'pr']) assert.ok(Object.hasOwn(row, field), field);
  }
  const archive = await mod.readArchive($, { term: 'Fixture', all: false });
  if ('error' in archive) assert.fail(archive.error);
  for (const field of ['repo', 'ledgers']) assert.ok(Object.hasOwn(archive, field), field);
  assert.equal(archive.ledgers.length, 1);
  for (const ledger of archive.ledgers) {
    for (const field of ['repo', 'date', 'slug', 'branch', 'goal', 'mtimeMs', 'match']) assert.ok(Object.hasOwn(ledger, field), field);
  }
});
