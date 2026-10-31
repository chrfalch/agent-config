import { formatTime, taskName } from '../../mods/ledger/hooks/ledger.js';
import { colors } from './colors.js';
import type { Archive, Overview, Shown, WorktreeRow } from './hooks.js';
import { table, truncate } from './table.js';

const TEXT_WIDTH = 80;

const STATUS_COLORS: Record<string, (text: string) => string> = {
  active: colors.green,
  parked: colors.yellow,
  backlog: colors.cyan,
  archived: colors.dim,
  retired: colors.dim,
  missing: colors.red,
};

const statusLabel = (status: string): string => (STATUS_COLORS[status] ?? String)(status);

const heading = (title: string, ...facts: string[]): string => [colors.bold(title), ...facts].join(colors.dim(' · '));

const header = (...names: string[]): string[] => names.map(name => colors.dim(name));

const updated = (iso: string): string => colors.dim(formatTime(Date.parse(iso)));

const unknown = (value: string | number | null | undefined): string => (value === null || value === undefined ? colors.yellow('?') : String(value));

/** Dims what /ledger:all adds to a slug: the arrow of a child, and the parent a task names. */
const slugCell = (name: string): string => name.replace(/↳ /, colors.dim('↳ ')).replace(/ \(parent: .*\)$/, colors.dim('$&'));

export function overviewView({ tasks, backlog }: Overview): string {
  const total = tasks.length + backlog.length;
  const active = tasks.filter(({ status }) => status === 'active').length;
  const counts = [`${total} ${total === 1 ? 'task' : 'tasks'}`, `${active} active`, ...(backlog.length > 0 ? [`${backlog.length} backlog`] : [])];
  const sections = [heading('All task ledgers', counts.join(', '))];
  if (tasks.length > 0) {
    const rows = tasks.map(({ entry, name, status, next }) => [entry.repo, slugCell(name), statusLabel(status), updated(entry.updated), truncate(next, TEXT_WIDTH)]);
    sections.push(table(header('repo', 'slug', 'status', 'updated', 'next'), rows).join('\n'));
  }
  if (backlog.length > 0) {
    const rows = backlog.map(({ entry, name, goal }) => [entry.repo, slugCell(name), updated(entry.updated), truncate(goal, TEXT_WIDTH)]);
    sections.push([colors.bold('Backlog'), ...table(header('repo', 'slug', 'updated', 'goal'), rows)].join('\n'));
  }
  return sections.join('\n\n');
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const highlight = (text: string, term: string): string => text.replace(new RegExp(escapeRegExp(term), 'gi'), found => colors.bold(colors.yellow(found)));

/** `count` describes the ledgers in the words of /ledger:archive. `repo` is null for every repo, which adds a repo column. */
export function archiveView({ repo, ledgers }: Archive, term: string, count: string): string {
  const everyRepo = repo === null;
  const rows = ledgers.map(ledger => [
    colors.dim(ledger.date),
    ...(everyRepo ? [ledger.repo] : []),
    ledger.slug,
    colors.dim(ledger.branch),
    truncate(ledger.goal, TEXT_WIDTH),
    ...(term ? [highlight(truncate(ledger.match ?? '', TEXT_WIDTH), term)] : []),
  ]);
  const columns = header('date', ...(everyRepo ? ['repo'] : []), 'slug', 'branch', 'goal', ...(term ? ['match'] : []));
  return [heading('Archived ledgers', repo ?? 'every repo', count), '', ...table(columns, rows)].join('\n');
}

export function parentView({ parent, goal, children }: Shown): string {
  if (children.length === 0) return `${parent} has no child tasks.`;
  const count = children.length === 1 ? '1 child' : `${children.length} children`;
  const active = children.filter(({ status }) => status === 'active').length;
  const rows = children.flatMap(child => [
    [taskName(child), statusLabel(child.status), truncate(child.next, TEXT_WIDTH)],
    ...(child.report ?? []).map(line => ['', '', colors.dim(line.trimEnd())]),
  ]);
  return [heading(`Parent task ${parent}`, `${count}, ${active} active`), ...(goal ? [goal] : []), '', ...table(header('task', 'status', 'next'), rows)].join('\n');
}

function prCell(pr: string): string {
  if (pr === '?') return colors.yellow(pr);
  if (pr === 'none') return colors.dim(pr);
  if (pr.startsWith('OPEN ')) return colors.green(pr);
  if (pr.startsWith('MERGED ')) return colors.magenta(pr);
  return colors.dim(pr);
}

const dirtyCell = (dirty: number | null): string => (dirty === null ? unknown(dirty) : dirty === 0 ? colors.dim('0') : colors.yellow(String(dirty)));

/** `prError` is why the PR column shows ? on a row. */
export function worktreesView(rows: WorktreeRow[], prError?: string): string {
  if (rows.length === 0) return 'No linked worktrees.';
  const sorted = [...rows].sort((a, b) => (b.sizeGb ?? -1) - (a.sizeGb ?? -1));
  const totalGb = rows.reduce((sum, row) => sum + (row.sizeGb ?? 0), 0);
  const count = rows.length === 1 ? '1 worktree' : `${rows.length} worktrees, largest first`;
  const lines = table(
    header('worktree', 'size GB', 'last commit', 'dirty', 'ledger', 'PR'),
    sorted.map(row => [
      row.name,
      unknown(row.sizeGb?.toFixed(1)),
      unknown(row.lastCommit),
      dirtyCell(row.dirty),
      row.hasLedger ? (row.ledgerRole ?? 'yes') : colors.dim('no'),
      prCell(row.pr),
    ]),
    ['left', 'right', 'left', 'right'],
  );
  return [heading('Worktrees', count, `${totalGb.toFixed(1)} GB total`), '', ...lines, ...(prError ? ['', colors.dim(`PR is ? because ${prError}`)] : [])].join('\n');
}
