import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { formatTime, groupByParent, summarize } from './ledger'
import { message } from './lookup'

type Entry = { repo: string; slug: string; status: string; updated: string; path: string; archivePath?: string; parent?: string }

const USAGE = 'Usage: /ledger:all [--scan]'
const EMPTY = 'No ledgers registered. Run /ledger:all --scan to rebuild from disk.'
const NEXT_WIDTH = 80

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false
  const fields: Record<string, unknown> = { ...value }
  const strings = ['repo', 'slug', 'status', 'updated', 'path'].every(key => typeof fields[key] === 'string')
  const optional = ['archivePath', 'parent'].every(key => fields[key] === undefined || typeof fields[key] === 'string')
  return strings && optional
}

function parseEntries(stdout: string): Entry[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return Array.isArray(parsed) && parsed.every(isEntry) ? parsed : null
  } catch {
    return null
  }
}

const cell = (text: string): string => text.replaceAll('|', '\\|')

const truncate = (text: string): string => (text.length > NEXT_WIDTH ? `${text.slice(0, NEXT_WIDTH - 1)}…` : text)

async function statusAndNext($: EngineInterface, entry: Entry): Promise<[string, string]> {
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

async function table($: EngineInterface, entries: Entry[]): Promise<string> {
  const newestFirst = [...entries].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
  const rows = await Promise.all(
    familyOrder(newestFirst).map(async ({ entry, name }) => {
      const [status, next] = await statusAndNext($, entry)
      return [entry.repo, name, status, formatTime(Date.parse(entry.updated)), truncate(next)].map(cell)
    }),
  )
  const active = rows.filter(row => row[2] === 'active').length
  // Claude Code puts "ledger: " in front of the first output line; a table on that line does not render.
  const title = `**All task ledgers** · ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}, ${active} active`
  const lines = [['repo', 'slug', 'status', 'updated', 'next'], ['---', '---', '---', '---', '---'], ...rows].map(
    row => `| ${row.join(' | ')} |`,
  )
  return [title, '', ...lines].join('\n')
}

export async function allCommand($: EngineInterface, args: string): Promise<string> {
  const words = args.split(/\s+/).filter(word => word !== '')
  const unknown = words.find(word => word !== '--scan')
  if (unknown !== undefined) return `Unknown argument: ${unknown}. ${USAGE}`
  const scan = words.includes('--scan')

  const script = `${$.plugin.root}/../../bin/cc-ledgers`
  let result: ProcessRunResult
  try {
    result = await $.process.run([script, scan ? 'scan' : 'list', '--json'])
  } catch (error) {
    return `cc-ledgers did not run: ${message(error)}`
  }
  if (result.exitCode !== 0) return `cc-ledgers failed (exit ${result.exitCode}): ${result.stderr.trim().replace(/\s*\n\s*/g, ' ')}`
  const entries = parseEntries(result.stdout)
  if (entries === null) return 'cc-ledgers printed something that is not a list of ledgers.'

  const body = entries.length === 0 ? EMPTY : await table($, entries)
  const rebuilt = scan ? result.stderr.split('\n').find(line => line.startsWith('rebuilt ')) : undefined
  return rebuilt === undefined ? body : `${rebuilt}\n\n${body}`
}
