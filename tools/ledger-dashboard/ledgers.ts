import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childOrder, groupByParent, isParentOf, park, parkMarker, summarize, unpark, type Grouped } from '../../mods/ledger/hooks/ledger.js';
import { loadHooks, nodeEngine as engine, type Engine } from '../lib/node-engine.js';
import { renderMarkdown } from './markdown.js';
import { singleUseTokens } from './tokens.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CC_LEDGERS = path.join(REPO, 'bin/cc-ledgers');

type Entry = { repo: string; slug: string; status: string; updated: string; path: string; archivePath?: string; branch?: unknown; parent?: string; parentMain?: string; main?: string };
type WorktreeState = { path: string; mainCheckout: string };
type Pr = { state: string; number: number };

// The signatures of the mod's functions that loadHooks imports.
type Mod = {
  run(engine: Engine, argv: string[], cwd: string): Promise<{ stdout: string; stderr: string; failure?: string }>;
  parseEntries(stdout: string): Entry[] | null;
  statusAndNext(engine: Engine, entry: Entry): Promise<[status: string, next: string]>;
  worktreeOf(ledgerPath: string): string;
  readState(engine: Engine, worktree: string): Promise<WorktreeState | { error: string }>;
  retireBlockers(state: WorktreeState): string[];
  formatPlan(slug: string, state: WorktreeState, today: Date, options?: { footer?: boolean }): string;
  retireLedger(engine: Engine, slug: string, ledgerPath: string, options: { dryRun: boolean; forced: boolean }): Promise<string>;
  lookUpPrs(engine: Engine, branch: string, cwd: string): Promise<{ prs: Pr[] | null; error?: string }>;
  titleSlug(engine: Engine, ledgerPath: string): Promise<string>;
};

const MOD_EXPORTS = ['run', 'parseEntries', 'statusAndNext', 'worktreeOf', 'readState', 'retireBlockers', 'formatPlan', 'retireLedger', 'lookUpPrs', 'titleSlug'] as const satisfies readonly (keyof Mod)[];

const loadMod = (): Promise<Mod> => loadHooks<Mod>(['lookup', 'registry', 'all-command', 'retire', 'retire-command', 'worktrees-command'], MOD_EXPORTS);

/** What an API route answers: an HTTP status and a JSON body. */
export type Reply = { status: number; body: object };

const ok = (body: object): Reply => ({ status: 200, body });
const fail = (status: number, error: string): Reply => ({ status, body: { error } });
const isReply = <T extends object>(value: T | Reply): value is Reply => 'body' in value;

/** `parent` is the slug of the parent task, `<slug> @ <main>` when it is in another repository. `parentId` is the id of its row, when the registry holds that task. */
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

// A retired slug can be given again, and then the task that is not archived is the parent.
function parentIdOf(newestFirst: Entry[]): (entry: Entry) => string | undefined {
  return entry => {
    const candidates = newestFirst.filter(task => isParentOf(task, entry));
    const parent = candidates.find(task => !isArchived(task)) ?? candidates[0];
    return parent && idOf(parent);
  };
}

// Grouped by id, not by slug, so a child stays out of a group whose row is not the parent it resolves to.
const familyOrder = (rows: Row[]): ListedRow[] => {
  const listed = ({ item, children }: Grouped<Row>, nested: boolean): ListedRow[] => [{ ...item, nested }, ...children.flatMap(child => listed(child, true))];
  const byStatusThenDate = childOrder<Row>(row => row.status === 'active', row => Date.parse(row.updated));
  return groupByParent(rows, row => row.id, row => row.parentId, byStatusThenDate).flatMap(group => listed(group, false));
};

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
        if (entry.parent === undefined) return row;
        return { ...row, parent: entry.parentMain ? `${entry.parent} @ ${entry.parentMain}` : entry.parent, parentId: parentId(entry) };
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
    const candidates = all.filter((row, index) => (!repo || row.repo === repo) && found[index]);
    const matched = candidates.filter(row => !status?.length || status.includes(row.status));
    // A status filter keeps the ancestors of a row it shows, so the row stays in its tree. A search does not.
    const byId = new Map(candidates.map(row => [row.id, row]));
    const kept = new Set<Row>();
    for (const row of matched) {
      let next: Row | undefined = row;
      while (next !== undefined && !kept.has(next)) {
        kept.add(next);
        next = next.parentId === undefined ? undefined : byId.get(next.parentId);
      }
    }
    const ledgers = familyOrder(candidates.filter(row => kept.has(row)));
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
    const text = await mod.retireLedger(engine(state.mainCheckout), target.slug, ledgerPath, { dryRun: false, forced: force });
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
      const text = mod.formatPlan(target.slug, state, new Date(), { footer: false });
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
