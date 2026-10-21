import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import vm from 'node:vm';
import { freshHome, REPO, run } from './helpers.js';

const LAUNCHER = path.join(REPO, 'bin/cc-ledger-dashboard');
const CC_LEDGERS = path.join(REPO, 'bin/cc-ledgers');

type Row = { id: string; repo: string; slug: string; status: string; updated: string; next: string; branch: string };
type Listed = { ledgers: Row[]; repos: string[]; statuses: string[] };
type Detail = {
  id: string;
  repo: string;
  slug: string;
  status: string;
  html: string;
  path: string;
  worktree: string;
  worktreeExists: boolean;
  branch: string;
  prs: { state: string; number: number }[] | null;
  go: string | null;
};
type Preview = { text: string; blockers: string[]; token: string };
type Retired = { retired: boolean; text: string };
type Recorded = { pid: number; port: number; key: string; url: string; started: string };

const FIX_LOGIN = `# Task ledger — fix-login

## Goal
Fix the **login** crash on \`iOS\`.

## Plan
| # | step | status |
|---|------|--------|
| 1 | Reproduce | done |
| 2 | Fix the token refresh | in progress |

## Notes
- <script>alert(1)</script>
- a & b

\`\`\`
if (a < b) **not bold**
\`\`\`

## Next step
Write the failing test for the token refresh.
`;

const WAITING = `# Task ledger — waiting

## Goal
Redo the settings screen.

## Next step
Parked: 2026-10-10 — waiting on design
Ask design for the mockups.
`;

const WEB_FIX_LOGIN = `# Task ledger — fix-login

## Goal
Fix the web login form, the Zebracorn one.

## Next step
Ship the form.
`;

const OLD_TASK = `# Task ledger — old-task

## Goal
An old goal.

## Next step
Nothing left.
`;

function git(home: string, directory: string, ...args: string[]): void {
  const result = run(home, ['git', '-C', directory, '-c', 'user.name=test', '-c', 'user.email=test@example.com'], ...args);
  assert.equal(result.status, 0, result.stderr);
}

function checkout(home: string, folder: string): string {
  mkdirSync(folder, { recursive: true });
  git(home, folder, 'init', '--quiet', '-b', 'main');
  writeFileSync(path.join(folder, 'file.txt'), 'one\n');
  git(home, folder, 'add', 'file.txt');
  git(home, folder, 'commit', '--quiet', '-m', 'first');
  // info/exclude is shared by every worktree, so the untracked ledgers do not count as changes.
  writeFileSync(path.join(folder, '.git/info/exclude'), '.claude/\n');
  return folder;
}

function worktreeWithLedger(home: string, main: string, folder: string, branch: string, ledger: string): string {
  const worktree = path.join(main, '.claude/worktrees', folder);
  git(home, main, 'worktree', 'add', '--quiet', '-b', branch, worktree);
  mkdirSync(path.join(worktree, '.claude'));
  writeFileSync(path.join(worktree, '.claude/ledger.md'), ledger);
  return worktree;
}

// gh answers every `pr list --state all` with one open PR, and every other `pr list` with none.
function ghStub(home: string): string {
  const bin = path.join(home, 'stub-bin');
  mkdirSync(bin);
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'pr' || args[1] !== 'list') { console.error('stub gh: unexpected ' + args.join(' ')); process.exit(1); }
console.log(args[args.indexOf('--state') + 1] === 'all' ? '[{"state":"OPEN","number":7}]' : '[]');
`;
  writeFileSync(path.join(bin, 'gh'), script, { mode: 0o755 });
  return bin;
}

function fixture(t: TestContext) {
  // realpath, because git reports a tmpdir under /var as /private/var.
  const home = realpathSync(freshHome(t));
  const app = checkout(home, path.join(home, 'repos/app'));
  const fixLogin = worktreeWithLedger(home, app, 'fix-login', 'me/fix-login', FIX_LOGIN);
  const waiting = worktreeWithLedger(home, app, 'waiting', 'me/waiting', WAITING);
  const web = checkout(home, path.join(home, 'repos/web'));
  const webFixLogin = worktreeWithLedger(home, web, 'fix-login', 'me/fix-login', WEB_FIX_LOGIN);
  const archive = path.join(home, '.claude/ledger-archive/app');
  mkdirSync(archive, { recursive: true });
  const oldTask = path.join(archive, '2026-10-01-old-task.md');
  writeFileSync(oldTask, OLD_TASK);
  const scanned = run(home, [CC_LEDGERS], 'scan');
  assert.equal(scanned.status, 0, scanned.stderr);
  return { home, app, fixLogin, waiting, webFixLogin, oldTask, stubBin: ghStub(home) };
}

const env = (home: string, stubBin = '') => ({
  ...process.env,
  HOME: home,
  PATH: [stubBin, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
  GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
});

type Server = { port: number; key: string; child: ChildProcess };

const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)\/#key=([A-Za-z0-9_-]+)/;

async function startForeground(t: TestContext, home: string, stubBin: string): Promise<Server> {
  const child = spawn(LAUNCHER, ['--foreground', '--port', '0'], { cwd: REPO, env: env(home, stubBin), stdio: ['ignore', 'pipe', 'pipe'] });
  // 'close' never comes when the spawn itself fails, and 'error' comes instead.
  const ended = new Promise<string>(resolve => {
    child.once('close', code => resolve(`exited (${code})`));
    child.once('error', error => resolve(error.message));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await ended;
  });
  let stdout = '';
  let stderr = '';
  child.stderr?.on('data', chunk => (stderr += chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL within 20 s. stdout: ${stdout} stderr: ${stderr}`)), 20_000);
    child.stdout?.on('data', chunk => {
      stdout += chunk;
      const match = URL_LINE.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), key: match[2] ?? '', child });
      }
    });
    void ended.then(how => {
      clearTimeout(timer);
      reject(new Error(`server ${how}. stdout: ${stdout} stderr: ${stderr}`));
    });
  });
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string };

type RequestOptions = { key?: string | null; host?: string; body?: unknown; contentType?: string };

function request({ port, key }: { port: number; key: string }, method: string, pathname: string, options: RequestOptions = {}): Promise<Reply> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${port}` };
  const sentKey = options.key === undefined ? key : options.key;
  if (sentKey !== null) headers['x-ledger-key'] = sentKey;
  if (body !== undefined) headers['content-type'] = options.contentType ?? 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function json<T>(server: Server, method: string, pathname: string, body?: unknown): Promise<{ status: number; value: T }> {
  const reply = await request(server, method, pathname, { body });
  return { status: reply.status, value: JSON.parse(reply.text) as T };
}

const list = async (server: Server, query = ''): Promise<Listed> => {
  const { status, value } = await json<Listed>(server, 'GET', `/api/ledgers${query}`);
  assert.equal(status, 200);
  return value;
};

const keys = (rows: Row[]): string[] => rows.map(row => `${row.repo}/${row.slug}/${row.status}`).sort();

const ledgerOf = (worktree: string): string => path.join(worktree, '.claude/ledger.md');

const detailOf = (id: string): string => `/api/ledger?${new URLSearchParams({ id })}`;

async function preview(server: Server, id: string): Promise<Preview> {
  const { status, value } = await json<Preview>(server, 'POST', '/api/retire/preview', { id });
  assert.equal(status, 200, JSON.stringify(value));
  return value;
}

test('an /api request without the key, or with a wrong one, gets 401', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  assert.equal((await request(server, 'GET', '/api/ledgers', { key: null })).status, 401);
  assert.equal((await request(server, 'GET', '/api/ledgers', { key: 'x'.repeat(server.key.length) })).status, 401);
  assert.equal((await request(server, 'GET', '/api/health', { key: 'short' })).status, 401);
  assert.equal((await request(server, 'POST', '/api/park', { key: null, body: { id: ledgerOf(fixLogin), reason: 'x' } })).status, 401);
  assert.equal((await request(server, 'GET', '/api/health')).status, 200);
});

test('a request with a foreign Host header gets 403, even with the key', async t => {
  const { home, stubBin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  for (const host of ['evil.example', `evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`, '127.0.0.1']) {
    assert.equal((await request(server, 'GET', '/api/ledgers', { host })).status, 403, host);
    assert.equal((await request(server, 'GET', '/', { host })).status, 403, host);
  }
  assert.equal((await request(server, 'GET', '/api/health', { host: `localhost:${server.port}` })).status, 200);
});

test('the page holds no ledger data and sends no CORS headers', async t => {
  const { home, stubBin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const page = await request(server, 'GET', '/', { key: null });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'] ?? '', /^text\/html/);
  assert.doesNotMatch(page.text, /fix-login|waiting|old-task/);
  const api = await request(server, 'GET', '/api/ledgers');
  for (const reply of [page, api]) {
    assert.deepEqual(Object.keys(reply.headers).filter(name => name.startsWith('access-control-')), []);
  }
});

test('actions take POST with a JSON body only', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const body = { id: ledgerOf(fixLogin), reason: 'later' };
  assert.equal((await request(server, 'POST', '/api/park', { body, contentType: 'text/plain' })).status, 415);
  assert.equal((await request(server, 'POST', '/api/park', { body, contentType: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await request(server, 'GET', `/api/park?${new URLSearchParams(body)}`)).status, 405);
  assert.equal((await request(server, 'POST', '/api/ledgers', { body: {} })).status, 405);
  assert.doesNotMatch(readFileSync(ledgerOf(fixLogin), 'utf8'), /Parked:/);
});

test('the list holds every registered ledger with its status and next step, and the filter values from the data', async t => {
  const { home, stubBin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const { ledgers, repos, statuses } = await list(server);
  assert.deepEqual(keys(ledgers), ['app/fix-login/active', 'app/old-task/archived', 'app/waiting/parked', 'web/fix-login/active']);
  const next = Object.fromEntries(ledgers.map(row => [`${row.repo}/${row.slug}`, row.next]));
  assert.equal(next['app/fix-login'], 'Write the failing test for the token refresh.');
  assert.equal(next['app/waiting'], 'Ask design for the mockups.');
  assert.equal(next['app/old-task'], 'Nothing left.');
  assert.deepEqual(repos, ['app', 'web']);
  assert.deepEqual(statuses, ['active', 'archived', 'parked']);
});

test('a status the dashboard has never seen appears as a filter value and filters', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const registry = path.join(home, '.claude/ledgers.json');
  const entries: { path: string; status: string }[] = JSON.parse(readFileSync(registry, 'utf8'));
  const ledger = path.join(fixLogin, '.claude/ledger.md');
  writeFileSync(registry, JSON.stringify(entries.map(entry => (entry.path === ledger ? { ...entry, status: 'backlog' } : entry))));
  const server = await startForeground(t, home, stubBin);
  assert.ok((await list(server)).statuses.includes('backlog'));
  assert.deepEqual(keys((await list(server, '?status=backlog')).ledgers), ['app/fix-login/backlog']);
});

test('the repo, status and search filters narrow the list and keep every filter value', async t => {
  const { home, stubBin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const web = await list(server, '?repo=web');
  assert.deepEqual(keys(web.ledgers), ['web/fix-login/active']);
  assert.deepEqual(web.repos, ['app', 'web']);
  assert.deepEqual(keys((await list(server, '?status=parked')).ledgers), ['app/waiting/parked']);
  assert.deepEqual(keys((await list(server, '?repo=app&status=active')).ledgers), ['app/fix-login/active']);
  assert.deepEqual(keys((await list(server, '?q=ZEBRACORN')).ledgers), ['web/fix-login/active']);
  assert.deepEqual(keys((await list(server, `?q=${encodeURIComponent('token REFRESH')}`)).ledgers), ['app/fix-login/active']);
  assert.deepEqual(keys((await list(server, '?q=nothing-has-this')).ledgers), []);
});

test('the detail renders the ledger as escaped Markdown with its worktree, branch, PRs and go command', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const { status, value } = await json<Detail>(server, 'GET', detailOf(ledgerOf(fixLogin)));
  assert.equal(status, 200);
  assert.equal(value.id, ledgerOf(fixLogin));
  assert.equal(value.path, ledgerOf(fixLogin));
  assert.equal(value.worktree, fixLogin);
  assert.equal(value.branch, 'me/fix-login');
  assert.deepEqual(value.prs, [{ state: 'OPEN', number: 7 }]);
  assert.equal(value.go, 'go fix-login');
  const { html } = value;
  assert.match(html, /<h1>Task ledger — fix-login<\/h1>/);
  assert.match(html, /<h2>Goal<\/h2>/);
  assert.match(html, /Fix the <strong>login<\/strong> crash on <code>iOS<\/code>\./);
  assert.match(html, /<table>[\s\S]*<th>step<\/th>[\s\S]*<td>Fix the token refresh<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<ul>\s*<li>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/li>\s*<li>a &amp; b<\/li>\s*<\/ul>/);
  assert.match(html, /<pre><code>if \(a &lt; b\) \*\*not bold\*\*<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script/);
});

test('the detail of an archived ledger reads the archive copy and offers no go command', async t => {
  const { home, stubBin, oldTask } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const { status, value } = await json<Detail>(server, 'GET', detailOf(oldTask));
  assert.equal(status, 200);
  assert.equal(value.path, oldTask);
  assert.equal(value.go, null);
  assert.match(value.html, /An old goal\./);
});

test('every row has its own id: the ledger path, or the archive copy for an archived task', async t => {
  const { home, stubBin, fixLogin, waiting, webFixLogin, oldTask } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const ids = Object.fromEntries((await list(server)).ledgers.map(row => [`${row.repo}/${row.slug}`, row.id]));
  assert.deepEqual(ids, {
    'app/fix-login': ledgerOf(fixLogin),
    'app/waiting': ledgerOf(waiting),
    'web/fix-login': ledgerOf(webFixLogin),
    'app/old-task': oldTask,
  });
});

test('two repos with the same name and a task with the same slug stay two rows, each with its own detail and actions', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const otherApp = checkout(home, path.join(home, 'issues/app'));
  const otherFixLogin = worktreeWithLedger(home, otherApp, 'fix-login', 'me/fix-login', WEB_FIX_LOGIN);
  assert.equal(run(home, [CC_LEDGERS], 'scan').status, 0);
  const server = await startForeground(t, home, stubBin);

  const rows = (await list(server, '?repo=app')).ledgers.filter(row => row.slug === 'fix-login');
  assert.deepEqual(rows.map(row => row.id).sort(), [ledgerOf(otherFixLogin), ledgerOf(fixLogin)].sort());
  for (const worktree of [fixLogin, otherFixLogin]) {
    const { status, value } = await json<Detail>(server, 'GET', detailOf(ledgerOf(worktree)));
    assert.equal(status, 200);
    assert.equal(value.path, ledgerOf(worktree));
    assert.equal(value.worktree, worktree);
  }

  assert.equal((await json(server, 'POST', '/api/park', { id: ledgerOf(otherFixLogin), reason: 'later' })).status, 200);
  assert.match(readFileSync(ledgerOf(otherFixLogin), 'utf8'), /Parked: .* — later/);
  assert.equal(readFileSync(ledgerOf(fixLogin), 'utf8'), FIX_LOGIN);
  assert.match((await preview(server, ledgerOf(otherFixLogin))).text, new RegExp(`- worktree: ${otherFixLogin}`));
});

test('an archived row with the slug of an active task opens the archive copy, and takes no action', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  // Its Location names the worktree the active task now uses, so the two registry entries share their path.
  const copy = path.join(home, '.claude/ledger-archive/app/2026-10-02-fix-login.md');
  writeFileSync(copy, `${OLD_TASK.replace('old-task', 'fix-login')}\n## Location\n- worktree: ${fixLogin}\n- branch: me/old-fix-login\n`);
  assert.equal(run(home, [CC_LEDGERS], 'scan').status, 0);
  const server = await startForeground(t, home, stubBin);

  const rows = (await list(server, '?repo=app')).ledgers.filter(row => row.slug === 'fix-login');
  assert.deepEqual(rows.map(row => `${row.status} ${row.id}`).sort(), [`active ${ledgerOf(fixLogin)}`, `archived ${copy}`]);

  const { status, value } = await json<Detail>(server, 'GET', detailOf(copy));
  assert.equal(status, 200);
  assert.equal(value.id, copy);
  assert.equal(value.path, copy);
  assert.equal(value.status, 'archived');
  assert.equal(value.go, null);
  assert.equal(value.worktreeExists, false);
  assert.equal(value.prs, null);
  assert.match(value.html, /An old goal\./);

  for (const [route, body] of [['/api/park', { reason: 'later' }], ['/api/unpark', {}], ['/api/retire/preview', {}]] as const) {
    assert.equal((await request(server, 'POST', route, { body: { id: copy, ...body } })).status, 409, route);
  }
  assert.equal(readFileSync(ledgerOf(fixLogin), 'utf8'), FIX_LOGIN);
});

test('an id that is not a ledger in the registry gets 404, and a missing id 400', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const unregistered = path.join(fixLogin, 'file.txt');
  for (const id of ['/etc/passwd', unregistered, `${ledgerOf(fixLogin)}/..`, 'fix-login']) {
    assert.equal((await request(server, 'GET', detailOf(id))).status, 404, id);
    assert.equal((await request(server, 'POST', '/api/park', { body: { id, reason: 'later' } })).status, 404, id);
    assert.equal((await request(server, 'POST', '/api/retire/preview', { body: { id } })).status, 404, id);
  }
  assert.equal(readFileSync(unregistered, 'utf8'), 'one\n');
  assert.equal((await request(server, 'GET', '/api/ledger')).status, 400);
  assert.equal((await request(server, 'POST', '/api/park', { body: { repo: 'app', slug: 'fix-login', reason: 'later' } })).status, 400);
});

test('park writes the marker with its reason, and unpark removes it', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const ledger = ledgerOf(fixLogin);
  const server = await startForeground(t, home, stubBin);
  const parked = await json<{ text: string }>(server, 'POST', '/api/park', { id: ledger, reason: '  waiting on   the API ' });
  assert.equal(parked.status, 200);
  assert.match(readFileSync(ledger, 'utf8'), /## Next step\nParked: \d{4}-\d\d-\d\d — waiting on the API\nWrite the failing test/);
  assert.deepEqual(keys((await list(server, '?repo=app&status=parked')).ledgers), ['app/fix-login/parked', 'app/waiting/parked']);

  const unparked = await json<{ text: string }>(server, 'POST', '/api/unpark', { id: ledger });
  assert.equal(unparked.status, 200);
  assert.equal(readFileSync(ledger, 'utf8'), FIX_LOGIN);
  assert.equal((await request(server, 'POST', '/api/unpark', { body: { id: ledger } })).status, 409);
});

test('a parked ledger lists as parked, and as active again once unparked', async t => {
  const { home, stubBin, waiting } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  assert.ok(keys((await list(server)).ledgers).includes('app/waiting/parked'));
  assert.equal((await json(server, 'POST', '/api/unpark', { id: ledgerOf(waiting) })).status, 200);
  const { ledgers, statuses } = await list(server);
  assert.ok(keys(ledgers).includes('app/waiting/active'));
  assert.deepEqual(statuses, ['active', 'archived']);
});

test('park refuses an archived ledger and a missing or empty reason, and writes nothing', async t => {
  const { home, stubBin, fixLogin, oldTask } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  assert.equal((await request(server, 'POST', '/api/park', { body: { id: oldTask, reason: 'later' } })).status, 409);
  assert.equal((await request(server, 'POST', '/api/unpark', { body: { id: oldTask } })).status, 409);
  assert.equal((await request(server, 'POST', '/api/park', { body: { id: ledgerOf(fixLogin) } })).status, 400);
  assert.equal((await request(server, 'POST', '/api/park', { body: { id: ledgerOf(fixLogin), reason: '   ' } })).status, 400);
  assert.equal(readFileSync(oldTask, 'utf8'), OLD_TASK);
  assert.equal(readFileSync(ledgerOf(fixLogin), 'utf8'), FIX_LOGIN);
});

test('the retire preview reports the plan and its blockers, and deletes nothing', async t => {
  const { home, stubBin, fixLogin, oldTask } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const value = await preview(server, ledgerOf(fixLogin));
  assert.match(value.text, /^\*\*Retire fix-login\*\* — nothing done yet/);
  assert.match(value.text, new RegExp(`- worktree: ${fixLogin}`));
  assert.deepEqual(value.blockers, ['its branch is not merged']);
  assert.match(value.token, /^[A-Za-z0-9_-]{32,}$/);
  assert.ok(existsSync(ledgerOf(fixLogin)));
  assert.deepEqual(readdirSync(path.join(home, '.claude/ledger-archive/app')), ['2026-10-01-old-task.md']);
  assert.equal((await request(server, 'POST', '/api/retire/preview', { body: { id: oldTask } })).status, 409);
});

test('retire with the token of a preview that needs force, and force, archives the ledger and removes the worktree', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  writeFileSync(path.join(fixLogin, 'file.txt'), 'changed\n');
  const server = await startForeground(t, home, stubBin);

  const { token, blockers } = await preview(server, ledgerOf(fixLogin));
  assert.ok(blockers.some(blocker => /1 uncommitted change/.test(blocker)), blockers.join(', '));
  const forced = await json<Retired>(server, 'POST', '/api/retire', { id: ledgerOf(fixLogin), token, force: true });
  assert.equal(forced.status, 200, forced.value.text);
  assert.equal(forced.value.retired, true);
  assert.match(forced.value.text, /^\*\*Retired fix-login\*\*/);
  assert.doesNotMatch(forced.value.text, /working directory was removed/);
  assert.equal(existsSync(fixLogin), false);
  const archived = readdirSync(path.join(home, '.claude/ledger-archive/app')).filter(name => name.endsWith('-fix-login.md'));
  assert.equal(archived.length, 1);
  assert.equal(readFileSync(path.join(home, '.claude/ledger-archive/app', archived[0] ?? ''), 'utf8'), FIX_LOGIN);
  assert.deepEqual(keys((await list(server, '?repo=app')).ledgers), ['app/fix-login/archived', 'app/old-task/archived', 'app/waiting/parked']);
});

test('retire refuses a ledger retitled since it was registered, and removes no worktree', async t => {
  const { home, stubBin, app, fixLogin } = fixture(t);
  writeFileSync(path.join(fixLogin, '.claude/ledger.md'), FIX_LOGIN.replace('# Task ledger — fix-login', '# Task ledger — fix-login-v2'));
  // Unregistered, and titled with the slug the registry still holds for the retitled ledger.
  const other = worktreeWithLedger(home, app, 'other', 'me/other', '# Task ledger — fix-login\n\n## Goal\nAnother task.\n');
  const server = await startForeground(t, home, stubBin);

  const reply = await json<{ error?: string }>(server, 'POST', '/api/retire/preview', { id: ledgerOf(fixLogin) });
  assert.equal(reply.status, 409);
  assert.match(reply.value.error ?? '', /fix-login-v2/);
  assert.equal((await request(server, 'POST', '/api/retire', { body: { id: ledgerOf(fixLogin), force: true } })).status, 409);
  assert.ok(existsSync(other));
  assert.ok(existsSync(fixLogin));
});

test('retire refuses a ledger retitled after its preview, and removes no worktree', async t => {
  const { home, stubBin, app, fixLogin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const { token } = await preview(server, ledgerOf(fixLogin));
  writeFileSync(ledgerOf(fixLogin), FIX_LOGIN.replace('# Task ledger — fix-login', '# Task ledger — fix-login-v2'));
  const other = worktreeWithLedger(home, app, 'other', 'me/other', '# Task ledger — fix-login\n\n## Goal\nAnother task.\n');

  const reply = await json<{ error?: string }>(server, 'POST', '/api/retire', { id: ledgerOf(fixLogin), token, force: true });
  assert.equal(reply.status, 409);
  assert.match(reply.value.error ?? '', /fix-login-v2/);
  assert.ok(existsSync(other));
  assert.ok(existsSync(fixLogin));
});

test('retire refuses without the token of a preview, or with a token it does not know, and removes nothing', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  await preview(server, ledgerOf(fixLogin));
  for (const token of [undefined, '', 'not-a-token', 42]) {
    const reply = await json<{ error?: string }>(server, 'POST', '/api/retire', { id: ledgerOf(fixLogin), token, force: true });
    assert.equal(reply.status, 409, String(token));
    assert.match(reply.value.error ?? '', /preview/i, String(token));
  }
  assert.ok(existsSync(fixLogin));
});

test('a retire token works for the task and the force of its preview only, and only once', async t => {
  const { home, stubBin, fixLogin, waiting } = fixture(t);
  const server = await startForeground(t, home, stubBin);

  const forOther = await preview(server, ledgerOf(fixLogin));
  const onOther = await json<{ error?: string }>(server, 'POST', '/api/retire', { id: ledgerOf(waiting), token: forOther.token, force: true });
  assert.equal(onOther.status, 409);
  assert.ok(existsSync(waiting));
  const spent = await json<{ error?: string }>(server, 'POST', '/api/retire', { id: ledgerOf(fixLogin), token: forOther.token, force: true });
  assert.equal(spent.status, 409, 'a token is spent by the first retire that names it');
  assert.ok(existsSync(fixLogin));

  // The preview says the branch is not merged, so only a forced retire matches it.
  const withoutForce = await preview(server, ledgerOf(fixLogin));
  assert.equal((await request(server, 'POST', '/api/retire', { body: { id: ledgerOf(fixLogin), token: withoutForce.token, force: false } })).status, 409);
  assert.ok(existsSync(fixLogin));

  const { token } = await preview(server, ledgerOf(fixLogin));
  const retired = await json<Retired>(server, 'POST', '/api/retire', { id: ledgerOf(fixLogin), token, force: true });
  assert.equal(retired.status, 200, retired.value.text);
  assert.equal(existsSync(fixLogin), false);
  assert.equal((await request(server, 'POST', '/api/retire', { body: { id: ledgerOf(fixLogin), token, force: true } })).status, 409);
});

test('retire refuses the token of a preview whose blockers have changed since, so --force cannot remove changes nobody saw', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const { token, blockers } = await preview(server, ledgerOf(fixLogin));
  assert.deepEqual(blockers, ['its branch is not merged']);
  writeFileSync(path.join(fixLogin, 'file.txt'), 'changed after the preview\n');

  const reply = await json<{ error?: string }>(server, 'POST', '/api/retire', { id: ledgerOf(fixLogin), token, force: true });
  assert.equal(reply.status, 409);
  assert.match(reply.value.error ?? '', /changed since the preview/);
  assert.equal(readFileSync(path.join(fixLogin, 'file.txt'), 'utf8'), 'changed after the preview\n');
});

test('retire refuses when the worktree path, a symlink, leads to another folder than at the preview, and removes neither', async t => {
  const { home, stubBin, app, fixLogin } = fixture(t);
  const link = path.join(home, 'links/fix-login');
  mkdirSync(path.dirname(link));
  symlinkSync(fixLogin, link);
  const registry = path.join(home, '.claude/ledgers.json');
  const entries: { path: string }[] = JSON.parse(readFileSync(registry, 'utf8'));
  writeFileSync(registry, JSON.stringify(entries.map(entry => (entry.path === ledgerOf(fixLogin) ? { ...entry, path: ledgerOf(link) } : entry))));
  const server = await startForeground(t, home, stubBin);
  const { token, blockers } = await preview(server, ledgerOf(link));
  assert.deepEqual(blockers, ['its branch is not merged']);

  // The task moves on, and the link now leads to another task that looks the same: titled fix-login, unmerged, clean.
  writeFileSync(ledgerOf(fixLogin), FIX_LOGIN.replace('# Task ledger — fix-login', '# Task ledger — fix-login-old'));
  const other = worktreeWithLedger(home, app, 'other', 'me/other', '# Task ledger — fix-login\n\n## Goal\nAnother task.\n');
  rmSync(link);
  symlinkSync(other, link);

  const reply = await json<{ error?: string }>(server, 'POST', '/api/retire', { id: ledgerOf(link), token, force: true });
  assert.equal(reply.status, 409, JSON.stringify(reply.value));
  assert.match(reply.value.error ?? '', /changed since the preview/);
  assert.ok(existsSync(other));
  assert.ok(existsSync(fixLogin));
});

test('two retires at once with one token: one retires, the other gets 409', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  const id = ledgerOf(fixLogin);
  const { token } = await preview(server, id);
  const replies = await Promise.all([1, 2].map(() => json<Retired & { error?: string }>(server, 'POST', '/api/retire', { id, token, force: true })));
  assert.deepEqual(replies.map(({ status }) => status).sort(), [200, 409], JSON.stringify(replies));
  // Which one it says depends on whether the first retire has finished when the second arrives.
  const refused = replies.find(({ status }) => status === 409)?.value.error ?? '';
  assert.match(refused, /^Nothing was retired: (a retire of this task is already running|this retire has no current preview)/);
  assert.equal(existsSync(fixLogin), false);
});

test('a worktree or main checkout whose real path cannot be resolved gets 409 naming which one, in words that fit a preview too', async t => {
  const { realPaths } = await import('../tools/ledger-dashboard/ledgers.js');
  const home = realpathSync(freshHome(t));
  const missing = path.join(home, 'missing');
  for (const [name, state] of [
    ['worktree', { path: missing, mainCheckout: home }],
    ['main checkout', { path: home, mainCheckout: missing }],
  ] as const) {
    const reply = realPaths(state);
    assert.ok('status' in reply, name);
    assert.equal(reply.status, 409, name);
    const { error } = reply.body as { error: string };
    assert.ok(error.startsWith(`Could not resolve the ${name} ${missing}:`), error);
    assert.doesNotMatch(error, /retired/, name);
  }
});

// bash holds each cc-worktree-retire run until `gate` exists, and notes it in `<gate>.runs`; every run then goes to the real bash.
function gatedBashStub(bin: string, gate: string): void {
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0]?.endsWith('/cc-worktree-retire')) {
  fs.appendFileSync(${JSON.stringify(`${gate}.runs`)}, 'run\\n');
  while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
const { status } = require('node:child_process').spawnSync('/bin/bash', args, { stdio: 'inherit' });
process.exit(status ?? 1);
`;
  writeFileSync(path.join(bin, 'bash'), script, { mode: 0o755 });
}

test('a second retire of a task while one runs gets 409, and only one runs', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  const gate = path.join(home, 'retire-gate');
  gatedBashStub(stubBin, gate);
  const runs = (): number => (existsSync(`${gate}.runs`) ? readFileSync(`${gate}.runs`, 'utf8').split('\n').length - 1 : 0);
  const server = await startForeground(t, home, stubBin);
  const id = ledgerOf(fixLogin);
  const first = await preview(server, id);
  const second = await preview(server, id);

  const running = json<Retired>(server, 'POST', '/api/retire', { id, token: first.token, force: true });
  for (let waited = 0; runs() === 0 && waited < 20_000; waited += 50) await sleep(50);
  assert.equal(runs(), 1, 'the first retire never reached cc-worktree-retire');
  let answered = false;
  const again = json<{ error?: string }>(server, 'POST', '/api/retire', { id, token: second.token, force: true }).finally(() => (answered = true));
  for (let waited = 0; !answered && runs() < 2 && waited < 20_000; waited += 50) await sleep(50);
  writeFileSync(gate, '');

  const [retired, refused] = await Promise.all([running, again]);
  assert.equal(runs(), 1, 'the second retire ran cc-worktree-retire too');
  assert.equal(refused.status, 409);
  assert.match(refused.value.error ?? '', /already running/);
  assert.equal(retired.status, 200, retired.value.text);
  assert.equal(existsSync(fixLogin), false);
});

test('retire tokens expire, and each one is taken once', async () => {
  const { singleUseTokens } = await import('../tools/ledger-dashboard/tokens.js');
  let now = 1_000;
  const tokens = singleUseTokens<string>(10 * 60_000, () => now);
  const late = tokens.issue('late');
  const once = tokens.issue('once');
  assert.notEqual(late, once);
  assert.equal(tokens.take(once), 'once');
  assert.equal(tokens.take(once), null);
  assert.equal(tokens.take('unknown'), null);
  now += 10 * 60_000;
  assert.equal(tokens.take(late), null);
  const fresh = tokens.issue('fresh');
  now += 10 * 60_000 - 1;
  assert.equal(tokens.take(fresh), 'fresh');
});

// bash answers a cc-worktree-retire run with success and removes nothing; every other run goes to the real bash.
function bashStub(bin: string): void {
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0]?.endsWith('/cc-worktree-retire')) process.exit(0);
const { status } = require('node:child_process').spawnSync('/bin/bash', args, { stdio: 'inherit' });
process.exit(status ?? 1);
`;
  writeFileSync(path.join(bin, 'bash'), script, { mode: 0o755 });
}

test('retire answers 500 when /ledger:retire reports the task retired but its worktree is still there', async t => {
  const { home, stubBin, fixLogin } = fixture(t);
  bashStub(stubBin);
  const server = await startForeground(t, home, stubBin);
  const { token } = await preview(server, ledgerOf(fixLogin));
  const reply = await json<{ error?: string }>(server, 'POST', '/api/retire', { id: ledgerOf(fixLogin), token, force: true });
  assert.equal(reply.status, 500);
  assert.match(reply.value.error ?? '', /reported fix-login retired, but its worktree .* is still there/);
  assert.ok(existsSync(fixLogin));
});

test('rescan rebuilds the registry from disk', async t => {
  const { home, stubBin, app } = fixture(t);
  const server = await startForeground(t, home, stubBin);
  worktreeWithLedger(home, app, 'new-task', 'me/new-task', '# Task ledger — new-task\n\n## Goal\nNew.\n');
  assert.ok(!keys((await list(server)).ledgers).includes('app/new-task/active'));
  const rescanned = await json<Listed & { message: string }>(server, 'POST', '/api/rescan', {});
  assert.equal(rescanned.status, 200);
  assert.match(rescanned.value.message, /^rebuilt .*: 4 active, 1 archived$/);
  assert.ok(keys(rescanned.value.ledgers).includes('app/new-task/active'));
  assert.ok(keys((await list(server)).ledgers).includes('app/new-task/active'));
});

const STATE_FILE = (home: string) => path.join(home, '.claude/ledger-dashboard.json');

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function launch(home: string, ...args: string[]) {
  const result = spawnSync(LAUNCHER, args, { cwd: REPO, env: env(home), encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  return result;
}

// By pid, not through the state file: the temporary HOME that holds the file may already be gone.
const killAfter = (t: TestContext, pid: number): void =>
  t.after(() => {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  });

test('start runs the server detached, a second start reuses it, and stop stops it', async t => {
  const { home } = fixture(t);
  const started = launch(home);
  assert.equal(started.status, 0, started.stderr);
  const recorded: Recorded = JSON.parse(readFileSync(STATE_FILE(home), 'utf8'));
  killAfter(t, recorded.pid);
  assert.match(recorded.url, new RegExp(`^http://127\\.0\\.0\\.1:${recorded.port}/#key=${recorded.key}$`));
  assert.ok(started.stdout.includes(recorded.url), started.stdout);
  assert.ok(recorded.key.length >= 43);
  assert.ok(!Number.isNaN(Date.parse(recorded.started)));

  // The launcher has exited; the server it started still answers.
  const health = await request(recorded, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal((JSON.parse(health.text) as { pid: number }).pid, recorded.pid);

  const again = launch(home);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.includes(recorded.url), again.stdout);
  assert.match(again.stdout, /already running/);
  assert.deepEqual(JSON.parse(readFileSync(STATE_FILE(home), 'utf8')), recorded);

  const stopped = launch(home, 'stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /Stopped/);
  assert.equal(isAlive(recorded.pid), false);
  assert.equal(existsSync(STATE_FILE(home)), false);
  await assert.rejects(request(recorded, 'GET', '/api/health'));

  const none = launch(home, 'stop');
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /No ledger dashboard is running/);
});

test('start replaces a state file whose server is gone', async t => {
  const { home } = fixture(t);
  const gone = spawnSync('true').pid;
  writeFileSync(STATE_FILE(home), JSON.stringify({ pid: gone, port: 1, key: 'old', url: 'http://127.0.0.1:1/#key=old', started: '2026-01-01T00:00:00.000Z' }));
  const started = launch(home);
  assert.equal(started.status, 0, started.stderr);
  const recorded: Recorded = JSON.parse(readFileSync(STATE_FILE(home), 'utf8'));
  killAfter(t, recorded.pid);
  assert.notEqual(recorded.pid, gone);
  assert.doesNotMatch(started.stdout, /already running/);
  assert.equal((await request(recorded, 'GET', '/api/health')).status, 200);
});

type Launched = { status: number | null; stdout: string; stderr: string };

function launchInBackground(home: string, ...args: string[]): Promise<Launched> {
  const child = spawn(LAUNCHER, args, { cwd: REPO, env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

const ps = (...args: string[]): string => {
  const listed = spawnSync('ps', ['-ww', ...args], { encoding: 'utf8' });
  assert.equal(listed.error, undefined);
  return listed.stdout;
};

// Matched by HOME in each server's environment, because nothing in its command line names the HOME.
function serverPids(home: string): number[] {
  const servers = ps('-A', '-o', 'pid=,command=')
    .split('\n')
    .filter(line => line.includes('cc-ledger-dashboard --foreground'))
    .map(line => Number.parseInt(line, 10));
  return servers.filter(pid => `${ps('-E', '-p', String(pid), '-o', 'command=').trim()} `.includes(` HOME=${home} `));
}

test('two concurrent starts run one server, and both print its address', async t => {
  const { home } = fixture(t);
  const launches = await Promise.all([launchInBackground(home), launchInBackground(home)]);
  const pids = serverPids(home);
  for (const pid of pids) killAfter(t, pid);
  const recorded: Recorded = JSON.parse(readFileSync(STATE_FILE(home), 'utf8'));
  killAfter(t, recorded.pid);

  for (const launched of launches) {
    assert.equal(launched.status, 0, launched.stderr);
    assert.ok(launched.stdout.includes(recorded.url), launched.stdout);
  }
  assert.deepEqual(pids, [recorded.pid]);
});

test('stop leaves a live process that is not the dashboard running, keeps the record and says why', async t => {
  const home = realpathSync(freshHome(t));
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  const pid = sleeper.pid ?? 0;
  killAfter(t, pid);
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const record = JSON.stringify({ pid, port: 1, key: 'old', url: 'http://127.0.0.1:1/#key=old', started: '2026-01-01T00:00:00.000Z' });
  writeFileSync(STATE_FILE(home), record);

  const stopped = launch(home, 'stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.ok(isAlive(pid));
  assert.equal(readFileSync(STATE_FILE(home), 'utf8'), record);
  assert.match(stopped.stdout, new RegExp(`${pid}.*sleep 60`));
});

test('stop kills a dashboard server that no longer answers', async t => {
  const { home } = fixture(t);
  const started = launch(home);
  assert.equal(started.status, 0, started.stderr);
  const recorded: Recorded = JSON.parse(readFileSync(STATE_FILE(home), 'utf8'));
  killAfter(t, recorded.pid);
  process.kill(recorded.pid, 'SIGSTOP');

  const stopped = launch(home, 'stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /Stopped/);
  assert.equal(isAlive(recorded.pid), false);
  assert.equal(existsSync(STATE_FILE(home)), false);
});

const LOCK_FILE = (home: string) => path.join(home, '.claude/ledger-dashboard.lock');

const lockOf = (pid: number): string => `${pid} 00000000-0000-0000-0000-000000000000\n`;

// Written whole and renamed into place, as a server publishes its record.
function publish(home: string, record: Recorded): void {
  const temporary = `${STATE_FILE(home)}.tmp-test`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, STATE_FILE(home));
}

test('stop leaves the state file to a start that took the lock while stop waited, so the record that start publishes survives', async t => {
  const { home } = fixture(t);
  const started = launch(home);
  assert.equal(started.status, 0, started.stderr);
  const recorded: Recorded = JSON.parse(readFileSync(STATE_FILE(home), 'utf8'));
  killAfter(t, recorded.pid);
  // Stopped, so it ignores SIGTERM and stop waits its full five seconds before SIGKILL.
  process.kill(recorded.pid, 'SIGSTOP');

  const stopping = launchInBackground(home, 'stop');
  await sleep(2000);
  // A start begins: it holds the lock until its server has published, which can be any moment after stop read the record.
  writeFileSync(LOCK_FILE(home), lockOf(process.pid), { flag: 'wx' });
  const stopped = await stopping;
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(isAlive(recorded.pid), false);
  assert.deepEqual(JSON.parse(readFileSync(STATE_FILE(home), 'utf8')), recorded, 'stop removed the record while a start held the lock');
  assert.match(stopped.stdout, /Left .*ledger-dashboard\.json in place/);
});

test('stop keeps a record that names another pid by the time it removes it, with no lock held', async t => {
  const { home } = fixture(t);
  const started = launch(home);
  assert.equal(started.status, 0, started.stderr);
  const recorded: Recorded = JSON.parse(readFileSync(STATE_FILE(home), 'utf8'));
  killAfter(t, recorded.pid);
  process.kill(recorded.pid, 'SIGSTOP');

  const stopping = launchInBackground(home, 'stop');
  await sleep(2000);
  // A server started with --foreground publishes its record without the start lock.
  const newer = { ...recorded, pid: process.pid, key: 'newer' };
  publish(home, newer);
  const stopped = await stopping;
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(isAlive(recorded.pid), false);
  assert.deepEqual(JSON.parse(readFileSync(STATE_FILE(home), 'utf8')), newer, 'stop removed the record of another server');
});

test('stop of a server that answers leaves the state file while a live start holds the lock', async t => {
  const { home } = fixture(t);
  const started = launch(home);
  assert.equal(started.status, 0, started.stderr);
  const recorded: Recorded = JSON.parse(readFileSync(STATE_FILE(home), 'utf8'));
  killAfter(t, recorded.pid);
  writeFileSync(LOCK_FILE(home), lockOf(process.pid), { flag: 'wx' });

  const stopped = launch(home, 'stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(isAlive(recorded.pid), false);
  assert.deepEqual(JSON.parse(readFileSync(STATE_FILE(home), 'utf8')), recorded, 'the server removed its record while a start held the lock');
  assert.match(stopped.stdout, /Left .*ledger-dashboard\.json in place/);
});

test('stop says it failed, exits non-zero and keeps the record when the dashboard outlives SIGKILL', async t => {
  const home = realpathSync(freshHome(t));
  mkdirSync(path.join(home, 'fake'));
  const fake = path.join(home, 'fake/cc-ledger-dashboard');
  const trapped = `${fake}.trapped`;
  writeFileSync(fake, `#!/bin/sh\ntrap "" TERM\n: > "${trapped}"\nwhile :; do sleep 0.1; done\n`, { mode: 0o755 });
  // This process's child: launch blocks this process, so nothing reaps the child once it is killed, and as a zombie it keeps its pid.
  const pid = spawn(fake, ['--foreground'], { stdio: 'ignore' }).pid ?? 0;
  killAfter(t, pid);
  for (let waited = 0; !existsSync(trapped) && waited < 5000; waited += 50) await sleep(50);
  assert.ok(existsSync(trapped), 'the fake dashboard did not set its trap within 5 s');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const record = JSON.stringify({ pid, port: 1, key: 'old', url: 'http://127.0.0.1:1/#key=old', started: '2026-01-01T00:00:00.000Z' });
  writeFileSync(STATE_FILE(home), record);

  const stopped = launch(home, 'stop');
  assert.notEqual(stopped.status, 0, stopped.stdout);
  assert.doesNotMatch(stopped.stdout, /Stopped/);
  assert.match(stopped.stderr, new RegExp(`process ${pid} still runs`));
  assert.equal(readFileSync(STATE_FILE(home), 'utf8'), record);
});

test('stop leaves the record of a dead server while a live start holds the lock, and removes it under a stale lock', t => {
  const home = realpathSync(freshHome(t));
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const gone = spawnSync('true').pid ?? 0;
  const record = JSON.stringify({ pid: gone, port: 1, key: 'old', url: 'http://127.0.0.1:1/#key=old', started: '2026-01-01T00:00:00.000Z' });
  writeFileSync(STATE_FILE(home), record);

  writeFileSync(LOCK_FILE(home), lockOf(process.pid));
  const left = launch(home, 'stop');
  assert.equal(left.status, 0, left.stderr);
  assert.match(left.stdout, /Left .*ledger-dashboard\.json in place/);
  assert.equal(readFileSync(STATE_FILE(home), 'utf8'), record);

  const minutesAgo = new Date(Date.now() - 2 * 60_000);
  for (const [stale, lock] of [['dead holder', lockOf(gone)], ['old lock', lockOf(process.pid)]] as const) {
    writeFileSync(STATE_FILE(home), record);
    writeFileSync(LOCK_FILE(home), lock);
    if (stale === 'old lock') utimesSync(LOCK_FILE(home), minutesAgo, minutesAgo);
    const removed = launch(home, 'stop');
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /Removed the old record/, stale);
    assert.equal(existsSync(STATE_FILE(home)), false, stale);
    assert.equal(existsSync(LOCK_FILE(home)), false, stale);
  }
});

test('stop does not SIGKILL a pid that runs another command by the time SIGTERM has had its time', async t => {
  const home = realpathSync(freshHome(t));
  mkdirSync(path.join(home, 'fake'));
  const fake = path.join(home, 'fake/cc-ledger-dashboard');
  const trapped = `${fake}.trapped`;
  // Outlives SIGTERM by turning into another program, as a pid the system has given to another process would look.
  writeFileSync(fake, `#!/bin/sh\ntrap "exec sleep 60" TERM\n: > "${trapped}"\nwhile :; do sleep 0.1; done\n`, { mode: 0o755 });
  // Through a shell that exits at once, so the process is not this process's child: a killed child stays a zombie here.
  const shell = spawnSync('sh', ['-c', '"$0" --foreground >/dev/null 2>&1 & echo $!', fake], { encoding: 'utf8' });
  const pid = Number.parseInt(shell.stdout, 10);
  killAfter(t, pid);
  // By the mark, not by its command line: ps shows that before the shell has run the trap line, and a SIGTERM then kills it.
  for (let waited = 0; !existsSync(trapped) && waited < 5000; waited += 50) await sleep(50);
  assert.ok(existsSync(trapped), 'the fake dashboard did not set its trap within 5 s');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(STATE_FILE(home), JSON.stringify({ pid, port: 1, key: 'old', url: 'http://127.0.0.1:1/#key=old', started: '2026-01-01T00:00:00.000Z' }));

  const stopped = launch(home, 'stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.ok(isAlive(pid), 'stop killed a process that no longer runs the dashboard');
  assert.match(ps('-p', String(pid), '-o', 'command='), /^sleep 60/);
  assert.match(stopped.stdout, new RegExp(`${pid}.*sleep 60`));
});

test('stop stops a server started with --port before --foreground', async t => {
  const { home } = fixture(t);
  // Through a shell that exits at once, so the server is not this process's child: a child that stops stays a zombie here.
  const shell = spawnSync('sh', ['-c', '"$0" --port 0 --foreground >/dev/null 2>&1 &', LAUNCHER], { cwd: REPO, env: env(home) });
  assert.equal(shell.status, 0);
  let recorded: Recorded | null = null;
  for (let waited = 0; recorded === null && waited < 20_000; waited += 100) {
    await new Promise(resolve => setTimeout(resolve, 100));
    recorded = existsSync(STATE_FILE(home)) ? JSON.parse(readFileSync(STATE_FILE(home), 'utf8')) : null;
  }
  assert.ok(recorded !== null, 'the server wrote no record within 20 s');
  const { pid } = recorded;
  killAfter(t, pid);

  const stopped = launch(home, 'stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /Stopped the ledger dashboard/);
  assert.equal(isAlive(pid), false);
  assert.equal(existsSync(STATE_FILE(home)), false);
});

test('start takes over a lock left by a start that died, and serves', async t => {
  const { home } = fixture(t);
  const gone = spawnSync('true').pid;
  writeFileSync(path.join(home, '.claude/ledger-dashboard.lock'), `${gone} 00000000-0000-0000-0000-000000000000\n`);
  const began = Date.now();
  const started = launch(home);
  const elapsed = Date.now() - began;
  assert.equal(started.status, 0, started.stderr);
  const recorded: Recorded = JSON.parse(readFileSync(STATE_FILE(home), 'utf8'));
  killAfter(t, recorded.pid);
  assert.ok(elapsed < 10_000, `start took ${elapsed} ms`);
  assert.equal((await request(recorded, 'GET', '/api/health')).status, 200);
});

// Runs the page's script against a stub DOM and reports the key each request sent.
function runPage(hash: string, stored: Map<string, string> | null): string[] {
  const html = readFileSync(path.join(REPO, 'tools/ledger-dashboard/page.html'), 'utf8');
  const script = /<script nonce="\{\{nonce\}\}">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const sentKeys: string[] = [];
  const element = (): object => ({ value: '', classList: { toggle() {} }, addEventListener() {} });
  const unavailable = (): never => {
    throw new Error('SecurityError: storage is disabled');
  };
  const sessionStorage = stored === null
    ? { getItem: unavailable, setItem: unavailable }
    : { getItem: (name: string) => stored.get(name) ?? null, setItem: (name: string, value: string) => void stored.set(name, value) };
  vm.runInNewContext(script, {
    URLSearchParams,
    location: { hash, pathname: '/', search: '' },
    history: { replaceState() {} },
    sessionStorage,
    document: { getElementById: element, createElement: element, addEventListener() {} },
    fetch: (_path: string, init: { headers: Record<string, string> }) => {
      sentKeys.push(init.headers['X-Ledger-Key'] ?? '');
      return new Promise(() => {});
    },
  });
  return sentKeys;
}

test('the page keeps its key for the tab, so a reload without the key in the address still sends it', () => {
  const stored = new Map<string, string>();
  assert.deepEqual(runPage('#key=first', stored), ['first']);
  assert.deepEqual(runPage('', stored), ['first']);
  assert.deepEqual(runPage('#key=second', stored), ['second']);
  assert.deepEqual(runPage('', stored), ['second']);
  assert.deepEqual(runPage('', new Map()), []);
});

test('the page still uses the key in its address when session storage throws', () => {
  assert.deepEqual(runPage('#key=first', null), ['first']);
  assert.deepEqual(runPage('', null), []);
});

class FakeElement {
  value = '';
  hidden = false;
  disabled = false;
  textContent = '';
  innerHTML = '';
  className = '';
  tabIndex = -1;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  classList = { toggle() {}, add() {}, remove() {} };
  private listeners = new Map<string, (event: object) => unknown>();
  addEventListener(type: string, listener: (event: object) => unknown): void {
    this.listeners.set(type, listener);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  setAttribute(): void {}
  querySelector(): FakeElement {
    return new FakeElement();
  }
  focus(): void {}
  async click(): Promise<void> {
    await this.listeners.get('click')?.({ currentTarget: this });
  }
}

type Body = Record<string, unknown> | undefined;

/** An answer that the stub fetch sends as an error reply. */
class Failure {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {}
}

// Runs the page's script against a stub DOM whose fetch `answer` serves, and records each request.
function openPage(answer: (pathname: string, body: Body) => object | Promise<object>) {
  const html = readFileSync(path.join(REPO, 'tools/ledger-dashboard/page.html'), 'utf8');
  const script = /<script nonce="\{\{nonce\}\}">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const elements = new Map<string, FakeElement>();
  const byId = (id: string): FakeElement => {
    const found = elements.get(id) ?? new FakeElement();
    elements.set(id, found);
    return found;
  };
  const sent: { pathname: string; body: Body }[] = [];
  vm.runInNewContext(script, {
    URLSearchParams,
    setTimeout,
    clearTimeout,
    Option: class {
      constructor(
        readonly text: string,
        readonly value: string,
      ) {}
    },
    location: { hash: '#key=k', pathname: '/', search: '' },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: byId, createElement: () => new FakeElement(), addEventListener() {} },
    fetch: async (pathname: string, init: { body?: string }) => {
      const body: Body = init.body === undefined ? undefined : JSON.parse(init.body);
      sent.push({ pathname, body });
      const value = await answer(pathname, body);
      return value instanceof Failure
        ? { status: value.status, ok: false, json: async () => ({ error: value.error }) }
        : { status: 200, ok: true, json: async () => value };
    },
  });
  return { byId, sent };
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const PAGE_ROWS = ['a', 'b'].map(slug => ({ id: `/repos/app/.claude/worktrees/${slug}/.claude/ledger.md`, repo: 'app', slug, status: 'active', updated: '', next: '', branch: `me/${slug}` }));

function pageRow(query: URLSearchParams | Body): (typeof PAGE_ROWS)[number] {
  const field = (name: string): unknown => (query instanceof URLSearchParams ? query.get(name) : query?.[name]);
  const row = PAGE_ROWS.find(row => row.id === field('id') || row.slug === field('slug'));
  assert.ok(row, 'the page asked for a task the list does not hold');
  return row;
}

function pageAnswer(pathname: string, body: Body): object {
  const [route, query] = pathname.split('?');
  if (route === '/api/ledgers') return { ledgers: PAGE_ROWS, total: PAGE_ROWS.length, repos: ['app'], statuses: ['active'] };
  if (route === '/api/ledger') {
    const row = pageRow(new URLSearchParams(query));
    return { ...row, html: '', path: row.id, worktree: '', worktreeExists: true, prs: [], go: `go ${row.slug}` };
  }
  if (route === '/api/retire/preview') {
    const { slug } = pageRow(body);
    return { text: '', html: '', blockers: ['its branch is not merged'], token: `token-${slug}` };
  }
  return { retired: true, text: 'Retired.' };
}

const retires = (sent: { pathname: string; body: Body }[]): Body[] => sent.filter(({ pathname }) => pathname === '/api/retire').map(({ body }) => body);

test('the page retires the task whose preview it shows, and drops that preview when another task opens', async () => {
  const page = openPage(pageAnswer);
  await settle();
  const [a, b] = page.byId('rows').children;
  assert.ok(a && b);

  await a.click();
  await page.byId('retire').click();
  assert.equal(page.byId('retire-box').hidden, false);
  await b.click();
  assert.equal(page.byId('retire-box').hidden, true);
  await page.byId('force').click();
  assert.deepEqual(retires(page.sent), []);

  await page.byId('retire').click();
  await page.byId('force').click();
  assert.deepEqual(retires(page.sent), [{ id: PAGE_ROWS[1]?.id, token: 'token-b', force: true }]);
});

test('the page drops a preview that arrives after another task opened', async () => {
  let release = (): void => {};
  const held = new Promise<void>(resolve => (release = resolve));
  const page = openPage(async (pathname, body) => {
    if (pathname === '/api/retire/preview') await held;
    return pageAnswer(pathname, body);
  });
  await settle();
  const [a, b] = page.byId('rows').children;
  assert.ok(a && b);

  await a.click();
  const previewing = page.byId('retire').click();
  await b.click();
  release();
  await previewing;
  assert.equal(page.byId('retire-box').hidden, true);
  await page.byId('force').click();
  assert.deepEqual(retires(page.sent), []);
});

test('the page hides the preview it shows when a new preview of the task fails, so no token stays armed', async () => {
  for (const failure of [new Failure(409, 'The task changed.'), new Error('The network is down.')]) {
    const label = failure instanceof Error ? 'thrown' : 'error reply';
    let previews = 0;
    const page = openPage((pathname, body) => {
      if (pathname === '/api/retire/preview' && ++previews === 2) {
        if (failure instanceof Error) throw failure;
        return failure;
      }
      return pageAnswer(pathname, body);
    });
    await settle();
    const [a] = page.byId('rows').children;
    assert.ok(a);

    await a.click();
    await page.byId('retire').click();
    assert.equal(page.byId('retire-box').hidden, false, label);
    await page.byId('retire').click();
    assert.equal(page.byId('retire-box').hidden, true, label);
    await page.byId('force').click();
    await page.byId('confirm').click();
    assert.deepEqual(retires(page.sent), [], label);
  }
});

test('the page shows the task opened last when detail replies arrive out of order, and drops a late one for another task', async () => {
  const [rowA, rowB] = PAGE_ROWS;
  assert.ok(rowA && rowB);
  for (const lateReply of ['success', 'failure', 'unauthorized', 'rejection'] as const) {
    let release = (): void => {};
    const held = new Promise<void>(resolve => (release = resolve));
    const page = openPage(async (pathname, body) => {
      const [route, query] = pathname.split('?');
      if (route === '/api/ledger' && new URLSearchParams(query).get('id') === rowA.id) {
        await held;
        if (lateReply === 'failure') return new Failure(404, 'The registry holds no such task.');
        if (lateReply === 'unauthorized') return new Failure(401, 'Unauthorized.');
        if (lateReply === 'rejection') throw new Error('The network is down.');
      }
      return pageAnswer(pathname, body);
    });
    await settle();
    const [a, b] = page.byId('rows').children;
    assert.ok(a && b);

    const openingA = a.click();
    await b.click();
    release();
    await openingA;
    assert.equal(page.byId('detail').hidden, false, lateReply);
    assert.equal(page.byId('detail-title').textContent, 'b', lateReply);
    assert.equal(page.byId('notice').textContent, '', lateReply);
    await page.byId('retire').click();
    await page.byId('force').click();
    assert.deepEqual(retires(page.sent), [{ id: rowB.id, token: 'token-b', force: true }], lateReply);
  }
});

test('the page keeps the detail closed when the reply for the task it closed arrives late', async () => {
  let release = (): void => {};
  const held = new Promise<void>(resolve => (release = resolve));
  const page = openPage(async (pathname, body) => {
    if (pathname.startsWith('/api/ledger?')) await held;
    return pageAnswer(pathname, body);
  });
  await settle();
  const [a] = page.byId('rows').children;
  assert.ok(a);

  const opening = a.click();
  await page.byId('close').click();
  release();
  await opening;
  assert.equal(page.byId('detail').hidden, true);
  assert.equal(page.byId('detail-title').textContent, '');
});

test('the page hides the retire preview as soon as another task is selected, and drops a late preview of the task it left', async () => {
  const [, rowB] = PAGE_ROWS;
  assert.ok(rowB);
  for (const previewOfA of ['on screen', 'late'] as const) {
    let releaseB = (): void => {};
    const detailOfB = new Promise<void>(resolve => (releaseB = resolve));
    let releasePreview = (): void => {};
    const previewHeld = previewOfA === 'late' ? new Promise<void>(resolve => (releasePreview = resolve)) : Promise.resolve();
    const page = openPage(async (pathname, body) => {
      const [route, query] = pathname.split('?');
      if (route === '/api/ledger' && new URLSearchParams(query).get('id') === rowB.id) await detailOfB;
      if (route === '/api/retire/preview') await previewHeld;
      return pageAnswer(pathname, body);
    });
    await settle();
    const [a, b] = page.byId('rows').children;
    assert.ok(a && b);

    await a.click();
    const previewing = page.byId('retire').click();
    if (previewOfA === 'on screen') {
      await previewing;
      assert.equal(page.byId('retire-box').hidden, false);
    }
    const openingB = b.click();
    assert.equal(page.byId('retire-box').hidden, true, previewOfA);
    releasePreview();
    await previewing;
    assert.equal(page.byId('retire-box').hidden, true, previewOfA);
    await page.byId('force').click();
    assert.deepEqual(retires(page.sent), [], previewOfA);
    releaseB();
    await openingB;
  }
});

test('the launcher refuses an unknown argument and a bad port', t => {
  const home = realpathSync(freshHome(t));
  for (const args of [['restart'], ['--port', 'abc'], ['--port', '70000'], ['stop', '--foreground']]) {
    const result = launch(home, ...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /usage: cc-ledger-dashboard/, args.join(' '));
  }
});
