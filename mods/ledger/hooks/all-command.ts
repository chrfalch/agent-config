import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { childOrder, formatTime, groupByParent, isParentOf, summarize, taskName, type Grouped } from './ledger'
import { message, sessionFolder } from './lookup'
import { type Entry, parseEntries, scriptPath } from './registry'

const USAGE = 'Usage: /ledger:all [--scan]'
const EMPTY = 'No ledgers registered. Run /ledger:all --scan to rebuild from disk.'
const NEXT_WIDTH = 80

const cell = (text: string): string => text.replaceAll('|', '\\|')

const truncate = (text: string): string => (text.length > NEXT_WIDTH ? `${text.slice(0, NEXT_WIDTH - 1)}…` : text)

export async function statusAndNext($: EngineInterface, entry: Entry): Promise<[string, string]> {
  try {
    const { next, parked } = summarize(await $.fs.read(entry.archivePath ?? entry.path), '', 0)
    return [parked && entry.status === 'active' ? 'parked' : entry.status, next]
  } catch {
    return [entry.status, '(unreadable)']
  }
}

// A table cell drops leading spaces, but keeps no-break spaces.
const INDENT = '  '

type Task = { entry: Entry; status: string }

const fileOf = ({ entry }: Task): string => entry.archivePath ?? entry.path

// A slug can be given again; the newest task of that slug is the parent.
function familyOrder<T extends Task>(newestFirst: T[]): (T & { name: string })[] {
  const parentFile = ({ entry }: T): string | undefined => {
    const parent = newestFirst.find(task => isParentOf(task.entry, entry))
    return parent && fileOf(parent)
  }
  const groups = groupByParent(
    newestFirst,
    fileOf,
    parentFile,
    childOrder(({ status }) => status === 'active', ({ entry }) => Date.parse(entry.updated)),
  )
  const descendants = (children: Grouped<T>[], depth: number): (T & { name: string })[] =>
    children.flatMap(({ item, children: grandchildren }) => [
      { ...item, name: `${INDENT.repeat(depth)}↳ ${item.entry.slug}` },
      ...descendants(grandchildren, depth + 1),
    ])
  return groups.flatMap(({ item, children }) => [
    {
      ...item,
      name: item.entry.parent ? `${item.entry.slug} (parent: ${taskName({ slug: item.entry.parent, main: item.entry.parentMain })})` : item.entry.slug,
    },
    ...descendants(children, 0),
  ])
}

async function goalOf($: EngineInterface, entry: Entry): Promise<string> {
  try {
    return summarize(await $.fs.read(entry.path), '', 0).goal
  } catch {
    return '(unreadable)'
  }
}

const newestFirst = (entries: Entry[]): Entry[] => [...entries].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))

const table = (header: string[], rows: string[][]): string[] =>
  [header, header.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`)

/** A task as /ledger:all lists it. `name` is its slug, indented under its parent, or followed by the parent it names. */
type TaskRow = { entry: Entry; name: string; status: string; next: string }
type BacklogRow = { entry: Entry; name: string; goal: string }
/** Every registered task once: `tasks` and `backlog` each list parents before their children, and otherwise newest first. */
export type Overview = { tasks: TaskRow[]; backlog: BacklogRow[] }

/** The registry as `cc-ledgers list` prints it, or as `cc-ledgers scan` rebuilds it from disk; `rebuilt` is the line scan reports that with. */
export async function readRegistry($: EngineInterface, scan: boolean): Promise<{ entries: Entry[]; rebuilt?: string } | { error: string }> {
  const script = scriptPath($, 'cc-ledgers')
  let result: ProcessRunResult
  try {
    result = await $.process.run([script, scan ? 'scan' : 'list', '--json'], { cwd: (await sessionFolder($)).path })
  } catch (error) {
    return { error: `cc-ledgers did not run: ${message(error)}` }
  }
  if (result.exitCode !== 0) return { error: `cc-ledgers failed (exit ${result.exitCode}): ${result.stderr.trim().replace(/\s*\n\s*/g, ' ')}` }
  const entries = parseEntries(result.stdout)
  if (entries === null) return { error: 'cc-ledgers printed something that is not a list of ledgers.' }
  const rebuilt = scan ? result.stderr.split('\n').find(line => line.startsWith('rebuilt ')) : undefined
  return rebuilt === undefined ? { entries } : { entries, rebuilt }
}

export async function overview($: EngineInterface, entries: Entry[]): Promise<Overview> {
  const backlog = newestFirst(entries.filter(entry => entry.status === 'backlog')).map(entry => ({ entry, status: entry.status }))
  const [tasks, backlogRows] = await Promise.all([
    Promise.all(
      newestFirst(entries.filter(entry => entry.status !== 'backlog')).map(async entry => {
        const [status, next] = await statusAndNext($, entry)
        return { entry, status, next }
      }),
    ),
    Promise.all(familyOrder(backlog).map(async ({ entry, name }) => ({ entry, name, goal: await goalOf($, entry) }))),
  ])
  return { tasks: familyOrder(tasks), backlog: backlogRows }
}

export function formatOverview({ tasks, backlog }: Overview): string {
  const total = tasks.length + backlog.length
  const taskRows = tasks.map(({ entry, name, status, next }) => [entry.repo, name, status, formatTime(Date.parse(entry.updated)), truncate(next)].map(cell))
  const backlogRows = backlog.map(({ entry, name, goal }) => [entry.repo, name, formatTime(Date.parse(entry.updated)), truncate(goal)].map(cell))
  const active = tasks.filter(({ status }) => status === 'active').length
  const counts = [`${total} ${total === 1 ? 'task' : 'tasks'}`, `${active} active`]
  if (backlog.length > 0) counts.push(`${backlog.length} backlog`)
  // Claude Code puts "ledger: " in front of the first output line; a table on that line does not render.
  const sections = [[`**All task ledgers** · ${counts.join(', ')}`]]
  if (taskRows.length > 0) sections.push(table(['repo', 'slug', 'status', 'updated', 'next'], taskRows))
  if (backlogRows.length > 0) sections.push(['**Backlog**'], table(['repo', 'slug', 'updated', 'goal'], backlogRows))
  return sections.map(lines => lines.join('\n')).join('\n\n')
}

export async function allCommand($: EngineInterface, args: string): Promise<string> {
  const words = args.split(/\s+/).filter(word => word !== '')
  const unknown = words.find(word => word !== '--scan')
  if (unknown !== undefined) return `Unknown argument: ${unknown}. ${USAGE}`

  const registry = await readRegistry($, words.includes('--scan'))
  if ('error' in registry) return registry.error
  const body = registry.entries.length === 0 ? EMPTY : formatOverview(await overview($, registry.entries))
  return registry.rebuilt === undefined ? body : `${registry.rebuilt}\n\n${body}`
}
