export type Row = { number: string; step: string; status: string }

export type LedgerSummary = {
  slug: string
  editedMs: number
  goal: string
  current: Row | 'all done' | null
  next: string
}

const FINISHED = /^(done|accepted|reviewed|dropped|skipped)\b/i

function section(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith(`## ${heading}`))
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.startsWith('## '))
  return end === -1 ? rest : rest.slice(0, end)
}

function firstLine(lines: string[]): string {
  return lines.map(line => line.trim()).find(line => line !== '') ?? ''
}

function currentStep(planLines: string[]): Row | 'all done' | null {
  const rows: Row[] = planLines
    .filter(line => line.trim().startsWith('|'))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .map(([number = '', step = '', status = '']) => ({ number, step, status }))
    .filter(row => /^\d+$/.test(row.number))
  if (rows.length === 0) return null
  return rows.find(row => !FINISHED.test(row.status)) ?? 'all done'
}

export function summarize(text: string, fallbackSlug: string, editedMs: number): LedgerSummary {
  const title = text.match(/^# Task ledger[ \t]*[—-][ \t]*(.*)$/m)
  return {
    slug: title?.[1]?.trim() || fallbackSlug,
    editedMs,
    goal: firstLine(section(text, 'Goal')),
    current: currentStep(section(text, 'Plan')),
    next: firstLine(section(text, 'Next step')),
  }
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function formatStep(current: LedgerSummary['current']): string {
  if (current === null) return ''
  if (current === 'all done') return '- **Now:** all plan steps done'
  return `- **Now:** step ${current.number} · ${current.step} — *${current.status}*`
}

export function format(ledger: LedgerSummary): string {
  return [
    `#### ${ledger.slug} · edited ${formatTime(ledger.editedMs)}`,
    ledger.goal && `- **Goal:** ${ledger.goal}`,
    formatStep(ledger.current),
    ledger.next && `- **Next:** ${ledger.next}`,
  ]
    .filter(line => line !== '')
    .join('\n')
}

export function formatAll(ledgers: LedgerSummary[]): string {
  const count = ledgers.length === 1 ? '1 ledger' : `${ledgers.length} ledgers, newest first`
  return [`**Task ledgers** · ${count}`, ...ledgers.map(format)].join('\n\n')
}

export function ledgerPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

export function folderSlug(ledgerPath: string): string {
  return ledgerPath.split('/').at(-3) ?? ''
}

export type ActiveLedger = { kind: 'none' } | { kind: 'one'; path: string } | { kind: 'several'; paths: string[] }

const LEDGER_SUFFIX = '/.claude/ledger.md'

export function activeLedger(paths: string[], cwd: string): ActiveLedger {
  const matches = paths.filter(path => {
    const root = path.slice(0, -LEDGER_SUFFIX.length)
    return path.endsWith(LEDGER_SUFFIX) && (cwd === root || cwd.startsWith(`${root}/`))
  })
  const [only] = matches
  if (only === undefined) return { kind: 'none' }
  return matches.length === 1 ? { kind: 'one', path: only } : { kind: 'several', paths: matches }
}

const UNCHANGED = 'Nothing was written, and the session was not cleared.'

export function noLedgerMessage(cwd: string): string {
  return `No task ledger found for ${cwd}. ${UNCHANGED} Run this command from the task's worktree, or start a task with /ledger:task.`
}

export function severalLedgersMessage(cwd: string, slugs: string[]): string {
  return `Several task ledgers hold ${cwd}: ${slugs.join(', ')}. ${UNCHANGED} Run this command from a task worktree that is not inside another one.`
}

export function lookupFailedMessage(error: string): string {
  return `Could not check this task's ledger. ${error} ${UNCHANGED}`
}
