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

export function severalLedgersMessage(cwd: string, slugs: string[], outcome = UNCHANGED): string {
  return `Several task ledgers hold ${cwd}: ${slugs.join(', ')}. ${outcome} Run this command from a task worktree that is not inside another one.`
}

export function lookupFailedMessage(error: string): string {
  return `Could not check this task's ledger. ${error} ${UNCHANGED}`
}

// One field per line, because a slug and a path can both hold spaces. go.md reads this format.
export function goArgs(target: string, ledgerPath: string | undefined): string {
  return `task: ${target}\nledger: ${ledgerPath ?? 'none'}`
}

export const GO_USAGE = 'Usage: /ledger:go <slug>. Run /ledger to see the slug of each task.'

export function unknownTaskMessage(target: string, slugs: string[], outcome = UNCHANGED): string {
  return `No task ledger is named "${target}". ${outcome} Task ledgers: ${slugs.join(', ') || 'none'}.`
}

export function sharedSlugMessage(target: string, paths: string[], outcome = UNCHANGED): string {
  return `Several task ledgers are named "${target}": ${paths.join(', ')}. ${outcome} Give each task its own slug in its ledger's title.`
}

export const HELP = [
  "- `/ledger` — Show each task ledger's goal, current step and next step. `/ledger <name>` shows one.",
  '- `/ledger:task` — Start a separate task with its own git worktree, branch and ledger.',
  "- `/ledger:update` — Write the latest results to this task's ledger, or start a task when there is none.",
  "- `/ledger:next` — Write this task's ledger, clear the session, and continue from the next step.",
  "- `/ledger:close` — Write this task's ledger, then clear the session.",
  "- `/ledger:go <slug>` — Write this task's ledger, clear the session, and continue in the task named <slug>.",
  "- `/ledger:worktrees` — Show each linked git worktree's size, last commit, dirty files, ledger and PR.",
  '- `/ledger:retire [<slug>]` — Show what retiring a task would archive and remove; `--yes` archives its ledger and removes its worktree.',
  '- `/ledger:help` — Show this list.',
].join('\n')
