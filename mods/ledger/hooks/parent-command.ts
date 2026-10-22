import type { EngineInterface } from 'claude-code'

import { folderSlug, summarize, type ChildStatus, type Family, type LedgerSummary } from './ledger'
import { findLedgers, message, run, sessionFolder, sessionLedger, type SessionFolder } from './lookup'

const USAGE =
  'Usage: /ledger:parent [<slug>] shows a parent task and its children; /ledger:parent <slug> add <child> and /ledger:parent <slug> remove <child> change them.'

type Shown = { parent: string; goal: string; children: ChildStatus[] }

function isChildStatus(value: unknown): value is ChildStatus {
  if (typeof value !== 'object' || value === null) return false
  const fields: Record<string, unknown> = { ...value }
  return ['slug', 'status', 'next'].every(key => typeof fields[key] === 'string')
}

function parseShown(stdout: string): Shown | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { parent, goal, children }: Record<string, unknown> = { ...parsed }
    if (typeof parent !== 'string' || typeof goal !== 'string' || !Array.isArray(children) || !children.every(isChildStatus)) return null
    return { parent, goal, children }
  } catch {
    return null
  }
}

const oneLine = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ')

/** Runs bin/cc-ledger-parent, which finds a slug in every worktree and in the backlog of the repository that holds `cwd`. */
async function script($: EngineInterface, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; error?: string }> {
  const ran = await run($, [`${$.plugin.root}/../../bin/cc-ledger-parent`, ...args], cwd)
  if (ran.failure === undefined) return ran
  return { ...ran, error: oneLine(ran.stderr) || `cc-ledger-parent ${ran.failure.trim().replace(/:$/, '')}` }
}

export async function showParent($: EngineInterface, parent: string, cwd: string): Promise<Shown | { error: string }> {
  const { stdout, error } = await script($, ['show', parent, '--json'], cwd)
  if (error !== undefined) return { error }
  return parseShown(stdout) ?? { error: 'cc-ledger-parent printed something that is not a parent and its children.' }
}

/** The slugs from `parent` down to the child task that /ledger:go <parent> starts; empty when no child is left to start. */
export async function childToStart($: EngineInterface, parent: string, cwd: string): Promise<string[] | { error: string }> {
  const { stdout, error } = await script($, ['next', parent], cwd)
  if (error !== undefined) return { error }
  const slugs = stdout.split(/\s+/).filter(slug => slug !== '')
  return slugs.length > 1 ? slugs : []
}

/** Marks `child` started in its parent's Children section. `marked` is the ledger changed, absent when the line already had a mark. */
export async function markStarted($: EngineInterface, parent: string, child: string, cwd: string): Promise<{ marked?: string } | { error: string }> {
  const { stdout, error } = await script($, ['start', parent, child], cwd)
  if (error !== undefined) return { error }
  const marked = stdout.match(/^started \S+ in (.+)$/m)?.[1]
  return marked ? { marked } : {}
}

/** What /ledger:go tells the next session about a task's parent or children. Best effort: a failed lookup must not stop the switch. */
export async function familyOf($: EngineInterface, task: LedgerSummary, cwd: string): Promise<Family> {
  if (task.parent) return { parent: task.parent }
  if (!task.children) return {}
  const shown = await showParent($, task.slug, cwd)
  return 'error' in shown ? {} : { children: shown.children }
}

function formatShown({ parent, goal, children }: Shown): string {
  if (children.length === 0) return `${parent} has no child tasks. Add one with \`/ledger:parent ${parent} add <child>\`.`
  const count = children.length === 1 ? '1 child' : `${children.length} children`
  const active = children.filter(({ status }) => status === 'active').length
  return [
    `**Parent task ${parent}** · ${count}, ${active} active`,
    ...(goal ? [goal] : []),
    '',
    ...children.map(({ slug, status, next }) => `- **${slug}** · ${status}${next ? ` — ${next}` : ''}`),
  ].join('\n')
}

async function ownFamily($: EngineInterface, folder: SessionFolder): Promise<{ parent: string | undefined } | { text: string }> {
  const found = await findLedgers($)
  if ('error' in found) return { text: `Could not list task ledgers. ${found.error}` }
  const active = sessionLedger(found, folder)
  if (active.kind !== 'one') return { parent: undefined }
  try {
    const { slug, parent, children } = summarize(await $.fs.read(active.path), folderSlug(active.path), 0)
    return { parent: children ? slug : parent }
  } catch (error) {
    return { text: `Could not read ${active.path}. ${message(error)}` }
  }
}

async function show($: EngineInterface, parent: string, cwd: string): Promise<string> {
  const shown = await showParent($, parent, cwd)
  return 'error' in shown ? `Could not show ${parent}. ${shown.error}` : formatShown(shown)
}

async function change($: EngineInterface, verb: 'add' | 'remove', parent: string, child: string, cwd: string): Promise<string> {
  const { stderr, error } = await script($, [verb, parent, child], cwd)
  if (error !== undefined) return verb === 'add' ? `Could not add ${child} to ${parent}. ${error}` : `Could not remove ${child} from ${parent}. ${error}`
  const done = verb === 'add' ? `${parent} is now the parent of ${child}.` : `${child} is no longer a child of ${parent}.`
  const warning = oneLine(stderr)
  return warning ? `${done} ${warning}` : done
}

export async function parentCommand($: EngineInterface, args: string): Promise<string> {
  const words = args.split(/\s+/).filter(word => word !== '')
  const folder = await sessionFolder($)
  const cwd = folder.path
  const [parent, verb, child] = words
  if (words.length === 1 && (parent === 'add' || parent === 'remove')) return USAGE
  if (parent === undefined) {
    const own = await ownFamily($, folder)
    if ('text' in own) return own.text
    return own.parent === undefined ? USAGE : show($, own.parent, cwd)
  }
  if (words.length === 1) return show($, parent, cwd)
  if (words.length === 3 && child !== undefined && (verb === 'add' || verb === 'remove')) return change($, verb, parent, child, cwd)
  return USAGE
}
