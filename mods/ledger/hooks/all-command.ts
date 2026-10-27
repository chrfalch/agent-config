import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { childOrder, formatTime, groupByParent, summarize, taskName, type Grouped } from './ledger'
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

const taskKey = (repo: string, slug: string): string => `${repo}\0${slug}`

// A table cell drops leading spaces, but keeps no-break spaces.
const INDENT = '  '

type Task = { entry: Entry; status: string }

function familyOrder<T extends Task>(newestFirst: T[]): (T & { name: string })[] {
  const groups = groupByParent(
    newestFirst,
    ({ entry }) => taskKey(entry.repo, entry.slug),
    ({ entry }) => (entry.parent === undefined || entry.parentMain !== undefined ? undefined : taskKey(entry.repo, entry.parent)),
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

async function tables($: EngineInterface, entries: Entry[]): Promise<string> {
  const backlog = newestFirst(entries.filter(entry => entry.status === 'backlog')).map(entry => ({ entry, status: entry.status }))
  const [tasks, backlogRows] = await Promise.all([
    Promise.all(
      newestFirst(entries.filter(entry => entry.status !== 'backlog')).map(async entry => {
        const [status, next] = await statusAndNext($, entry)
        return { entry, status, next }
      }),
    ),
    Promise.all(
      familyOrder(backlog).map(async ({ entry, name }) =>
        [entry.repo, name, formatTime(Date.parse(entry.updated)), truncate(await goalOf($, entry))].map(cell),
      ),
    ),
  ])
  const taskRows = familyOrder(tasks).map(({ entry, name, status, next }) =>
    [entry.repo, name, status, formatTime(Date.parse(entry.updated)), truncate(next)].map(cell),
  )
  const active = taskRows.filter(row => row[2] === 'active').length
  const counts = [`${entries.length} ${entries.length === 1 ? 'task' : 'tasks'}`, `${active} active`]
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
  const scan = words.includes('--scan')

  const script = scriptPath($, 'cc-ledgers')
  let result: ProcessRunResult
  try {
    result = await $.process.run([script, scan ? 'scan' : 'list', '--json'], { cwd: (await sessionFolder($)).path })
  } catch (error) {
    return `cc-ledgers did not run: ${message(error)}`
  }
  if (result.exitCode !== 0) return `cc-ledgers failed (exit ${result.exitCode}): ${result.stderr.trim().replace(/\s*\n\s*/g, ' ')}`
  const entries = parseEntries(result.stdout)
  if (entries === null) return 'cc-ledgers printed something that is not a list of ledgers.'

  const body = entries.length === 0 ? EMPTY : await tables($, entries)
  const rebuilt = scan ? result.stderr.split('\n').find(line => line.startsWith('rebuilt ')) : undefined
  return rebuilt === undefined ? body : `${rebuilt}\n\n${body}`
}
