import { spinner } from '@clack/prompts';
import { Command, CommanderError } from 'commander';
import { nodeEngine, type Engine } from '../lib/node-engine.js';
import { colors, showSpinner } from './colors.js';
import { loadMod } from './hooks.js';
import { archiveView, overviewView, parentView, worktreesView } from './views.js';

/** Text for stdout, or an error for stderr that makes the command exit 1. */
type Output = { text: string } | { error: string };

async function withSpinner<T>(message: string, work: () => Promise<T>): Promise<T> {
  if (!showSpinner(process.env, process.stdout.isTTY)) return work();
  const progress = spinner({ withGuide: false });
  progress.start(message);
  try {
    return await work();
  } finally {
    progress.clear();
  }
}

async function all($: Engine, scan: boolean): Promise<Output> {
  const mod = await loadMod();
  const registry = await mod.readRegistry($, scan);
  if ('error' in registry) return registry;
  if (registry.entries.length === 0) return { text: `No ledgers registered. Run ${colors.bold('ledger all --scan')} to rebuild from disk.` };
  const view = overviewView(await mod.overview($, registry.entries));
  return { text: registry.rebuilt === undefined ? view : `${colors.dim(registry.rebuilt)}\n\n${view}` };
}

async function archive($: Engine, term: string, everyRepo: boolean): Promise<Output> {
  const mod = await loadMod();
  const found = await mod.readArchive($, { term, all: everyRepo });
  if ('error' in found) return found;
  if (found.ledgers.length === 0) return { text: mod.emptyArchiveMessage(found.repo, term) };
  return { text: archiveView(found, term, mod.countLabel(found.ledgers.length, term)) };
}

async function parent($: Engine, slug: string | undefined): Promise<Output> {
  const shown = await (await loadMod()).familyToShow($, slug);
  if ('none' in shown) return { error: 'Found no parent task for this folder. Name one: ledger parent <slug>' };
  return 'error' in shown ? shown : { text: parentView(shown) };
}

async function worktrees($: Engine, cwd: string): Promise<Output> {
  const mod = await loadMod();
  const { worktrees: linked, error } = await mod.linkedWorktrees($, cwd);
  if (error !== undefined) return { error };
  const { rows, prError } = await mod.worktreeRows($, linked, cwd);
  return { text: worktreesView(rows, prError) };
}

/** Runs the `ledger` command line `argv`, without the node and script paths, and returns its exit code. */
export async function main(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const $ = nodeEngine(cwd);
  let exitCode = 0;
  const print = (output: Output): void => {
    if ('error' in output) {
      console.error(output.error);
      exitCode = 1;
    } else console.log(output.text);
  };

  const program = new Command('ledger').description('Show the task ledgers on this machine.').exitOverride();
  program
    .command('all')
    .description('List every registered task and the backlog.')
    .option('--scan', 'rebuild the registry from the ledgers on disk first')
    .action(async ({ scan }: { scan?: boolean }) => print(await withSpinner('Reading the task ledgers', () => all($, scan === true))));
  program
    .command('archive')
    .description("List this repo's archived ledgers, newest first.")
    .argument('[term]', 'keep only the ledgers that contain this text, in any case')
    .option('--all', 'list the archive of every repo')
    .action(async (term: string | undefined, options: { all?: boolean }) => print(await archive($, term ?? '', options.all === true)));
  program
    .command('parent')
    .description('Show a parent task and its child tasks.')
    .argument('[slug]', 'the parent task; without it, the family of the task in this folder')
    .action(async (slug: string | undefined) => print(await parent($, slug)));
  program
    .command('worktrees')
    .description("List this repo's linked worktrees, largest first.")
    .action(async () => print(await withSpinner('Looking at the worktrees', () => worktrees($, cwd))));

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return exitCode;
}
