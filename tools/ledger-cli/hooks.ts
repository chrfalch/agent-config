import type { ChildStatus } from '../../mods/ledger/hooks/ledger.js';
import { loadHooks, type Engine } from '../lib/node-engine.js';

export type Entry = { repo: string; slug: string; status: string; updated: string; path: string; archivePath?: string; parent?: string; parentMain?: string; main?: string };
export type Overview = { tasks: { entry: Entry; name: string; status: string; next: string }[]; backlog: { entry: Entry; name: string; goal: string }[] };
export type ArchivedLedger = { repo: string; date: string; slug: string; branch: string; goal: string; mtimeMs: number; match?: string };
export type Archive = { repo: string | null; ledgers: ArchivedLedger[] };
export type Shown = { parent: string; goal: string; children: ChildStatus[] };
export type Worktree = { path: string; branch: string };
export type WorktreeRow = { name: string; sizeGb: number | null; lastCommit: string | null; dirty: number | null; hasLedger: boolean; ledgerRole?: string; pr: string };
type Failed = { error: string };

// The signatures of the mod's functions that loadHooks imports. archive.ts and worktrees.ts import './ledger' without
// an extension, which `tsc` refuses here, so their types are copied above too.
export type Mod = {
  readRegistry(engine: Engine, scan: boolean): Promise<{ entries: Entry[]; rebuilt?: string } | Failed>;
  overview(engine: Engine, entries: Entry[]): Promise<Overview>;
  readArchive(engine: Engine, query: { term: string; all: boolean }): Promise<Archive | Failed>;
  emptyArchiveMessage(repo: string | null, term: string): string;
  countLabel(count: number, term: string): string;
  familyToShow(engine: Engine, slug: string | undefined): Promise<Shown | { none: true } | Failed>;
  linkedWorktrees(engine: Engine, cwd: string): Promise<{ worktrees: Worktree[]; error?: string }>;
  worktreeRows(engine: Engine, worktrees: Worktree[], cwd: string): Promise<{ rows: WorktreeRow[]; prError?: string }>;
};

export const MOD_EXPORTS = [
  'readRegistry',
  'overview',
  'readArchive',
  'emptyArchiveMessage',
  'countLabel',
  'familyToShow',
  'linkedWorktrees',
  'worktreeRows',
] as const satisfies readonly (keyof Mod)[];

export const loadMod = (): Promise<Mod> => loadHooks<Mod>(['all-command', 'archive', 'archive-command', 'parent-command', 'worktrees-command'], MOD_EXPORTS);
