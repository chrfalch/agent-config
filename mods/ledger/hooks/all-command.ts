import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { formatTime, groupByParent, summarize } from './ledger'
import { message } from './lookup'
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

function familyOrder(newestFirst: Entry[]): { entry: Entry; name: string }[] {
  const groups = groupByParent(
    newestFirst,
    entry => taskKey(entry.repo, entry.slug),
    entry => (entry.parent === undefined ? undefined : taskKey(entry.repo, entry.parent)),
  )
  return groups.flatMap(({ item, children }) => [
    { entry: item, name: item.parent ? `${item.slug} (parent: ${item.parent})` : item.slug },
    ...children.map(child => ({ entry: child, name: `↳ ${child.slug}` })),
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
  const backlog = newestFirst(entries.filter(entry => entry.status === 'backlog'))
  const tasks = newestFirst(entries.filter(entry => entry.status !== 'backlog'))
  const [taskRows, backlogRows] = await Promise.all([
    Promise.all(
      familyOrder(tasks).map(async ({ entry, name }) => {
        const [status, next] = await statusAndNext($, entry)
        return [entry.repo, name, status, formatTime(Date.parse(entry.updated)), truncate(next)].map(cell)
      }),
    ),
    Promise.all(
      backlog.map(async entry => [entry.repo, entry.slug, formatTime(Date.parse(entry.updated)), truncate(await goalOf($, entry))].map(cell)),
    ),
  ])
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
    result = await $.process.run([script, scan ? 'scan' : 'list', '--json'])
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
