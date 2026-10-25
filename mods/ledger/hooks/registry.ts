import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { message, run, sessionFolder } from './lookup'
import { basename } from './worktrees'

/** One entry of ~/.claude/ledgers.json, as `cc-ledgers list --json` prints it. `parent` is the slug of its parent task. `main` is the main checkout of a backlog task. */
export type Entry = { repo: string; slug: string; status: string; updated: string; path: string; archivePath?: string; parent?: string; main?: string }

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false
  const fields: Record<string, unknown> = { ...value }
  const strings = ['repo', 'slug', 'status', 'updated', 'path'].every(key => typeof fields[key] === 'string')
  return strings && ['archivePath', 'parent', 'main'].every(key => optionalString(fields[key]))
}

export function parseEntries(stdout: string): Entry[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) && parsed.every(isEntry) ? parsed : null
  } catch {
    return null
  }
}

export function scriptPath($: EngineInterface, name: string): string {
  return `${$.plugin.root}/../../bin/${name}`
}

/** Where cc-task-new keeps the backlog ledger of `slug` for the repository at `main`; null when HOME is not set. */
export async function backlogLedgerPath($: EngineInterface, main: string, slug: string): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home?.startsWith('/') ? `${home}/.claude/ledger-backlog/${basename(main)}/${slug}.md` : null
}

/** The tasks named `slug` that the registry lists, with any status, in any repository. */
export async function registeredTasks($: EngineInterface, slug: string): Promise<Entry[] | { error: string }> {
  let result: ProcessRunResult
  try {
    result = await $.process.run([scriptPath($, 'cc-ledgers'), 'list', '--json'], { cwd: (await sessionFolder($)).path })
  } catch (error) {
    return { error: `cc-ledgers did not run: ${message(error)}` }
  }
  if (result.exitCode !== 0) return { error: `cc-ledgers failed (exit ${result.exitCode}): ${result.stderr.trim()}` }
  const entries = parseEntries(result.stdout)
  if (entries === null) return { error: 'cc-ledgers printed something that is not a list of ledgers.' }
  return entries.filter(entry => entry.slug === slug)
}

/** The main checkout of the repository `cwd` is in, worked out the way cc-task-new does; null when git cannot tell. */
export async function mainCheckout($: EngineInterface, cwd: string): Promise<string | null> {
  const { stdout, failure } = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  const common = stdout.trim()
  return failure === undefined && common.startsWith('/') ? common.slice(0, common.lastIndexOf('/')) || '/' : null
}

/**
 * The task among `tasks` that belongs to another main checkout, when none can be promoted from `main`.
 * Null when one of them is this repository's or names no main checkout, or when `main` is unknown: cc-task-new then decides.
 */
export function otherRepositoryTask(tasks: Entry[], main: string | null): (Entry & { main: string }) | null {
  if (main === null) return null
  const elsewhere = tasks.filter((task): task is Entry & { main: string } => task.main !== undefined && task.main !== main)
  return elsewhere.length === tasks.length ? (elsewhere[0] ?? null) : null
}

/**
 * Gives the backlog task `slug` its branch and worktree, and moves its ledger there. Runs in `cwd`, because cc-task-new
 * promotes only a task of the repository it runs in. Returns the ledger's new path, or the script's reason for refusing.
 * `isMissing` means the script found no backlog ledger named `slug`.
 */
export async function promoteBacklogTask(
  $: EngineInterface,
  slug: string,
  cwd: string,
): Promise<{ ledger: string } | { error: string; isMissing: boolean }> {
  const { stdout, stderr, failure, exitCode } = await run($, [scriptPath($, 'cc-task-new'), '--promote', slug], cwd)
  if (failure !== undefined) return { error: stderr.trim().replace(/\s*\n\s*/g, ' ') || `cc-task-new ${failure}`, isMissing: exitCode === 2 }
  const ledger = stdout.match(/^ledger\s+(\S.*)$/m)?.[1]?.trim()
  return ledger ? { ledger } : { error: `cc-task-new printed no ledger path: ${stdout.trim()}`, isMissing: false }
}
