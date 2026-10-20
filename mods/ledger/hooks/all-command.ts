import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { formatTime, summarize } from './ledger'
import { message } from './lookup'

type Entry = { repo: string; slug: string; status: string; updated: string; path: string; archivePath?: string }

const USAGE = 'Usage: /ledger:all [--scan]'
const EMPTY = 'No ledgers registered. Run /ledger:all --scan to rebuild from disk.'
const NEXT_WIDTH = 80

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false
  const fields: Record<string, unknown> = { ...value }
  const strings = ['repo', 'slug', 'status', 'updated', 'path'].every(key => typeof fields[key] === 'string')
  return strings && (fields.archivePath === undefined || typeof fields.archivePath === 'string')
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

async function nextStep($: EngineInterface, file: string): Promise<string> {
  try {
    return summarize(await $.fs.read(file), '', 0).next
  } catch {
    return '(unreadable)'
  }
}

async function table($: EngineInterface, entries: Entry[]): Promise<string> {
  const newestFirst = [...entries].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
  const steps = await Promise.all(newestFirst.map(entry => nextStep($, entry.archivePath ?? entry.path)))
  const rows = newestFirst.map(({ repo, slug, status, updated }, index) =>
    [repo, slug, status, formatTime(Date.parse(updated)), truncate(steps[index] ?? '')].map(cell),
  )
  return [['repo', 'slug', 'status', 'updated', 'next'], ['---', '---', '---', '---', '---'], ...rows]
    .map(row => `| ${row.join(' | ')} |`)
    .join('\n')
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
