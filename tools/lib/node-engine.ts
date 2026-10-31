import { spawn } from 'node:child_process';
import { access, lstat, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('../../mods/ledger', import.meta.url));

export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean };
export type FileStat = { kind: 'file' | 'directory' | 'other'; size: number; mtimeMs: number; isLink: boolean };
export type FolderEntry = { name: string; kind: 'file' | 'dir' | 'other' };

/** The part of Claude Code's `$` that the ledger mod's commands use, backed by Node. */
export type Engine = {
  process: { run(argv: string[], init?: { cwd?: string }): Promise<RunResult> };
  fs: {
    read(file: string): Promise<string>;
    write(file: string, text: string): Promise<void>;
    stat(file: string): Promise<FileStat>;
    exists(file: string): Promise<boolean>;
    list(folder: string): Promise<FolderEntry[]>;
  };
  env: { get(name: string): Promise<string | undefined> };
  session: { cwd(): Promise<string> };
  plugin: { root: string };
};

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

async function list(folder: string): Promise<FolderEntry[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  return entries.map(entry => ({ name: entry.name, kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other' }));
}

/** A `$` whose session runs in `cwd`. */
export const nodeEngine = (cwd: string): Engine => ({
  process: { run: runProcess },
  fs: {
    read: file => readFile(file, 'utf8'),
    write: (file, text) => writeFile(file, text),
    stat: statOf,
    exists: file => access(file).then(() => true, () => false),
    list,
  },
  env: { get: async name => process.env[name] },
  session: { cwd: async () => cwd },
  plugin: { root: PLUGIN_ROOT },
});

/**
 * Imports `modules` of the ledger mod at run time, because they import their types from 'claude-code', which only
 * Claude Code provides, so `tsc` cannot follow them. `T` holds the signatures of the functions named in `exported`.
 */
export async function loadHooks<T>(modules: string[], exported: readonly (keyof T & string)[]): Promise<T> {
  const parts: Record<string, unknown>[] = await Promise.all(modules.map(name => import(pathToFileURL(path.join(PLUGIN_ROOT, 'hooks', `${name}.ts`)).href)));
  const mod: Record<string, unknown> = Object.assign({}, ...parts);
  const missing = exported.filter(name => typeof mod[name] !== 'function');
  if (missing.length > 0) throw new Error(`the ledger mod no longer exports ${missing.join(', ')}`);
  return mod as T;
}
