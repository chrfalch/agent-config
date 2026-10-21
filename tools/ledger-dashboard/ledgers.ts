import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { access, lstat, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { groupByParent, park, parkMarker, summarize, unpark } from '../../mods/ledger/hooks/ledger.js';
import { renderMarkdown } from './markdown.js';
import { singleUseTokens } from './tokens.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PLUGIN_ROOT = path.join(REPO, 'mods/ledger');
const CC_LEDGERS = path.join(REPO, 'bin/cc-ledgers');

type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean };
type FileStat = { kind: 'file' | 'directory' | 'other'; size: number; mtimeMs: number; isLink: boolean };

/** The part of Claude Code's `$` that the ledger mod's commands use, backed by Node. */
type Engine = {
  process: { run(argv: string[], init?: { cwd?: string }): Promise<RunResult> };
  fs: { read(file: string): Promise<string>; write(file: string, text: string): Promise<void>; stat(file: string): Promise<FileStat>; exists(file: string): Promise<boolean> };
  session: { cwd(): Promise<string> };
  plugin: { root: string };
};

type Entry = { repo: string; slug: string; status: string; updated: string; path: string; archivePath?: string; branch?: unknown; parent?: string };
type WorktreeState = { path: string; mainCheckout: string };
type Pr = { state: string; number: number };

// Loaded at run time: the mod's modules import their types from 'claude-code', which only Claude Code provides,
// so `tsc` cannot follow them. These are the signatures they export.
type Mod = {
  run(engine: Engine, argv: string[], cwd: string): Promise<{ stdout: string; stderr: string; failure?: string }>;
  parseEntries(stdout: string): Entry[] | null;
  statusAndNext(engine: Engine, entry: Entry): Promise<[status: string, next: string]>;
  worktreeOf(ledgerPath: string): string;
  readState(engine: Engine, worktree: string): Promise<WorktreeState | { error: string }>;
  retireBlockers(state: WorktreeState): string[];
  formatPlan(slug: string, state: WorktreeState, today: Date): string;
  retireLedger(engine: Engine, slug: string, ledgerPath: string, options: { confirmed: boolean; forced: boolean }): Promise<string>;
  lookUpPrs(engine: Engine, branch: string, cwd: string): Promise<{ prs: Pr[] | null; error?: string }>;
  titleSlug(engine: Engine, ledgerPath: string): Promise<string>;
};

const MOD_EXPORTS = ['run', 'parseEntries', 'statusAndNext', 'worktreeOf', 'readState', 'retireBlockers', 'formatPlan', 'retireLedger', 'lookUpPrs', 'titleSlug'] as const satisfies readonly (keyof Mod)[];

async function loadMod(): Promise<Mod> {
  const modules = ['lookup', 'registry', 'all-command', 'retire', 'retire-command', 'worktrees-command'];
  const parts: Partial<Mod>[] = await Promise.all(modules.map(name => import(pathToFileURL(path.join(PLUGIN_ROOT, 'hooks', `${name}.ts`)).href)));
  const mod: Partial<Mod> = Object.assign({}, ...parts);
  const missing = MOD_EXPORTS.filter(name => typeof mod[name] !== 'function');
  if (missing.length > 0) throw new Error(`the ledger mod no longer exports ${missing.join(', ')}`);
  return mod as Mod;
}

function runProcess(argv: string[], init: { cwd?: string } = {}): Promise<RunResult> {
  const [command = '', ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: init.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ exitCode: code ?? 1, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false }));
  });
}

async function statOf(file: string): Promise<FileStat> {
  const [target, link] = await Promise.all([stat(file), lstat(file)]);
  const kind = target.isFile() ? 'file' : target.isDirectory() ? 'directory' : 'other';
  return { kind, size: target.size, mtimeMs: target.mtimeMs, isLink: link.isSymbolicLink() };
}

/** A `$` whose session runs in `cwd`. */
const engine = (cwd: string): Engine => ({
  process: { run: runProcess },
  fs: {
    read: file => readFile(file, 'utf8'),
    write: (file, text) => writeFile(file, text),
    stat: statOf,
    exists: file => access(file).then(() => true, () => false),
  },
  session: { cwd: async () => cwd },
  plugin: { root: PLUGIN_ROOT },
});

/** What an API route answers: an HTTP status and a JSON body. */
export type Reply = { status: number; body: object };

const ok = (body: object): Reply => ({ status: 200, body });
const fail = (status: number, error: string): Reply => ({ status, body: { error } });
const isReply = <T extends object>(value: T | Reply): value is Reply => 'body' in value;

/** `parent` is the slug of the parent task, and `parentId` the id of its row, when the registry holds that task. */
export type Row = { id: string; repo: string; slug: string; status: string; updated: string; next: string; branch: string; parent?: string; parentId?: string };
/** A row of the task list. `nested` is true for a child row listed right under the row of its parent. */
export type ListedRow = Row & { nested: boolean };
export type Filter = { repo?: string; status?: string[]; q?: string };
/** One repository by name: its number of tasks, and the number in each status that occurs in it. */
export type RepoSummary = { repo: string; total: number; counts: Record<string, number> };

/**
 * What a retire preview showed. A retire goes ahead only while its task still looks the same. The real paths count too,
 * because a symlink in the worktree path can lead to another worktree by the time of the retire.
 */
type RetireTarget = { id: string; repo: string; slug: string; worktree: string; realWorktree: string; realMainCheckout: string; blockers: string[] };

const RETIRE_TOKEN_TTL_MS = 10 * 60_000;

const unique = (values: string[]): string[] => [...new Set(values)].sort();

const isArchived = (entry: Entry): boolean => entry.status === 'archived';

// Repo names and slugs repeat, and a retired slug can be reused; the file each row reads does not.
const idOf = (entry: Entry): string => entry.archivePath ?? entry.path;

const branchOf = (entry: Entry): string => (typeof entry.branch === 'string' ? entry.branch : '');

const taskKey = (repo: string, slug: string): string => `${repo}\0${slug}`;

// A parent is in the repo of its child. A retired slug can be given again, and then the task that is not archived is the parent.
function parentIdOf(newestFirst: Entry[]): (entry: Entry) => string | undefined {
  const tasks = new Map<string, Entry>();
  for (const entry of newestFirst) {
    const key = taskKey(entry.repo, entry.slug);
    const known = tasks.get(key);
    if (known === undefined || (isArchived(known) && !isArchived(entry))) tasks.set(key, entry);
  }
  return entry => {
    const parent = entry.parent === undefined ? undefined : tasks.get(taskKey(entry.repo, entry.parent));
    return parent && idOf(parent);
  };
}

// Grouped by id, not by slug, so a child stays out of a group whose row is not the parent it resolves to.
const familyOrder = (rows: Row[]): ListedRow[] =>
  groupByParent(rows, row => row.id, row => row.parentId).flatMap(({ item, children }) => [
    { ...item, nested: false },
    ...children.map(child => ({ ...child, nested: true })),
  ]);

const sameTarget = (a: RetireTarget, b: RetireTarget): boolean =>
  a.id === b.id &&
  a.repo === b.repo &&
  a.slug === b.slug &&
  a.worktree === b.worktree &&
  a.realWorktree === b.realWorktree &&
  a.realMainCheckout === b.realMainCheckout &&
  a.blockers.join('\n') === b.blockers.join('\n');

function realPath(name: string, folder: string): string | Reply {
  try {
    return realpathSync(folder);
  } catch (error) {
    return fail(409, `Could not resolve the ${name} ${folder}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function realPaths({ path: worktree, mainCheckout }: WorktreeState): Pick<RetireTarget, 'realWorktree' | 'realMainCheckout'> | Reply {
  const realWorktree = realPath('worktree', worktree);
  if (typeof realWorktree !== 'string') return realWorktree;
  const realMainCheckout = realPath('main checkout', mainCheckout);
  return typeof realMainCheckout === 'string' ? { realWorktree, realMainCheckout } : realMainCheckout;
}

export type Ledgers = ReturnType<typeof ledgersOf>;

export async function openLedgers(): Promise<Ledgers> {
  return ledgersOf(await loadMod());
}

function ledgersOf(mod: Mod) {
  const home = engine(REPO);
  const retireTokens = singleUseTokens<RetireTarget>(RETIRE_TOKEN_TTL_MS);
  const retiring = new Set<string>();

  async function registry(command: 'list' | 'scan'): Promise<{ entries: Entry[]; stderr: string } | { error: string }> {
    const { stdout, stderr, failure } = await mod.run(home, [CC_LEDGERS, command, '--json'], REPO);
    if (failure !== undefined) return { error: `cc-ledgers ${command} ${failure}` };
    const entries = mod.parseEntries(stdout);
    return entries === null ? { error: `cc-ledgers ${command} printed something that is not a list of ledgers.` } : { entries, stderr };
  }

  function rows(entries: Entry[]): Promise<Row[]> {
    const parentId = parentIdOf(entries);
    return Promise.all(
      entries.map(async entry => {
        const [status, next] = await mod.statusAndNext(home, entry);
        const row: Row = { id: idOf(entry), repo: entry.repo, slug: entry.slug, status, updated: entry.updated, next, branch: branchOf(entry) };
        return entry.parent === undefined ? row : { ...row, parent: entry.parent, parentId: parentId(entry) };
      }),
    );
  }

  async function contains(entry: Entry, needle: string): Promise<boolean> {
    try {
      return (await readFile(entry.archivePath ?? entry.path, 'utf8')).toLowerCase().includes(needle);
    } catch {
      return false;
    }
  }

  async function listed(entries: Entry[], { repo, status, q }: Filter): Promise<{ ledgers: ListedRow[]; total: number; repos: string[]; statuses: string[] }> {
    const all = await rows(entries);
    const needle = q?.trim().toLowerCase() ?? '';
    const found = needle === '' ? entries.map(() => true) : await Promise.all(entries.map(entry => contains(entry, needle)));
    const shown = all.filter((row, index) => (!repo || row.repo === repo) && (!status?.length || status.includes(row.status)) && found[index]);
    const ledgers = familyOrder(shown);
    return { ledgers, total: all.length, repos: unique(all.map(row => row.repo)), statuses: unique(all.map(row => row.status)) };
  }

  async function summarized(entries: Entry[]): Promise<{ repos: RepoSummary[] }> {
    const all = await rows(entries);
    const repos = unique(all.map(row => row.repo)).map(repo => {
      const statuses = all.filter(row => row.repo === repo).map(row => row.status);
      const counts = Object.fromEntries(unique(statuses).map(status => [status, statuses.filter(each => each === status).length]));
      return { repo, total: statuses.length, counts };
    });
    return { repos };
  }

  // The page sends the id back, so it is only ever matched against the registry, never opened as a path.
  async function find(id: string): Promise<Entry | Reply> {
    const read = await registry('list');
    if ('error' in read) return fail(500, read.error);
    const matches = read.entries.filter(entry => idOf(entry) === id);
    if (matches.length > 1) return fail(409, `The registry lists ${id} more than once. Rescan, then open the task again.`);
    return matches[0] ?? fail(404, 'The registry holds no such task. Rescan, then open the task again.');
  }

  async function findActive(id: string, action: string): Promise<Entry | Reply> {
    const entry = await find(id);
    if (isReply(entry)) return entry;
    return isArchived(entry) ? fail(409, `${entry.slug} is archived, so it cannot be ${action}.`) : entry;
  }

  async function worktreeState(entry: Entry): Promise<WorktreeState | Reply> {
    const worktree = mod.worktreeOf(entry.path);
    const state = await mod.readState(engine(worktree), worktree);
    return 'error' in state ? fail(409, state.error) : state;
  }

  // The registry keeps the slug a task was given first; a retitled task would be previewed and retired under a name it no longer has.
  async function retirableState(entry: Entry): Promise<WorktreeState | Reply> {
    const state = await worktreeState(entry);
    if (isReply(state)) return state;
    const title = await mod.titleSlug(home, entry.path);
    if (title === entry.slug) return state;
    return fail(409, `The ledger of ${entry.slug} is now titled ${title}. Rescan so the dashboard shows its current name, then retire ${title}.`);
  }

  async function retireTarget(id: string): Promise<{ target: RetireTarget; state: WorktreeState; ledgerPath: string } | Reply> {
    const entry = await findActive(id, 'retired');
    if (isReply(entry)) return entry;
    if (entry.status === 'backlog') return fail(409, `${entry.slug} is in the backlog and has no worktree yet, so there is nothing to retire.`);
    const state = await retirableState(entry);
    if (isReply(state)) return state;
    const real = realPaths(state);
    if (isReply(real)) return real;
    return { state, ledgerPath: entry.path, target: { id, repo: entry.repo, slug: entry.slug, worktree: state.path, ...real, blockers: mod.retireBlockers(state) } };
  }

  function takeRetireToken(token: string, id: string, force: boolean): RetireTarget | Reply {
    const previewed = retireTokens.take(token);
    if (previewed === null) return fail(409, 'Nothing was retired: this retire has no current preview. A preview lasts 10 minutes and one retire. Preview it again.');
    if (previewed.id !== id) return fail(409, 'Nothing was retired: the preview was for another task. Preview this task again.');
    const needsForce = previewed.blockers.length > 0;
    if (force !== needsForce) return fail(409, `Nothing was retired: the preview said this task retires ${needsForce ? 'only with' : 'without'} --force. Preview it again.`);
    return previewed;
  }

  async function retirePreviewed(id: string, token: string, force: boolean): Promise<Reply> {
    const previewed = takeRetireToken(token, id, force);
    if (isReply(previewed)) return previewed;
    const found = await retireTarget(id);
    if (isReply(found)) return found;
    const { target, state, ledgerPath } = found;
    if (!sameTarget(previewed, target)) return fail(409, `Nothing was retired: ${target.slug} changed since the preview. Preview it again.`);
    // From the main checkout: from the worktree itself, /ledger:retire would say this session's folder was removed.
    const text = await mod.retireLedger(engine(state.mainCheckout), target.slug, ledgerPath, { confirmed: true, forced: force });
    const retired = !existsSync(state.path);
    return { status: retired ? 200 : 409, body: { retired, text, html: renderMarkdown(text) } };
  }

  return {
    async list(filter: Filter): Promise<Reply> {
      const read = await registry('list');
      return 'error' in read ? fail(500, read.error) : ok(await listed(read.entries, filter));
    },

    async repos(): Promise<Reply> {
      const read = await registry('list');
      return 'error' in read ? fail(500, read.error) : ok(await summarized(read.entries));
    },

    async rescan(): Promise<Reply> {
      const read = await registry('scan');
      if ('error' in read) return fail(500, read.error);
      const message = read.stderr.split('\n').find(line => line.startsWith('rebuilt ')) ?? '';
      return ok({ message, ...(await listed(read.entries, {})) });
    },

    async detail(id: string): Promise<Reply> {
      const entry = await find(id);
      if (isReply(entry)) return entry;
      const file = entry.archivePath ?? entry.path;
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        return fail(500, `Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const worktree = mod.worktreeOf(entry.path);
      const live = !isArchived(entry) && existsSync(worktree);
      const branch = branchOf(entry);
      const [[status], prs] = await Promise.all([mod.statusAndNext(home, entry), live ? mod.lookUpPrs(engine(worktree), branch, worktree) : null]);
      return ok({
        id,
        repo: entry.repo,
        slug: entry.slug,
        status,
        html: renderMarkdown(text),
        path: file,
        worktree,
        worktreeExists: live,
        branch,
        prs: prs?.prs ?? null,
        ...(prs?.error && { prError: prs.error }),
        go: isArchived(entry) ? null : `go ${entry.slug}`,
        parked: summarize(text, '', 0).parked !== undefined,
      });
    },

    async park(id: string, reason: string): Promise<Reply> {
      if (reason.trim() === '') return fail(400, 'Give a reason for parking the task.');
      const entry = await findActive(id, 'parked');
      if (isReply(entry)) return entry;
      const marker = parkMarker(new Date(), reason);
      await writeFile(entry.path, park(await readFile(entry.path, 'utf8'), marker));
      return ok({ text: `Parked ${entry.slug}. ${marker}` });
    },

    async unpark(id: string): Promise<Reply> {
      const entry = await findActive(id, 'unparked');
      if (isReply(entry)) return entry;
      const { text, parked } = unpark(await readFile(entry.path, 'utf8'));
      if (parked === null) return fail(409, `${entry.slug} is not parked.`);
      await writeFile(entry.path, text);
      return ok({ text: `Unparked ${entry.slug}. It was parked on ${parked.date}: ${parked.reason}` });
    },

    /** The plan /ledger:retire would carry out, and the token that /api/retire needs to carry it out. */
    async previewRetire(id: string): Promise<Reply> {
      const found = await retireTarget(id);
      if (isReply(found)) return found;
      const { target, state } = found;
      const text = mod.formatPlan(target.slug, state, new Date());
      return ok({ text, html: renderMarkdown(text), blockers: target.blockers, token: retireTokens.issue(target) });
    },

    // One at a time per task: a second /ledger:retire would run against the worktree the first one is removing.
    async retire(id: string, token: string, force: boolean): Promise<Reply> {
      if (retiring.has(id)) return fail(409, 'Nothing was retired: a retire of this task is already running. Wait for it to finish.');
      retiring.add(id);
      try {
        return await retirePreviewed(id, token, force);
      } finally {
        retiring.delete(id);
      }
    },
  };
}
